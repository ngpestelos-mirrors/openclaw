/**
 * Provider catalog contract assertions and expected Codex catalog fixtures.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import * as jitiFactory from "../../plugins/jiti-factory.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as publicSurfaceLoader from "../../plugins/public-surface-loader.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../test-utils/bundled-plugin-public-surface.js";

export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
  expectCodexMissingAuthHint,
} from "../../plugins/provider-runtime.test-support.js";
export type { ProviderPlugin } from "../provider-model-shared.js";

/** Supplies manifest facts without cold runtime discovery in provider catalog tests. */
export function useProviderCatalogMetadata(pluginRoot: URL): void {
  const loaded = loadPluginManifest(fileURLToPath(pluginRoot));
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const snapshot = createPluginMetadataSnapshotFixture({ plugins: [loaded.manifest] });
  beforeEach(() => {
    setCurrentPluginMetadataSnapshot(snapshot);
    const loader = vi.spyOn(jitiFactory, "createJiti").mockImplementation(() => {
      throw new Error("Provider catalog tests must use prepared metadata without Jiti");
    });
    return () => loader.mockRestore();
  });
  afterEach(() => setCurrentPluginMetadataSnapshot(undefined));
}

type ProviderRuntimeCatalogModule = Pick<
  typeof import("openclaw/plugin-sdk/provider-catalog-runtime"),
  "augmentModelCatalogWithProviderPlugins"
>;

export async function importProviderRuntimeCatalogModule(): Promise<ProviderRuntimeCatalogModule> {
  const { augmentModelCatalogWithProviderPlugins } =
    await import("openclaw/plugin-sdk/provider-catalog-runtime");
  return {
    augmentModelCatalogWithProviderPlugins,
  };
}

/** Keep genuine provider policy artifacts in the test runner's SDK module graph. */
export function useBundledProviderPolicyArtifactsForTest(pluginIds: readonly string[]): void {
  const artifacts = new Map<string, object>();
  const loadArtifact = publicSurfaceLoader.loadBundledPluginPublicArtifactModuleFromCandidatesSync;
  let restoreLoader = () => {};
  const installLoader = () => {
    restoreLoader();
    const loader = vi
      .spyOn(publicSurfaceLoader, "loadBundledPluginPublicArtifactModuleFromCandidatesSync")
      .mockImplementation((params) => {
        const artifact = artifacts.get(params.dirName);
        if (
          artifact &&
          !params.owner &&
          !params.env &&
          params.artifactCandidates.length === 1 &&
          params.artifactCandidates[0] === "provider-policy-api.js"
        ) {
          return artifact;
        }
        return loadArtifact(params);
      });
    restoreLoader = () => loader.mockRestore();
  };
  beforeAll(async () => {
    for (const pluginId of pluginIds) {
      const moduleId = resolveRelativeBundledPluginPublicModuleId({
        fromModuleUrl: import.meta.url,
        pluginId,
        artifactBasename: "provider-policy-api.js",
      });
      const artifact: object = await import(moduleId);
      artifacts.set(pluginId, artifact);
    }
    installLoader();
  });
  beforeEach(installLoader);
  afterEach(() => restoreLoader());
  afterAll(() => {
    restoreLoader();
    artifacts.clear();
  });
}
