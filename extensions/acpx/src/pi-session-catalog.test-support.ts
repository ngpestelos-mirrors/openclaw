import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import { registerPiSessionCatalog } from "./pi-session-catalog-plugin.js";

type RegisteredSessionCatalogProvider = Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0];
type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
type CatalogOperation = "list" | "read" | "continueSession" | "archive" | "openTerminal";
export type TestSessionCatalogProvider = Omit<
  RegisteredSessionCatalogProvider,
  CatalogOperation
> & {
  [K in keyof Pick<RegisteredSessionCatalogProvider, CatalogOperation>]: (
    params: OptionalCatalogAgent<Parameters<NonNullable<RegisteredSessionCatalogProvider[K]>>[0]>,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider[K]>>;
};

export const piSessionHeader = (overrides: Record<string, unknown> = {}) => ({
  type: "session",
  version: 3,
  id: "pi-session",
  timestamp: "2026-07-13T10:00:00.000Z",
  cwd: "/workspace",
  ...overrides,
});
export const piMessage = (
  message: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  type: "message",
  timestamp: "2026-07-13T10:00:01.000Z",
  message,
  ...overrides,
});
export const piJsonl = (entries: unknown[]) =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

export function restorePiEnvironment(original: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function bindTestCatalogOwner(
  provider: RegisteredSessionCatalogProvider,
): TestSessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(provider.continueSession
      ? {
          continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
        }
      : {}),
    ...(provider.archive
      ? { archive: (params) => provider.archive!({ agentId: "main", ...params }) }
      : {}),
    ...(provider.openTerminal
      ? {
          openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
        }
      : {}),
  } as TestSessionCatalogProvider;
}

export async function createPiStoreFixture(
  temporaryDirectories: string[],
  assistantText = "hi",
  sessionName = "Pi catalog session",
  toolArguments: unknown = { command: "pwd" },
  acpResolvable = false,
): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-pi-catalog-"),
  );
  temporaryDirectories.push(root);
  const directory = acpResolvable ? path.join(root, "sessions", "project") : root;
  if (acpResolvable) {
    await fs.mkdir(directory, { recursive: true });
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
  }
  const entries = [
    piSessionHeader(),
    piMessage(
      { role: "user", content: "hello", timestamp: 1_783_938_001_000 },
      { id: "user-1", parentId: null },
    ),
    piMessage(
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude",
        timestamp: 1_783_938_002_000,
        content: [
          { type: "thinking", thinking: "thinking" },
          { type: "text", text: assistantText },
          { type: "toolCall", id: "call-1", name: "bash", arguments: toolArguments },
        ],
      },
      { id: "assistant-1", parentId: "user-1", timestamp: "2026-07-13T10:00:02.000Z" },
    ),
    piMessage(
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        timestamp: 1_783_938_003_000,
        content: [{ type: "text", text: "/workspace" }],
      },
      { id: "tool-1", parentId: "assistant-1", timestamp: "2026-07-13T10:00:03.000Z" },
    ),
    {
      type: "session_info",
      id: "info-1",
      parentId: "tool-1",
      timestamp: "2026-07-13T10:00:04.000Z",
      name: sessionName,
    },
  ];
  await fs.writeFile(path.join(directory, "session.jsonl"), piJsonl(entries));
  return directory;
}

export async function installFakePiFixture(
  temporaryDirectories: string[],
  originalPath: string | undefined,
): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-pi-cli-"),
  );
  temporaryDirectories.push(directory);
  const bareExecutable = path.join(directory, "pi");
  await fs.writeFile(bareExecutable, "#!/bin/sh\nexit 0\n");
  if (process.platform === "win32") {
    await fs.writeFile(path.join(directory, "pi.cmd"), "@echo off\r\nexit /b 0\r\n");
  } else {
    await fs.chmod(bareExecutable, 0o755);
  }
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  return directory;
}

export function registerPiNodeHostCommands(): Parameters<
  OpenClawPluginApi["registerNodeHostCommand"]
>[0][] {
  const commands: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0][] = [];
  registerPiSessionCatalog({
    pluginConfig: {},
    registerSessionCatalog: vi.fn(),
    registerNodeHostCommand: (
      command: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0],
    ) => commands.push(command),
    registerNodeInvokePolicy: vi.fn(),
  } as unknown as OpenClawPluginApi);
  return commands;
}

export function capturePiContinuationCatalog() {
  let provider: TestSessionCatalogProvider | undefined;
  const entries: Array<{ sessionKey: string; entry: Record<string, unknown> }> = [];
  const createSessionEntry = vi.fn(
    async (
      params: Parameters<OpenClawPluginApi["runtime"]["agent"]["session"]["createSessionEntry"]>[0],
    ) => {
      const sessionKey = `agent:${params.agentId ?? "main"}:${params.key}`;
      const entry = {
        sessionId: "adopted-pi-session",
        updatedAt: Date.now(),
        pluginOwnerId: "acpx",
        initializationPending: true as const,
        ...(params.label ? { label: params.label } : {}),
        ...(params.displayName ? { displayName: params.displayName } : {}),
        ...(params.spawnedCwd ? { spawnedCwd: params.spawnedCwd } : {}),
        pluginExtensions: params.initialEntry.pluginExtensions,
      };
      entries.push({ sessionKey, entry });
      const created = {
        key: sessionKey,
        agentId: params.agentId ?? "main",
        sessionId: entry.sessionId,
        entry,
      };
      try {
        const finalPatch = await params.afterCreate?.(created);
        entry.pluginExtensions = finalPatch?.pluginExtensions ?? entry.pluginExtensions;
        delete (entry as { initializationPending?: true }).initializationPending;
        return created;
      } catch (error) {
        entries.splice(
          entries.findIndex((candidate) => candidate.entry === entry),
          1,
        );
        throw error;
      }
    },
  );
  registerPiSessionCatalog({
    id: "acpx",
    pluginConfig: {},
    config: {},
    runtime: {
      config: { current: () => ({}) },
      nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
      agent: {
        session: {
          createSessionEntry,
          listSessionEntries: vi.fn(() => entries),
        },
      },
    },
    registerSessionCatalog: (value: RegisteredSessionCatalogProvider) => {
      provider = bindTestCatalogOwner(value);
    },
    registerNodeHostCommand: vi.fn(),
    registerNodeInvokePolicy: vi.fn(),
  } as unknown as OpenClawPluginApi);
  return { createSessionEntry, entries, provider: provider! };
}
