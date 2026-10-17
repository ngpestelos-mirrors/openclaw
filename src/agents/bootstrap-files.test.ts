/**
 * Tests agent bootstrap file discovery, filtering, injected context modes, and the
 * doctor-side diagnostics resolution with its bundled hook projection gate.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import {
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveBootstrapContextForDiagnostics } from "./bootstrap-files-diagnostics.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import { buildBootstrapContextFiles } from "./embedded-agent-helpers/bootstrap.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { mergeWorkspaceSetupState } from "./workspace-state-store.js";
import {
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  loadExtraBootstrapFilesWithDiagnostics,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const memoryRuntimeMocks = vi.hoisted(() => ({ classifyWorkspacePaths: vi.fn() }));

vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: (...args: unknown[]) =>
    memoryRuntimeMocks.classifyWorkspacePaths(...args),
}));

let testState: OpenClawTestState | undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function registerBootstrapEntries(
  makeFiles: (context: AgentBootstrapHookContext) => WorkspaceBootstrapFile[],
) {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [...context.bootstrapFiles, ...makeFiles(context)];
  });
}

function registerMalformedBootstrapFileHook() {
  registerBootstrapEntries((context) =>
    [
      { filePath: path.join(context.workspaceDir, "BROKEN.md") },
      { path: 123 },
      { path: "   " },
    ].map(
      (fields) =>
        Object.assign(
          { name: "EXTRA.md", content: "broken", missing: false },
          fields,
        ) as unknown as WorkspaceBootstrapFile,
    ),
  );
}

function hookFile(
  name: WorkspaceBootstrapFile["name"],
  filePath: string,
  content: string,
): WorkspaceBootstrapFile {
  return { name, path: filePath, content, missing: false };
}

function registerDuplicateBootstrapFileHook() {
  registerBootstrapEntries((context) => [
    hookFile("AGENTS.md", "AGENTS.md", "duplicate relative hook content"),
    hookFile(
      "AGENTS.md",
      path.join(context.workspaceDir, ".", "AGENTS.md"),
      "duplicate absolute hook content",
    ),
  ]);
}

function registerNamedBootstrapFileHook(
  relativePath = "MEMORY.md",
  name: WorkspaceBootstrapFile["name"] = "MEMORY.md",
) {
  registerBootstrapEntries((context) => [
    hookFile(name, path.join(context.workspaceDir, relativePath), "hook memory"),
  ]);
}

function registerLoadedBootstrapFilesHook(
  relativePaths: string[],
  name?: WorkspaceBootstrapFile["name"],
) {
  registerInternalHook("agent:bootstrap", async (event) => {
    const context = event.context as AgentBootstrapHookContext;
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      relativePaths,
    );
    if (name) {
      for (const file of files) {
        file.name = name;
      }
    }
    context.bootstrapFiles = [...context.bootstrapFiles, ...files];
  });
}

async function createDirectoryAlias(params: {
  workspaceDir: string;
  targetDir: string;
  aliasName: string;
}): Promise<string> {
  const aliasDir = path.join(params.workspaceDir, params.aliasName);
  await fs.symlink(params.targetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  return aliasDir;
}

function registerBootstrapFileHook(relativePath = "BOOTSTRAP.md") {
  registerBootstrapEntries((context) => [
    hookFile("BOOTSTRAP.md", path.join(context.workspaceDir, relativePath), "stale ritual"),
  ]);
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
}

async function memoryWorkspace(prefix: string, memory = "memory", user = "user") {
  const workspaceDir = await makeTempWorkspace(prefix);
  await writeFiles(workspaceDir, {
    [DEFAULT_MEMORY_FILENAME]: memory,
    [DEFAULT_USER_FILENAME]: user,
  });
  return workspaceDir;
}

async function writeCompletedWorkspaceState(workspaceDir: string): Promise<void> {
  await mergeWorkspaceSetupState(workspaceDir, {
    bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
    setupCompletedAt: "2026-05-16T00:00:01.000Z",
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(async () => {
    clearInternalHooks();
    resetLegacyWorkspaceStateCheckForTest();
    memoryRuntimeMocks.classifyWorkspacePaths
      .mockReset()
      .mockResolvedValue({ status: "unavailable" });
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-bootstrap-state-",
    });
  });

  it.each([
    ["untrusted root and trusted user", "untrusted", "owner", [DEFAULT_USER_FILENAME]],
    ["missing user classification", "agent", undefined, [DEFAULT_MEMORY_FILENAME]],
    ["unsupported provenance", undefined, undefined, []],
  ] as const)("filters %s", async (label, memoryOrigin, userOrigin, expected) => {
    const workspaceDir = await memoryWorkspace(
      "openclaw-bootstrap-provenance-",
      "tainted memory",
      "trusted user",
    );
    if (memoryOrigin === "untrusted") {
      registerNamedBootstrapFileHook();
    }
    const classifications = [
      ...(memoryOrigin
        ? [{ relativePath: DEFAULT_MEMORY_FILENAME, originClass: memoryOrigin }]
        : []),
      ...(userOrigin ? [{ relativePath: DEFAULT_USER_FILENAME, originClass: userOrigin }] : []),
    ];
    memoryRuntimeMocks.classifyWorkspacePaths.mockResolvedValue(
      label === "unsupported provenance"
        ? { status: "unsupported" }
        : { status: "classified", classifications },
    );
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {},
      agentId: "main",
      warn: (message) => warnings.push(message),
    });
    expect(
      files
        .map((file) => file.name)
        .filter((name) => name === DEFAULT_MEMORY_FILENAME || name === DEFAULT_USER_FILENAME),
    ).toEqual(expected);
    if (label === "unsupported provenance") {
      expect(warnings).toContain(
        "excluding automatic memory context: selected memory runtime does not support provenance classification",
      );
    }
  });
  afterEach(async () => {
    clearInternalHooks();
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "BOOTSTRAP.md",
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });

  it("dedupes hook-injected bootstrap paths relative to the workspace", async () => {
    registerDuplicateBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(agentsPath, "workspace rules", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const agentsFiles = files.filter((file) => file.path === agentsPath);

    expect(agentsFiles).toHaveLength(1);
    expect(agentsFiles[0]?.content).toBe("workspace rules");

    const context = await resolveBootstrapContextForRun({ workspaceDir });
    const agentsContextFiles = context.contextFiles.filter((file) => file.path === agentsPath);
    expect(agentsContextFiles).toHaveLength(1);
    expect(agentsContextFiles[0]?.content).toBe("workspace rules");
  });

  it("refreshes USER.md on every turn for long-lived sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const userPath = path.join(workspaceDir, "USER.md");
    const sessionKey = `agent:main:webchat:direct:${randomUUID()}`;
    await fs.writeFile(userPath, "Prefer concise answers.", "utf8");
    const first = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    await fs.writeFile(userPath, "Prefer detailed answers.", "utf8");
    const second = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    expect(first.find((file) => file.name === "USER.md")?.content).toBe("Prefer concise answers.");
    expect(second.find((file) => file.name === "USER.md")?.content).toBe(
      "Prefer detailed answers.",
    );
  });

  it("ignores stale root BOOTSTRAP.md for home-relative workspace paths", async () => {
    registerBootstrapFileHook();
    const parentDir = await makeTempWorkspace("openclaw-bootstrap-home-");
    const workspaceDir = path.join(parentDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeCompletedWorkspaceState(workspaceDir);
    await writeFiles(workspaceDir, { "AGENTS.md": "rules", "BOOTSTRAP.md": "stale ritual" });

    const files = await withEnvAsync({ OPENCLAW_HOME: parentDir }, async () =>
      resolveBootstrapFilesForRun({ workspaceDir: "~/workspace" }),
    );

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("keeps hook-added nested BOOTSTRAP.md after setup is completed", async () => {
    registerBootstrapFileHook(path.join("packages", "core", "BOOTSTRAP.md"));
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeCompletedWorkspaceState(workspaceDir);
    await writeFiles(workspaceDir, {
      "AGENTS.md": "rules",
      "BOOTSTRAP.md": "stale ritual",
      "packages/core/BOOTSTRAP.md": "package ritual",
    });

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toContain(
      path.join("packages", "core", "BOOTSTRAP.md"),
    );
    expect(files.map((file) => file.path)).not.toContain(path.join(workspaceDir, "BOOTSTRAP.md"));
  });

  it.each(["direct", "group", "channel"] as const)(
    "applies root-memory source privacy while keeping unrelated aliases for %s chats",
    async (chatType) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-shared-alias-");
      const nestedDir = path.join(workspaceDir, "packages", "core");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
        "private memory",
        "utf8",
      );
      await fs.writeFile(path.join(nestedDir, DEFAULT_MEMORY_FILENAME), "nested memory", "utf8");
      const rootAliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: workspaceDir,
        aliasName: "root-memory-alias",
      });
      const nestedAliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: nestedDir,
        aliasName: "nested-memory-alias",
      });
      const rootAliasPath = path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME);
      const nestedAliasPath = path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME);
      registerLoadedBootstrapFilesHook([
        path.relative(workspaceDir, rootAliasPath),
        path.relative(workspaceDir, nestedAliasPath),
      ]);

      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });

      if (chatType === "direct") {
        expect(files.map((file) => file.path)).toContain(rootAliasPath);
      } else {
        expect(files.map((file) => file.path)).not.toContain(rootAliasPath);
      }
      expect(files.map((file) => file.path)).toContain(nestedAliasPath);
    },
  );

  it.runIf(process.platform !== "win32").each([
    { mode: "direct", chatType: "direct", sessionKey: "agent:main:opaque:binding" },
    { mode: "group", chatType: "group", sessionKey: "agent:main:opaque:binding" },
    { mode: "channel", chatType: "channel", sessionKey: "agent:main:opaque:binding" },
    { mode: "subagent", chatType: "direct", sessionKey: "agent:main:subagent:worker" },
    { mode: "cron", chatType: "direct", sessionKey: "agent:main:cron:daily:run:run-1" },
  ] as const)(
    "filters remote root-memory sources and keeps equal-byte nested memory for $mode",
    async ({ mode, chatType, sessionKey }) => {
      const workspaceDir = tempDirs.make("openclaw-bootstrap-gateway-");
      const remoteDir = await fs.realpath(tempDirs.make("openclaw-bootstrap-harness-"));
      const nestedDir = path.join(remoteDir, "nested");
      await fs.mkdir(nestedDir);
      await fs.writeFile(path.join(workspaceDir, DEFAULT_MEMORY_FILENAME), "Gateway decoy");
      for (const root of [remoteDir, nestedDir]) {
        await fs.writeFile(path.join(root, DEFAULT_MEMORY_FILENAME), "same memory bytes");
      }
      await fs.symlink(remoteDir, path.join(remoteDir, "root-alias"), "dir");
      await fs.symlink(nestedDir, path.join(remoteDir, "nested-alias"), "dir");
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: { workspaceDir, agentWorkspaceDir: workspaceDir },
        }),
        runtime: {
          remoteWorkspaceDir: remoteDir,
          remoteAgentWorkspaceDir: remoteDir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const release = registerAgentWorkspaceAccess(workspaceDir, { bridge });
      try {
        registerLoadedBootstrapFilesHook(
          ["root-alias/MEMORY.md", "nested-alias/MEMORY.md"],
          mode === "subagent" ? "AGENTS.md" : mode === "cron" ? "SOUL.md" : undefined,
        );
        const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey, chatType });
        const paths = files.map((file) => file.path);
        const rootAliasPath = path.join(workspaceDir, "root-alias/MEMORY.md");
        if (mode === "direct") {
          expect(paths).toContain(rootAliasPath);
        } else {
          expect(paths).not.toContain(rootAliasPath);
        }
        expect(
          files.find((file) => file.path === path.join(workspaceDir, "nested-alias/MEMORY.md")),
        ).toMatchObject({ content: "same memory bytes", missing: false });
        expect(files.map((file) => file.name)).not.toContain(DEFAULT_USER_FILENAME);
        expect(files.some((file) => file.content === "Gateway decoy")).toBe(false);
      } finally {
        release();
      }
    },
  );

  it("does not let hooks relabel and re-add root MEMORY.md to shared sessions", async () => {
    registerNamedBootstrapFileHook("MEMORY.md", "SOUL.md");
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-hook-shared-alias-");
    const rootMemoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(rootMemoryPath, "private memory", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:c1",
    });

    expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
  });

  it("keeps missing hook records without source identity when policy allows them", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-missing-hook-record-");
    await fs.writeFile(path.join(workspaceDir, DEFAULT_MEMORY_FILENAME), "private memory", "utf8");
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "SOUL.md",
          path: path.join(context.workspaceDir, "generated", "SOUL.md"),
          missing: true,
        },
      ];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });

    expect(files).toContainEqual({
      name: "SOUL.md",
      path: path.join(workspaceDir, "generated", "SOUL.md"),
      missing: true,
    });
  });

  it.each([
    {
      mode: "subagent",
      sessionKey: "agent:main:subagent:worker",
      relabeledName: "AGENTS.md",
      expectedNames: ["AGENTS.md"],
    },
    {
      mode: "cron",
      sessionKey: "agent:main:cron:daily:run:run-1",
      relabeledName: "SOUL.md",
      expectedNames: ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"],
    },
  ] as const)(
    "rejects loader aliases to root memory relabeled under the $mode allowlist",
    async ({ sessionKey, relabeledName, expectedNames }) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-restricted-");
      const rootMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
      const aliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: workspaceDir,
        aliasName: "root-memory-alias",
      });
      registerLoadedBootstrapFilesHook(
        [path.relative(workspaceDir, path.join(aliasDir, DEFAULT_MEMORY_FILENAME))],
        relabeledName,
      );
      await Promise.all(
        [
          ["AGENTS.md", "project rules"],
          ["SOUL.md", "persona"],
          ["IDENTITY.md", "identity"],
          ["USER.md", "user profile"],
          ["MEMORY.md", "memory"],
          ["HEARTBEAT.md", "heartbeat"],
          ["BOOTSTRAP.md", "setup"],
        ].map(([fileName, content]) =>
          fs.writeFile(
            path.join(workspaceDir, expectDefined(fileName, "fileName test invariant")),
            expectDefined(content, "content test invariant"),
            "utf8",
          ),
        ),
      );

      const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

      expect(files.map((file) => file.name)).toStrictEqual(expectedNames);
      expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
    },
  );
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("keeps bootstrap context empty in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    // Heartbeat context comes from cron scratch via the heartbeat runner now.
    expect(files).toStrictEqual([]);
  });
});

describe("resolveBootstrapContextForDiagnostics", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  function createExtraFilesConfig(hooksEnabled?: boolean): OpenClawConfig {
    return {
      hooks: {
        internal: {
          enabled: hooksEnabled,
          entries: {
            "bootstrap-extra-files": { enabled: true, paths: ["packages/*/AGENTS.md"] },
          },
        },
      },
    };
  }

  async function makeWorkspaceWithExtraAgentsFile(): Promise<{
    workspaceDir: string;
    extraPath: string;
  }> {
    const workspaceDir = await fs.realpath(await makeTempWorkspace("openclaw-bootstrap-diag-"));
    const extraPath = path.join(workspaceDir, "packages", "core", "AGENTS.md");
    await writeFiles(workspaceDir, { "packages/core/AGENTS.md": "extra agents" });
    return { workspaceDir, extraPath };
  }

  it.each([
    ["bundled declarations", undefined, false, undefined, true],
    ["disabled hook system", false, false, undefined, false],
    ["managed import failure", undefined, true, 'throw new Error("must not import");', false],
    ["unreadable managed handler", undefined, true, undefined, true],
  ] as const)(
    "projects %s without executing hooks",
    async (_label, enabled, managed, handler, projects) => {
      const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();
      const registered = vi.fn(() => {
        throw new Error("diagnostics must not execute hook code");
      });
      registerInternalHook("agent:bootstrap", registered);
      const config = createExtraFilesConfig(enabled);
      if (managed) {
        const managedHooksDir = await makeTempWorkspace("openclaw-managed-hooks-");
        await writeFiles(path.join(managedHooksDir, "bootstrap-extra-files"), {
          "HOOK.md": [
            "---",
            "name: bootstrap-extra-files",
            "description: managed replacement",
            'metadata: { "openclaw": { "events": ["agent:bootstrap"] } }',
            "---",
            "",
          ].join("\n"),
          ...(handler === undefined ? {} : { "handler.js": handler }),
        });
        config.hooks!.internal!.load = { extraDirs: [managedHooksDir] };
      }
      const result = await resolveBootstrapContextForDiagnostics({ workspaceDir, config });
      expect(registered).not.toHaveBeenCalled();
      expect(result.bootstrapFiles.some((file) => file.path === extraPath)).toBe(projects);
      if (projects && !managed) {
        expect(result.contextFiles).toContainEqual({ path: extraPath, content: "extra agents" });
      }
    },
  );
});

describe("hasCompletedBootstrapTurn", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-bootstrap-turn-");
  let tmpDir: string;
  let sessionTarget: SessionTranscriptRuntimeTarget;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = sessionDirs.make();
    sessionTarget = {
      agentId: "main",
      sessionId: randomUUID(),
      sessionKey: "agent:main:bootstrap-turn",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: Date.now(),
    });
    sessionManager = SessionManager.open(sessionTarget, tmpDir);
  });

  it("returns false without a complete SQLite transcript identity", async () => {
    expect(await hasCompletedBootstrapTurn()).toBe(false);
    expect(await hasCompletedBootstrapTurn({ ...sessionTarget, storePath: undefined })).toBe(false);
  });

  it("returns false when no full bootstrap marker has been recorded", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry("openclaw:unrelated", { timestamp: 2 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it.each([
    { boundary: "compaction", renew: false },
    { boundary: "compaction", renew: true },
    { boundary: "reset", renew: false },
  ])("checks completion after $boundary (new marker=$renew)", async ({ boundary, renew }) => {
    const firstEntryId = sessionManager.appendMessage(
      boundary === "reset"
        ? { role: "user", content: "hello", timestamp: 1 }
        : makeUserMessage("hello", 1),
    );
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    if (boundary === "reset") {
      sessionManager.appendResetBoundary("reset");
    } else {
      sessionManager.appendCompaction("trimmed", firstEntryId, 10);
    }
    if (renew) {
      sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 3 });
    }
    const hostExec = renew ? vi.spyOn(DatabaseSync.prototype, "exec") : undefined;
    try {
      expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(renew);
      if (hostExec) {
        expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
      }
    } finally {
      hostExec?.mockRestore();
    }
  });

  it("ignores completion markers on an inactive transcript branch", async () => {
    const firstEntryId = sessionManager.appendMessage(makeUserMessage("hello", 1));
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);

    sessionManager.appendLeafControl({
      targetId: firstEntryId,
      appendParentId: firstEntryId,
    });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });
});

describe("makeBootstrapWarn", () => {
  it("keeps content revisions distinct when decorating truncation warnings", () => {
    const warnings: string[] = [];
    const workspaceDir = `/tmp/${randomUUID()}`;
    for (const { sessionLabel, content } of [
      { sessionLabel: "first", content: "a" },
      { sessionLabel: "second", content: "a" },
      { sessionLabel: "first", content: "b" },
    ]) {
      buildBootstrapContextFiles(
        [
          {
            name: "AGENTS.md",
            path: `${workspaceDir}/AGENTS.md`,
            content: content.repeat(1000),
            missing: false,
          },
        ],
        {
          maxChars: 200,
          warn: makeBootstrapWarn({
            sessionLabel,
            workspaceDir,
            warn: (message) => warnings.push(message),
          }),
        },
      );
    }
    expect(warnings).toEqual([
      "workspace bootstrap file AGENTS.md is 1000 chars (limit 200); truncating in injected context (sessionKey=first)",
      "workspace bootstrap file AGENTS.md is 1000 chars (limit 200); truncating in injected context (sessionKey=first)",
    ]);
  });

  it("deduplicates repeated warnings for the same session and message", () => {
    const warnings: string[] = [];
    const warn = makeBootstrapWarn({
      sessionLabel: "agent:main:test-session",
      workspaceDir: `/tmp/${randomUUID()}`,
      warn: (message) => warnings.push(message),
    });

    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:test-session)",
    ]);
  });
});

describe("resolveContextInjectionMode", () => {
  it.each([
    [undefined, undefined, "always"],
    [
      {
        agents: {
          defaults: { contextInjection: "continuation-skip" },
          entries: { strict: { contextInjection: "always" } },
        },
      },
      "strict",
      "always",
    ],
    [
      { agents: { defaults: { contextInjection: "never" }, entries: { worker: {} } } },
      "worker",
      "never",
    ],
  ] as const)("resolves %j for agent=%s to %s", (config, agentId, expected) => {
    expect(resolveContextInjectionMode(config as never, agentId)).toBe(expected);
  });
});
