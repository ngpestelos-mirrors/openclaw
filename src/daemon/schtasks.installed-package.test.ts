import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { boundedEnv } from "./schtasks.installed-package.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["PSMODULEANALYSISCACHEPATH", "PSModuleAnalysisCachePath"])(
  "preserves native %s and mixed-case Path while isolating application state",
  (cacheKey) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    for (const key of Object.keys(process.env)) {
      if (["PATH", "APPDATA", "TEMP", "PSMODULEANALYSISCACHEPATH"].includes(key.toUpperCase())) {
        vi.stubEnv(key, undefined);
      }
    }
    const nativePath = "C:\\native-tools";
    const moduleCache = "C:\\native-cache\\ModuleAnalysisCache";
    vi.stubEnv("Path", nativePath);
    vi.stubEnv(cacheKey, moduleCache);
    vi.stubEnv("appData", "C:\\native-profile\\roaming");
    vi.stubEnv("temp", "C:\\native-temp");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-do-not-forward");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    const root = path.resolve("synthetic-installed-fixture");
    const prefix = path.join(root, "prefix");
    const result = boundedEnv(root, prefix);

    expect(resolveEnvironmentValue(result, "PATH", "win32")).toContain(nativePath);
    expect(Object.keys(result).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
    expect(resolveEnvironmentValue(result, "APPDATA", "win32")).toBe(path.join(root, "appdata"));
    expect(resolveEnvironmentValue(result, "TEMP", "win32")).toBe(path.join(root, "tmp"));
    expect(result.OPENCLAW_STATE_DIR).toBe(path.join(root, "state"));
    expect(result.OPENCLAW_CONFIG_PATH).toBe(path.join(root, "openclaw.json"));
    expect(result.npm_config_prefix).toBe(prefix);
    expect(result.npm_config_cache).toBe(path.join(root, "npm-cache"));
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(resolveEnvironmentValue(result, "PSMODULEANALYSISCACHEPATH", "win32")).toBe(moduleCache);
  },
);
