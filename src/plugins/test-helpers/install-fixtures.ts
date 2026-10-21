// Plugin install fixture helpers build generated bundle layouts for install tests.
import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "../../test-utils/temp-dir.js";
import type { PluginInstallArtifactConsentHandler } from "../install-types.js";
import { createColdPluginFixture } from "./cold-plugin-fixtures.js";

type MakeTempDir = () => string;

type BundleFixtureFormat = "agent" | "codex" | "claude" | "cursor";

function writeFixtureFile(rootDir: string, name: string, content: string | object) {
  const filePath = path.join(rootDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
}

const skillSource = "---\ndescription: fixture\n---\n";

type PluginArtifactInstallMockParams = {
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
};

export async function invokePluginArtifactInstallMock<
  TResult extends { ok: boolean; pluginId?: string; version?: string },
>(
  mock: unknown,
  params: PluginArtifactInstallMockParams,
  fixture?: { manifest?: Record<string, unknown> },
): Promise<TResult> {
  const result = await (mock as (params: PluginArtifactInstallMockParams) => Promise<TResult>)(
    params,
  );
  const reviewArtifact = params.onBeforePluginArtifactCommit;
  const pluginId = result.pluginId;
  if (
    !result.ok ||
    !pluginId ||
    !reviewArtifact ||
    params.dryRun ||
    (params.expectedPluginId && params.expectedPluginId !== pluginId)
  ) {
    return result;
  }
  return await withTempDir("openclaw-plugin-staged-", async (rootDir) => {
    const stagedArtifactDir = fs.realpathSync(rootDir);
    createColdPluginFixture({
      rootDir: stagedArtifactDir,
      pluginId,
      ...(result.version ? { packageVersion: result.version } : {}),
      ...(fixture?.manifest ? { manifest: fixture.manifest } : {}),
    });
    await reviewArtifact({
      pluginId,
      stagedArtifactDir,
      mode: params.mode ?? "install",
    });
    return result;
  });
}

export function createBundleInstallFixtureFactory(makeTempDir: MakeTempDir) {
  return function setupBundleInstallFixture(params: {
    bundleFormat: BundleFixtureFormat;
    name: string;
  }) {
    const caseDir = makeTempDir();
    const stateDir = path.join(caseDir, "state");
    const pluginDir = path.join(caseDir, "plugin-src");
    fs.mkdirSync(stateDir, { recursive: true });
    const manifestRelativePath =
      params.bundleFormat === "agent"
        ? "plugin.json"
        : path.join(`.${params.bundleFormat}-plugin`, "plugin.json");
    writeFixtureFile(pluginDir, manifestRelativePath, {
      ...(params.bundleFormat === "agent"
        ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" }
        : {}),
      name: params.name,
      description: `${params.bundleFormat} bundle fixture`,
      ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
    });
    if (params.bundleFormat === "cursor") {
      writeFixtureFile(pluginDir, ".cursor/commands/review.md", skillSource);
    }
    const skillDir = path.join(
      pluginDir,
      "skills",
      ...(params.bundleFormat === "agent" ? ["fixture"] : []),
    );
    writeFixtureFile(skillDir, "SKILL.md", skillSource);
    return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
  };
}

export function createDualFormatInstallFixtureFactory(makeTempDir: MakeTempDir) {
  return function setupDualFormatInstallFixture(params: { bundleFormat: "codex" | "claude" }) {
    const caseDir = makeTempDir();
    const stateDir = path.join(caseDir, "state");
    const pluginDir = path.join(caseDir, "plugin-src");
    writeFixtureFile(pluginDir, "package.json", {
      name: "@openclaw/native-dual",
      version: "0.0.1",
      openclaw: { extensions: ["./dist/index.js"] },
      dependencies: { "left-pad": "1.3.0" },
    });
    writeFixtureFile(pluginDir, "openclaw.plugin.json", {
      id: "native-dual",
      configSchema: { type: "object", properties: {} },
      skills: ["skills"],
    });
    writeFixtureFile(pluginDir, "dist/index.js", "export {};");
    writeFixtureFile(pluginDir, "skills/SKILL.md", skillSource);
    writeFixtureFile(pluginDir, `.${params.bundleFormat}-plugin/plugin.json`, {
      name: "Bundle Fallback",
      ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
    });
    return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
  };
}
