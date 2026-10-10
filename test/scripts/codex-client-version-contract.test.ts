// Codex Client Version Contract tests: ChatGPT model discovery reports the
// version of the Codex binary that runs turns (#113615).
import fs from "node:fs";
import { SemVer } from "semver";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexClientVersion } from "../../extensions/codex/client-version-api.js";
import { CODEX_APP_SERVER_VERSION } from "../../extensions/codex/src/app-server/version.js";
import { resolveOpenAICodexModelsEndpoint } from "../../extensions/openai/base-url.js";

const CODEX_PACKAGE_JSON_URL = new URL("../../extensions/codex/package.json", import.meta.url);
const OPENAI_PROVIDER_URL = new URL("../../extensions/openai/base-url.ts", import.meta.url);
const OPENAI_CODEX_CLIENT_VERSION_PATTERN = /^const OPENAI_CODEX_CLIENT_VERSION = "([^"]+)";$/mu;

// Same slot test/setup.shared.ts seeds; the Codex plugin captured this object.
const installedState = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codexInstalledAppServer")
] as {
  selection?: Promise<unknown>;
  selected?: { command: string; nativeCommand: string; version: string };
};

function readManagedCodexVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(CODEX_PACKAGE_JSON_URL, "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  const version = packageJson.dependencies?.["@openai/codex"];
  if (typeof version !== "string") {
    throw new Error("extensions/codex/package.json must pin @openai/codex exactly");
  }
  return version;
}

function readOpenAICodexClientVersion(): string {
  const providerSource = fs.readFileSync(OPENAI_PROVIDER_URL, "utf8");
  const version = OPENAI_CODEX_CLIENT_VERSION_PATTERN.exec(providerSource)?.[1];
  if (!version) {
    throw new Error("extensions/openai/base-url.ts must declare the Codex client version");
  }
  return version;
}

describe("Codex client version contract", () => {
  afterEach(() => {
    installedState.selection = Promise.resolve(undefined);
    delete installedState.selected;
  });

  it("falls back to the managed Codex package pin", async () => {
    expect(readOpenAICodexClientVersion()).toBe(readManagedCodexVersion());
    expect(CODEX_APP_SERVER_VERSION).toBe(readManagedCodexVersion());
    await expect(resolveOpenAICodexModelsEndpoint({ env: {} })).resolves.toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${readManagedCodexVersion()}`,
    );
    await expect(resolveCodexClientVersion({ env: {} })).resolves.toBe(readManagedCodexVersion());
  });

  it("reports the installed Codex binary that managed turns run", async () => {
    const version = new SemVer(CODEX_APP_SERVER_VERSION).inc("minor").version;
    const selected = {
      command: "/opt/codex/bin/codex",
      nativeCommand: "/opt/codex/bin/codex",
      version,
    };
    installedState.selection = Promise.resolve(selected);
    installedState.selected = selected;

    await expect(resolveCodexClientVersion({ env: {} })).resolves.toBe(version);
    // An explicit command always wins over the installed binary, so discovery
    // keeps the bundled pin there as before.
    await expect(
      resolveCodexClientVersion({ env: { OPENCLAW_CODEX_APP_SERVER_BIN: "/custom/codex" } }),
    ).resolves.toBe(CODEX_APP_SERVER_VERSION);
    await expect(
      resolveCodexClientVersion({
        config: { plugins: { entries: { codex: { config: { appServer: { command: "/x" } } } } } },
        env: {},
      }),
    ).resolves.toBe(CODEX_APP_SERVER_VERSION);
  });
});
