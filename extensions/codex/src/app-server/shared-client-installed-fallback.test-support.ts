import { SemVer } from "semver";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type ClientHarness = ReturnType<typeof createClientHarness>;

/** Registers first-start fallback from a selected installed Codex to the bundled package. */
export function registerSharedClientInstalledFallbackTests(params: {
  resolveManagedStart: Mock;
  sendInitializeResult: (harness: ClientHarness, userAgent: string) => Promise<void>;
  warn: Mock;
}): void {
  describe("selected installed Codex", () => {
    const installedCommand = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
    const installedVersion = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;
    // Same slot test/setup.shared.ts seeds; managed-binary.ts captured this object.
    const installedState = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.codexInstalledAppServer")
    ] as {
      selection?: Promise<unknown>;
      selected?: { command: string; nativeCommand: string; version: string };
    };

    function selectInstalledCodex(): CodexAppServerStartOptions {
      const selected = {
        command: installedCommand,
        nativeCommand: "/usr/local/bin/codex-native",
        version: installedVersion,
      };
      installedState.selected = selected;
      installedState.selection = Promise.resolve(selected);
      params.resolveManagedStart.mockImplementation(
        async (startOptions: CodexAppServerStartOptions) => ({
          ...startOptions,
          command: installedCommand,
          commandSource: "resolved-managed",
          managedFallbackCommandPaths: ["/cache/openclaw/codex"],
        }),
      );
      return {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      };
    }

    afterEach(() => {
      installedState.selection = Promise.resolve(undefined);
      delete installedState.selected;
    });

    it.each([
      { failure: "spawn EACCES", installed: "spawn" },
      { failure: "initialize refused", installed: "initialize" },
      { failure: `app-server reported ${CODEX_APP_SERVER_VERSION}`, installed: "version" },
    ] as const)("falls back to the bundled package on $installed failure", async (scenario) => {
      const installed = createClientHarness();
      const bundled = createClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start");
      if (scenario.installed === "spawn") {
        startSpy.mockRejectedValueOnce(new Error(scenario.failure));
      } else {
        startSpy.mockResolvedValueOnce(installed.client);
      }
      startSpy.mockResolvedValueOnce(bundled.client);

      const acquire = getSharedCodexAppServerClient({
        startOptions: selectInstalledCodex(),
        timeoutMs: 1_000,
      });
      if (scenario.installed === "initialize") {
        const initialize = JSON.parse(await installed.waitForWrite(0)) as { id: number };
        installed.send({ id: initialize.id, error: { code: -32603, message: scenario.failure } });
      } else if (scenario.installed === "version") {
        await params.sendInitializeResult(installed, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
      }
      await params.sendInitializeResult(bundled, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
      const failure = scenario.failure;

      expect(await acquire).toBe(bundled.client);
      expect(startSpy.mock.calls.map(([options]) => options?.command)).toEqual([
        installedCommand,
        "/cache/openclaw/codex",
      ]);
      expect(params.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Codex app-server: installed ${installedCommand} ${installedVersion} failed to start (${failure}`,
        ),
      );
      // Later managed starts and model discovery in this process use the bundled package.
      await expect(installedState.selection).resolves.toBeUndefined();
      expect(installedState.selected).toBeUndefined();
      await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    });

    it("keeps the installed binary when its handshake matches the selection", async () => {
      const installed = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(installed.client);

      const acquire = getSharedCodexAppServerClient({
        startOptions: selectInstalledCodex(),
        timeoutMs: 1_000,
      });
      await params.sendInitializeResult(installed, `codex-cli/${installedVersion}`);

      expect(await acquire).toBe(installed.client);
      expect(startSpy).toHaveBeenCalledOnce();
      expect(installedState.selected?.command).toBe(installedCommand);
      await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    });
  });
}
