import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { NodeBootstrapArtifactWorkerTasks } from "./node-bootstrap-artifact-contract.js";
import {
  extract,
  readText,
  useNodeBootstrapArtifactFixtures,
  write,
  writeBundledBrowser,
  writeFiles,
} from "./node-bootstrap-artifact.test-support.js";

// mock-isolation: the artifact worker suite separately covers transport.
vi.mock("./node-bootstrap-artifact-worker.js", async () => {
  const { prepareNodeBootstrapArtifact } = await import("./node-bootstrap-artifact-build.js");
  return {
    prepareNodeArtifactInWorker: (
      _kind: "bootstrap",
      { options, temporaryRoot }: NodeBootstrapArtifactWorkerTasks["bootstrap"]["input"],
    ) => prepareNodeBootstrapArtifact(options, temporaryRoot),
  };
});

const { fixture, createProvider } = useNodeBootstrapArtifactFixtures();

async function runNode(root: string) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "openclaw.mjs")]);
  return stdout.trim();
}

describe("node bootstrap bundled dependency ownership", () => {
  it("preserves workspace bundles when npm bundling is disabled", async () => {
    const { root, packageRoot, provider, sourcePackage } = await fixture();
    await write(packageRoot, "package.json", { ...sourcePackage, bundleDependencies: false });

    const target = await extract(root, await provider.prepare());
    expect(await runNode(target)).toBe("local-ai:cloud-ready");
    const manifest = JSON.parse(await readText(target, "package.json"));
    expect(manifest.bundleDependencies).toEqual(["@fixture/ai"]);
  });

  it("retains registry bundle dependency declarations for npm installation", async () => {
    const { root, packageRoot, provider } = await fixture();
    await writeBundledBrowser(packageRoot, { "transitive-runtime": "^1.2.3" });

    const target = await extract(root, await provider.prepare());
    expect(
      JSON.parse(await readText(target, "node_modules/@fixture/browser/package.json")),
    ).toMatchObject({ dependencies: { "transitive-runtime": "^1.2.3" } });
  });

  it("runs package-owned modules under src/node_modules", async () => {
    const { root, packageRoot, provider, sourcePackage } = await fixture();
    const name = "@fixture/codec";
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { ...sourcePackage.dependencies, [name]: "1.2.3" },
      bundleDependencies: [name],
    });
    const bundledRoot = path.join(packageRoot, "node_modules", name);
    await writeFiles(bundledRoot, {
      "package.json": {
        name,
        version: "1.2.3",
        type: "commonjs",
        main: "./src/index.js",
      },
      "src/index.js": 'module.exports = require("codec-internal");',
      "src/node_modules/codec-internal/package.json": {
        name: "codec-internal",
        version: "1.2.3",
        main: "./index.js",
      },
      "src/node_modules/codec-internal/index.js": 'module.exports = "bundled-internal";',
    });
    await write(packageRoot, "dist/entry.js", `import result from "${name}"; console.log(result);`);

    const target = await extract(root, await provider.prepare());
    expect(await runNode(target)).toBe("bundled-internal");
  });

  it.each(["source", "external-plugin"] as const)(
    "packages a plugin bundle from its own %s installation",
    async (mode) => {
      const { root, packageRoot, pluginRoot, pluginPackage, options } = await fixture(mode);
      const name = "@fixture/codec";
      const manifest = {
        ...pluginPackage,
        dependencies: { ...pluginPackage.dependencies, [name]: "1.2.3" },
        bundleDependencies: [name],
      };
      const runtimeRoot =
        mode === "source" ? path.join(packageRoot, "dist/extensions/remote-runtime") : pluginRoot;
      if (mode === "source") {
        await write(pluginRoot, "package.json", manifest);
      }
      await write(runtimeRoot, "package.json", {
        ...manifest,
        ...(mode === "external-plugin"
          ? { openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] } }
          : {}),
      });
      await write(
        runtimeRoot,
        mode === "source" ? "index.js" : "dist/index.js",
        `export { value as answer } from "${name}";`,
      );
      const dependencyManifest = {
        name,
        version: "1.2.3",
        type: "module",
        exports: { ".": "./index.js" },
      };
      const modules = mode === "source" ? pluginRoot : root;
      await writeFiles(modules, {
        [`node_modules/${name}/package.json`]: dependencyManifest,
        [`node_modules/${name}/index.js`]: 'export const value = "plugin-codec";',
      });
      const ordinaryRoot = path.join(root, "ordinary-plugin");
      await writeFiles(ordinaryRoot, {
        "package.json": {
          name: "@fixture/ordinary-runtime",
          version: pluginPackage.version,
          type: "module",
          dependencies: { [name]: "1.2.3" },
          openclaw: { extensions: ["./index.js"] },
        },
        "openclaw.plugin.json": { id: "ordinary-runtime" },
        "index.js": "export {};",
        [`node_modules/${name}/package.json`]: dependencyManifest,
        [`node_modules/${name}/index.js`]: 'export const value = "ordinary-codec";',
      });
      if (mode === "external-plugin") {
        await writeFiles(packageRoot, {
          [`node_modules/${name}/package.json`]: dependencyManifest,
          [`node_modules/${name}/index.js`]: 'export const value = "root-decoy";',
        });
      }
      const provider = createProvider({
        ...options,
        plugins: [{ id: "ordinary-runtime", root: ordinaryRoot }, ...options.plugins],
      });

      const target = await extract(root, await provider.prepare());
      expect(await runNode(target)).toBe("local-ai:plugin-codec");
    },
  );
});
