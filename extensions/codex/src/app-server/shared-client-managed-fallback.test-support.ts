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

/** Registers version-driven fallback between managed start candidates. */
export function registerSharedClientManagedFallbackTests(params: {
  configureManagedDesktopFallback: () => CodexAppServerStartOptions;
  resolveManagedStart: Mock;
  sendInitializeResult: (harness: ClientHarness, userAgent: string) => Promise<void>;
  warn: Mock;
}): void {
  it("keeps a supported desktop prerelease instead of falling back by version", async () => {
    const desktop = createClientHarness();
    const desktopVersion = `${new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version}-alpha.4`;
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(desktop.client);
    const startOptions = params.configureManagedDesktopFallback();

    const acquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await params.sendInitializeResult(desktop, `openclaw/${desktopVersion} (macOS; test)`);
    const client = await acquire;

    expect(client).toBe(desktop.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: ["/cache/openclaw/codex"],
    });
    expect(desktop.process.stdin.destroyed).toBe(false);
    expect(params.warn).toHaveBeenCalledExactlyOnceWith(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion: desktopVersion,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );

    await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    expect(desktop.process.stdin.destroyed).toBe(true);
  });

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
      // The generic version fallback must not skip dropping the installed selection.
      { failure: "Codex app-server 0.149.0 or newer is required", installed: "unsupported" },
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
      } else if (scenario.installed === "unsupported") {
        await params.sendInitializeResult(installed, "codex-cli/0.148.0");
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
