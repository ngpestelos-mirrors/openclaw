import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
const tempHomes: string[] = [];
const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
let readCodexCliActiveApiKey: typeof import("./cli-credentials.js").readCodexCliActiveApiKey;
let hasCodexCliAuthFile: typeof import("./cli-credentials.js").hasCodexCliAuthFile;
let readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
let readGeminiCliCredentialsCached: typeof import("./cli-credentials.js").readGeminiCliCredentialsCached;
let readMiniMaxCliCredentialsCached: typeof import("./cli-credentials.js").readMiniMaxCliCredentialsCached;

function createJwtWithExp(expirySeconds: number): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expirySeconds })}.signature`;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toMatchObject(expected);
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-credentials-"));
  tempHomes.push(home);
  return home;
}

function codexHome() {
  const home = makeHome();
  vi.stubEnv("CODEX_HOME", home);
  return home;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function tokens(refresh: string, expiry = expSeconds) {
  return { access_token: createJwtWithExp(expiry), refresh_token: refresh };
}

function writeCodexAuth(value: unknown) {
  const file = path.join(codexHome(), "auth.json");
  writeJson(file, value);
  return file;
}

function keychainRecord(value: unknown, inspectCommand = false) {
  execSyncMock.mockImplementation((command: unknown) => {
    if (inspectCommand) {
      expect(String(command)).toContain("Codex Auth");
      expect(String(command)).toContain("cli|");
    }
    return JSON.stringify(value);
  });
}

function readActiveKey(home: string) {
  return readCodexCliActiveApiKey({ codexHome: home, platform: "darwin", execSync: execSyncMock });
}

function readCodex(options: Parameters<typeof readCodexCliCredentialsCached>[0] = {}) {
  return readCodexCliCredentialsCached({ execSync: execSyncMock, ...options });
}

function readPromptScopedCache(allowKeychainPrompt: boolean) {
  return readCodex({
    allowKeychainPrompt,
    ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
    platform: "darwin",
  });
}

describe("cli credentials", () => {
  beforeAll(async () => {
    ({
      readCodexCliActiveApiKey,
      hasCodexCliAuthFile,
      readCodexCliCredentialsCached,
      readGeminiCliCredentialsCached,
      readMiniMaxCliCredentialsCached,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    vi.unstubAllEnvs();
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM"])(
    "distinguishes missing Codex login state from inspection failure: %s",
    (code) => {
      const failure = Object.assign(new Error(`synthetic ${code}`), { code });
      const stat = vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw failure;
      });
      try {
        if (code === "ENOENT" || code === "ENOTDIR") {
          expect(hasCodexCliAuthFile("/fixture/codex")).toBe(false);
        } else {
          expect(() => hasCodexCliAuthFile("/fixture/codex")).toThrow(failure);
        }
      } finally {
        stat.mockRestore();
      }
    },
  );

  it("keeps external CLI credential files anchored to the OS home", () => {
    const osHome = makeHome();
    const openClawHome = makeHome();
    const expires = Date.parse("2036-04-25T12:00:00Z");
    const codexExpiry = Math.floor(expires / 1000);
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("OPENCLAW_HOME", openClawHome);
    delete process.env.CODEX_HOME;
    for (const [home, prefix] of [
      [osHome, ""],
      [openClawHome, "decoy-"],
    ]) {
      writeJson(path.join(home, ".codex", "auth.json"), {
        tokens: tokens(`${prefix}codex-refresh`, codexExpiry),
      });
      for (const provider of ["minimax", "gemini"]) {
        writeJson(path.join(home, `.${provider}`, "oauth_creds.json"), {
          access_token: `${prefix}${provider}-access`,
          refresh_token: `${prefix}${provider}-refresh`,
          expiry_date: expires,
        });
      }
    }

    expectFields(
      readCodexCliCredentialsCached({
        allowKeychainPrompt: false,
        platform: "linux",
        ttlMs: 0,
      }),
      { refresh: "codex-refresh", provider: "openai" },
    );
    expectFields(readMiniMaxCliCredentialsCached({ ttlMs: 0 }), {
      access: "minimax-access",
      refresh: "minimax-refresh",
    });
    expectFields(readGeminiCliCredentialsCached({ ttlMs: 0 }), {
      access: "gemini-access",
      refresh: "gemini-refresh",
    });
  });

  it("falls back when Codex keychain JWT expiry is outside Date range", () => {
    codexHome();
    const lastRefresh = Date.parse("2026-01-01T00:00:00Z");
    const fallbackExpiry = lastRefresh + 60 * 60 * 1000;
    keychainRecord(
      {
        tokens: tokens("keychain-refresh", 8_700_000_000_000),
        last_refresh: "2026-01-01T00:00:00Z",
      },
      true,
    );

    const creds = readCodex({ platform: "darwin" });

    expectFields(creds, {
      refresh: "keychain-refresh",
      provider: "openai",
      expires: fallbackExpiry,
    });
  });

  it("rejects Codex keychain fallback expiry when the process clock is invalid", () => {
    codexHome();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      keychainRecord({ tokens: tokens("keychain-refresh", 8_700_000_000_000) }, true);

      expect(readCodex({ platform: "darwin" })).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("falls back to Codex auth.json when keychain is unavailable", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    writeCodexAuth({ tokens: { ...tokens("file-refresh"), id_token: "file-id-token" } });

    const creds = readCodex();

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai",
      expires: expSeconds * 1000,
      idToken: "file-id-token",
    });
  });

  it("prefers active Codex OAuth over a stale file API key", () => {
    const authPath = writeCodexAuth({
      auth_mode: "apikey",
      OPENAI_API_KEY: "stale-file-api-key",
    });
    execSyncMock.mockReturnValue("Logged in using ChatGPT");

    expect(readActiveKey(path.dirname(authPath))).toBeNull();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("uses the API key that Codex reports active instead of a stale Keychain record", () => {
    const authPath = writeCodexAuth({
      auth_mode: "apikey",
      OPENAI_API_KEY: "active-file-api-key",
    });
    execSyncMock.mockImplementation((command: unknown) =>
      String(command).includes("codex login status")
        ? "Logged in using an API key - active-f***i-key"
        : JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stale-keychain-api-key" }),
    );

    expect(readActiveKey(path.dirname(authPath))).toEqual({
      type: "api_key",
      provider: "openai",
      key: "active-file-api-key",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("treats an empty Codex auth.json API-key field as API-key mode", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    writeCodexAuth({
      OPENAI_API_KEY: "",
      tokens: tokens("stale-file-refresh", expSeconds),
    });

    expect(readCodex({ platform: "linux" })).toBeNull();
  });

  it("rejects Codex auth.json fallback expiry when stat and process clock are invalid", () => {
    writeCodexAuth({
      tokens: tokens("file-refresh", 8_700_000_000_000),
    });
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const statSyncSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("stat unavailable");
    });
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      expect(readCodex({ platform: "linux" })).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
      statSyncSpy.mockRestore();
    }
  });

  it("does not let no-keychain Codex cache misses poison keychain reads", () => {
    codexHome();

    const withoutKeychain = readPromptScopedCache(false);
    expect(withoutKeychain).toBeNull();

    keychainRecord({ tokens: tokens("keychain-refresh") });
    const withKeychain = readPromptScopedCache(true);

    expectFields(withKeychain, {
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("keeps no-prompt Codex reads on auth.json after a keychain read", () => {
    const keychainExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const fileExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    writeCodexAuth({
      tokens: tokens("file-refresh", fileExpiry),
    });
    keychainRecord({ tokens: tokens("keychain-refresh", keychainExpiry) });

    const withKeychain = readPromptScopedCache(true);
    const withoutPrompt = readPromptScopedCache(false);

    expectFields(withKeychain, {
      refresh: "keychain-refresh",
      expires: keychainExpiry * 1000,
      provider: "openai",
    });
    expectFields(withoutPrompt, {
      refresh: "file-refresh",
      expires: fileExpiry * 1000,
      provider: "openai",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached Codex credentials when auth.json changes within the TTL window", () => {
    const firstExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const secondExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    const authPath = writeCodexAuth({
      tokens: tokens("stale-refresh", firstExpiry),
    });
    fs.utimesSync(authPath, new Date("2026-03-24T10:00:00Z"), new Date("2026-03-24T10:00:00Z"));
    vi.setSystemTime(new Date("2026-03-24T10:00:00Z"));

    const first = readCodex({ ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS, platform: "linux" });

    expectFields(first, {
      refresh: "stale-refresh",
      expires: firstExpiry * 1000,
    });

    writeJson(authPath, {
      tokens: tokens("fresh-refresh", secondExpiry),
    });
    fs.utimesSync(authPath, new Date("2026-03-24T10:05:00Z"), new Date("2026-03-24T10:05:00Z"));
    vi.advanceTimersByTime(60_000);

    const second = readCodex({ ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS, platform: "linux" });

    expectFields(second, {
      refresh: "fresh-refresh",
      expires: secondExpiry * 1000,
    });
  });

  it("lifts Google account identity from the Gemini id_token", () => {
    const home = makeHome();
    const credPath = path.join(home, ".gemini", "oauth_creds.json");
    const idTokenPayload = Buffer.from(
      JSON.stringify({ sub: "google-account-42", email: "user@example.com" }),
    ).toString("base64url");
    const idToken = `header.${idTokenPayload}.signature`;
    writeJson(credPath, {
      access_token: "gemini-access",
      refresh_token: "gemini-refresh",
      id_token: idToken,
      expiry_date: Date.parse("2026-04-25T12:00:00Z"),
    });

    const creds = readGeminiCliCredentialsCached({ homeDir: home, ttlMs: 0 });

    expectFields(creds, {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "gemini-access",
      refresh: "gemini-refresh",
      accountId: "google-account-42",
      email: "user@example.com",
    });
  });
});
