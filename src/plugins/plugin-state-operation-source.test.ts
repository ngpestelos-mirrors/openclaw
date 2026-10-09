import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { capturePluginStateOperationModuleSource } from "./plugin-state-operation-source.js";
import { loadValidatedPublicSurfaceModule } from "./public-surface-loader.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
const caches: ReturnType<typeof createPluginCache>[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
  for (const cache of caches.splice(0)) {
    await retirePluginCache(cache);
  }
});

function fixture(files: Record<string, string>) {
  const root = temp.make("plugin-state-operation-source-");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function bind(rootDir: string, entry = "index.ts", origin: "config" | "bundled" = "config") {
  const instance = new PluginInstance("operation-fixture");
  instances.push(instance);
  const cache = createPluginCache();
  caches.push(cache);
  withPluginCache(cache, () =>
    bindPluginInstanceModuleLoader({
      instance,
      rootDir,
      source: path.join(rootDir, entry),
      origin,
    }),
  );
  return instance;
}

function readVersion(
  source: ReturnType<typeof capturePluginStateOperationModuleSource>,
  url: string,
) {
  if (!source) {
    throw new Error("Expected captured operation source");
  }
  return loadValidatedPublicSurfaceModule({
    ...source.resolve(url),
    capturedSource: true,
    surfaceLabel: "fixture state operation",
  });
}

describe("plugin state operation module ownership", () => {
  it("keeps the selected TypeScript generation and its relative dependencies after source edits", () => {
    const root = fixture({
      "package.json": '{"name":"operation-fixture","type":"module"}',
      "index.ts": "export const id = 'operation-fixture';",
      "state-operation-api.ts": "export { version } from './src/operation.js';",
      "state-operation-api.js": "export const version = 'stale built';",
      "src/operation.ts": "export const version = 'original source';",
    });
    const instance = bind(root);
    const source = capturePluginStateOperationModuleSource(instance, () => {});
    fs.writeFileSync(path.join(root, "src/operation.ts"), "export const version = 'changed';");
    fs.unlinkSync(path.join(root, "state-operation-api.ts"));

    expect(
      readVersion(source, pathToFileURL(path.join(root, "state-operation-api.js")).href),
    ).toMatchObject({
      version: "original source",
    });
  });

  it("keeps a dist entry in its build family and rejects unrelated module URLs", () => {
    const root = fixture({
      "package.json": '{"name":"operation-fixture","type":"module"}',
      "dist/index.js": "export const id = 'operation-fixture';",
      "dist/state-operation-api.js": "export const version = 'selected build';",
      "state-operation-api.ts": "export const version = 'wrong source';",
      "dist/private.js": "export const version = 'private';",
    });
    const source = capturePluginStateOperationModuleSource(bind(root, "dist/index.js"), () => {});
    const selected = pathToFileURL(path.join(root, "dist/state-operation-api.js")).href;
    expect(readVersion(source, selected)).toMatchObject({ version: "selected build" });
    for (const url of [
      "https://example.invalid/state-operation-api.js",
      pathToFileURL(path.join(root, "state-operation-api.ts")).href,
      pathToFileURL(path.join(root, "dist/private.js")).href,
      pathToFileURL(path.join(root, "../other/state-operation-api.js")).href,
      `${selected}?replacement=1`,
    ]) {
      expect(() => source!.resolve(url)).toThrow("Plugin state operations require");
    }
  });

  it("rejects captured operations after owner or instance revocation", async () => {
    const root = fixture({
      "index.ts": "export const id = 'operation-fixture';",
      "state-operation-api.ts": "export const version = 1;",
    });
    const instance = bind(root);
    let current = true;
    const failure = new Error("operation owner revoked");
    const source = capturePluginStateOperationModuleSource(instance, () => {
      if (!current) {
        throw failure;
      }
    });
    const url = pathToFileURL(path.join(root, "state-operation-api.js")).href;
    source!.resolve(url);
    current = false;
    expect(() => source!.resolve(url)).toThrow(failure);
    current = true;
    await instance.dispose();
    expect(() => source!.resolve(url)).toThrow("Plugin operation-fixture is retiring");
  });

  it("retains bundled operation bytes through recovery after the original instance retires", async () => {
    const root = fixture({
      "package.json": '{"name":"operation-fixture"}',
      "index.cjs": "module.exports = { id: 'operation-fixture' };",
      "state-operation-api.cjs": "module.exports = require('./src/operation.cjs');",
      "src/operation.cjs": "module.exports = { version: 'retained generation' };",
    });
    const original = bind(root, "index.cjs", "bundled");
    const recovery = original.captureModuleLoaderRecovery();
    await original.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    const restored = new PluginInstance("operation-fixture");
    instances.push(restored);
    recovery.bind(restored);
    const source = capturePluginStateOperationModuleSource(restored, () => {});

    expect(
      readVersion(source, pathToFileURL(path.join(root, "state-operation-api.cjs")).href),
    ).toMatchObject({
      version: "retained generation",
    });
  });
});
