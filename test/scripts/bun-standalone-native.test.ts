import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { parse } from "acorn";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { createStandaloneRequireAdapter } from "../../scripts/lib/bun-standalone-require.mjs";
import { pruneStandaloneRuntime } from "../../scripts/lib/bun-standalone-sidecar.mjs";

const temporary: string[] = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })),
);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-native-"));
  temporary.push(root);
  function write(filename: string, contents = "fixture") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  function pkg(name: string, manifest: Record<string, unknown>, files: Record<string, string>) {
    const directory = path.join(
      root,
      "node_modules/.pnpm",
      `${name.replaceAll("/", "+")}@1.0.0`,
      "node_modules",
      name,
    );
    write(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...manifest }),
    );
    for (const [filename, contents] of Object.entries(files)) {
      write(path.join(directory, filename), contents);
    }
    const link = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(directory, link);
    return directory;
  }
  return { root, write, pkg };
}

function evaluate(
  adapter: ReturnType<typeof createStandaloneNativeAdapter>,
  embeddedPaths: Record<string, string> = {},
  root = "/relocated/runtime",
) {
  const finalized = adapter.finalize({ embeddedPaths });
  const context = vm.createContext({ root, path, fileURLToPath });
  vm.runInContext(
    adapter.bootstrap
      .replace(/^import[^\n]+\n/, "")
      .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
    context,
  );
  return { finalized, context, root };
}

describe("standalone native sidecar", () => {
  it("loads the full ws implementation through a transformed ESM caller after pruning", () => {
    const { root, write, pkg } = fixture();
    const dependency = pkg(
      "ws",
      {
        main: "index.js",
        exports: {
          ".": { require: "./index.js", default: "./index.js" },
          "./package.json": "./package.json",
        },
      },
      {
        "index.js": "module.exports = require('./lib/websocket.js');",
        "lib/websocket.js": "module.exports = { marker: 'full-ws' };",
      },
    );
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { ws: "1.0.0" } }));
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const runner = path.join(image, "runner.mjs");
    write(
      runner,
      String.raw`
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createStandaloneNativeAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-native.mjs")).href)};
import { createStandaloneRequireAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-require.mjs")).href)};
import { rewriteStandaloneImports } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-imports.mjs")).href)};
import { pruneStandaloneRuntime } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-sidecar.mjs")).href)};
const { parse } = createRequire(${JSON.stringify(path.resolve("package.json"))})("acorn");
const root = ${JSON.stringify(root)};
const image = ${JSON.stringify(image)};
const dependency = ${JSON.stringify(dependency)};
const filename = path.join(root, "dist/websocket.mjs");
const library = path.join(dependency, "lib/websocket.js");
const imageLibrary = path.join(image, "websocket.cjs");
fs.copyFileSync(library, imageLibrary);
const embeddedPaths = { [path.relative(root, library)]: imageLibrary };
const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
native.transform({ filename: library, contents: fs.readFileSync(library, "utf8") });
const source = 'import { createRequire } from "node:module"; import path from "node:path"; const require = createRequire(import.meta.url); const root = path.dirname(require.resolve("ws/package.json")); export const marker = require(path.join(root, "lib/websocket.js")).marker;';
fs.mkdirSync(path.dirname(filename), { recursive: true });
const transformed = rewriteStandaloneImports({ contents: native.transform({ filename, contents: source }).contents, filename, runtimeRoot: root, embeddedPaths, moduleAliases: {}, workerThreadsShim: "", parse });
const finalized = native.finalize({ embeddedPaths });
const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
const bootstrap = [
  'import path from "node:path";',
  'import { fileURLToPath, pathToFileURL } from "node:url";',
  'const root = ' + JSON.stringify(root) + ';',
  'globalThis.__openclawStandaloneRootUrl = pathToFileURL(root + "/").href;',
  'const entries = ' + JSON.stringify(embeddedPaths) + ';',
  'const commonJsEntries = new Set();',
  'function embedded(filename) { filename = globalThis.__openclawStandaloneOriginalPath?.(filename) ?? filename; return Object.values(entries).includes(filename) ? filename : entries[path.relative(root, filename)]; }',
  native.bootstrap.replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
  requireAdapter.bootstrap,
].join("\n");
const bootstrapFile = path.join(image, "bootstrap.mjs");
const moduleFile = path.join(image, "caller.mjs");
fs.writeFileSync(bootstrapFile, bootstrap);
fs.writeFileSync(moduleFile, transformed);
pruneStandaloneRuntime(root, finalized.files);
if (fs.existsSync(path.join(root, "node_modules"))) throw new Error("node_modules remains");
await import(pathToFileURL(bootstrapFile).href);
if ((await import(pathToFileURL(moduleFile).href)).marker !== "full-ws") throw new Error("loaded the wrong ws implementation");
console.log("full-ws loaded without node_modules");
`,
    );
    const result = spawnSync(
      process.env.OPENCLAW_STANDALONE_TEST_RUNTIME ?? process.execPath,
      [runner],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("full-ws loaded without node_modules");
  });

  it("resolves graph-retained root and peer packages without retaining unused development packages", () => {
    const { root, write, pkg } = fixture();
    const first = pkg("hoisted", { main: "index.js" }, { "index.js": "module.exports = 'first';" });
    const second = path.join(root, "node_modules/.pnpm/hoisted@2.0.0/node_modules/hoisted");
    write(
      path.join(second, "package.json"),
      JSON.stringify({ name: "hoisted", version: "2.0.0", main: "index.js" }),
    );
    write(path.join(second, "index.js"), "module.exports = 'second';");
    fs.unlinkSync(path.join(root, "node_modules/hoisted"));
    fs.symlinkSync(second, path.join(root, "node_modules/hoisted"));
    const consumer = pkg(
      "peer-consumer",
      { peerDependencies: { hoisted: "*" } },
      { "index.js": "module.exports = {};" },
    );
    fs.mkdirSync(path.join(consumer, "node_modules"));
    fs.symlinkSync(first, path.join(consumer, "node_modules/hoisted"));
    pkg("unused-development", { main: "binding.node" }, { "binding.node": "unused" });
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "peer-consumer": "1.0.0" },
        devDependencies: { hoisted: "2.0.0", "unused-development": "1.0.0" },
      }),
    );
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const embeddedPaths: Record<string, string> = {};
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    for (const [name, directory] of Object.entries({ first, second, consumer })) {
      const filename = path.join(directory, "index.js");
      const contents = fs.readFileSync(filename, "utf8");
      adapter.transform({ filename, contents });
      const imageEntry = path.join(image, `${name}.cjs`);
      fs.writeFileSync(imageEntry, contents);
      embeddedPaths[path.relative(root, filename)] = imageEntry;
    }
    const { context, finalized } = evaluate(adapter, embeddedPaths, root);
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    Object.assign(context, {
      commonJsEntries: new Set(),
      embedded: (filename: string) =>
        Object.values(embeddedPaths).includes(filename)
          ? filename
          : embeddedPaths[path.relative(root, filename)],
    });
    vm.runInContext(requireAdapter.bootstrap, context);
    pruneStandaloneRuntime(root, finalized.files);
    const fromRoot = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(root, "dist/entry.mjs"),
    );
    const fromPeer = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(root, "native/peer-consumer@1.0.0/peer-consumer/index.js"),
    );
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    expect(fromRoot("hoisted/package.json").version).toBe("2.0.0");
    expect(fromRoot("hoisted")).toBe("second");
    expect(fromPeer("hoisted/package.json").version).toBe("1.0.0");
    expect(fromPeer("hoisted")).toBe("first");
    expect(
      finalized.files.some((file: { source: string }) =>
        file.source.includes("unused-development"),
      ),
    ).toBe(false);
  });

  it("loads exported package subpaths from the image after removing node_modules", () => {
    const { root, write, pkg } = fixture();
    const dependency = pkg(
      "@fixture/fs-safe",
      { exports: { "./secure-temp-root": "./dist/secure-temp-dir.js" } },
      { "dist/secure-temp-dir.js": "module.exports = { resolveSecureTempRoot: () => 'safe' };" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@fixture/fs-safe": "1.0.0" } }),
    );
    const image = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-image-"));
    temporary.push(image);
    const imageEntry = path.join(image, "secure-temp-dir.cjs");
    fs.copyFileSync(path.join(dependency, "dist/secure-temp-dir.js"), imageEntry);
    const sourceEntry = path.relative(root, path.join(dependency, "dist/secure-temp-dir.js"));
    const embeddedPaths = { [sourceEntry]: imageEntry };
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const finalized = adapter.finalize({ embeddedPaths });
    const requireAdapter = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    const context = vm.createContext({
      root,
      path,
      fileURLToPath,
      createRequire,
      commonJsEntries: new Set(),
      embedded: (filename: string) =>
        filename === imageEntry ? imageEntry : embeddedPaths[path.relative(root, filename)],
    });
    vm.runInContext(
      adapter.bootstrap
        .replace(/^import[^\n]+\n/, "")
        .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
      context,
    );
    vm.runInContext(requireAdapter.bootstrap, context);
    pruneStandaloneRuntime(root, finalized.files);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
    const load = context["__openclawStandaloneCreateRequire"](
      createRequire,
      path.join(root, "dist/entry.mjs"),
    );
    expect(load("@fixture/fs-safe/secure-temp-root").resolveSecureTempRoot()).toBe("safe");
  });

  it("retains native resources when the output parent is a symlink", () => {
    const { root, write, pkg } = fixture();
    const owner = pkg(
      "native-library",
      { main: "index.js" },
      {
        "index.js": "export const url = import.meta.url;",
        "binding.node": "native",
      },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-library": "1" } }),
    );
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    temporary.push(alias);
    const adapter = createStandaloneNativeAdapter({ runtimeRoot: alias, parse });
    adapter.transform({
      filename: path.join(alias, path.relative(root, owner), "index.js"),
      contents: "export const url = import.meta.url;",
    });
    const files = adapter.finalize().files;
    expect(
      files.some((file: { destination: string }) => file.destination.endsWith("/binding.node")),
    ).toBe(true);
    expect(files.every((file: { source: string }) => !file.source.startsWith("../"))).toBe(true);
  });

  it("routes literal package names resolving to addons through the physical sidecar", () => {
    const { root, write, pkg } = fixture();
    pkg("native-helper", { main: "binding.node" }, { "binding.node": "native" });
    const source = '(require) => require("native-helper")';
    const owner = pkg(
      "native-wrapper",
      { dependencies: { "native-helper": "1.0.0" } },
      { "index.js": "module.exports = require('native-helper');" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-wrapper": "1.0.0" } }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    const filename = path.join(owner, "index.js");
    const transformed = adapter.transform({ filename, contents: '() => require("native-helper")' });
    const { context } = evaluate(adapter);
    context["__openclawStandaloneRootUrl"] = "file:///relocated/runtime/";
    context["__openclawStandaloneNativeRequire"] = (parent: string, specifier: string) =>
      context["__openclawStandaloneNativeResolve"](parent, specifier);
    const load = vm.runInContext(transformed.contents, context);
    expect(load()).toBe("/relocated/runtime/native/native-helper@1.0.0/native-helper/binding.node");
    expect(adapter.transform({ filename, contents: source }).contents).toBe(source);
  });

  it("preserves library aliases while copying their bytes as regular files", () => {
    const { root, write, pkg } = fixture();
    const owner = pkg(
      "native-library",
      {},
      { "index.js": "export const url = import.meta.url;", "lib/library.1.dylib": "library" },
    );
    fs.symlinkSync("library.1.dylib", path.join(owner, "lib/library.dylib"));
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "native-library": "1.0.0" } }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    adapter.transform({
      filename: path.join(owner, "index.js"),
      contents: "export const url = import.meta.url;",
    });
    const { context, finalized } = evaluate(adapter);
    expect(
      context["__openclawStandaloneNativeResolve"](
        "/relocated/runtime/dist/entry.js",
        "native-library/lib/library.dylib",
      ),
    ).toBe("/relocated/runtime/native/native-library@1.0.0/native-library/lib/library.dylib");
    const alias = finalized.files.find((file: { destination: string }) =>
      file.destination.endsWith("/library.dylib"),
    );
    expect(alias?.source).toBe(`${path.relative(root, owner)}/lib/library.dylib`);
    expect(fs.readFileSync(path.join(root, alias!.source), "utf8")).toBe("library");
  });

  it("captures computed fs-safe/proc-safe and sqlite-vec imports without a pnpm tree", () => {
    const { root, write, pkg } = fixture();
    const fsNative = pkg(
      "@openclaw/fs-safe-darwin-arm64",
      { main: "fs-safe-native.node", os: ["darwin"], cpu: ["arm64"] },
      { "fs-safe-native.node": "fs" },
    );
    const procNative = pkg(
      "@openclaw/proc-safe-darwin-arm64",
      { main: "proc-safe-native.node", os: ["darwin"], cpu: ["arm64"] },
      { "proc-safe-native.node": "proc" },
    );
    const vecNative = pkg("sqlite-vec-darwin-arm64", {}, { "vec0.dylib": "vec" });
    const fsOwner = pkg(
      "@openclaw/fs-safe",
      { optionalDependencies: { "@openclaw/fs-safe-darwin-arm64": "1.0.0" } },
      {
        "dist/native.js": "export const url = import.meta.url;",
        "dist/archive-parser.wasm": "wasm",
        LICENSE: "MIT",
      },
    );
    fs.chmodSync(path.join(fsOwner, "LICENSE"), 0o755);
    const procOwner = pkg(
      "@openclaw/proc-safe",
      { optionalDependencies: { "@openclaw/proc-safe-darwin-arm64": "1.0.0" } },
      { "dist/native.js": "export const url = import.meta.url;" },
    );
    const vecOwner = pkg(
      "sqlite-vec",
      { optionalDependencies: { "sqlite-vec-darwin-arm64": "1.0.0" } },
      { "index.mjs": "export const url = import.meta.url;" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          "@openclaw/fs-safe": "1.0.0",
          "@openclaw/proc-safe": "1.0.0",
          "sqlite-vec": "1.0.0",
        },
      }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    for (const filename of [
      path.join(fsOwner, "dist/native.js"),
      path.join(procOwner, "dist/native.js"),
      path.join(vecOwner, "index.mjs"),
    ]) {
      adapter.transform({ filename, contents: fs.readFileSync(filename, "utf8") });
    }
    const { context, finalized, root: destination } = evaluate(adapter);
    const resolve = context["__openclawStandaloneNativeResolve"];
    const resolutions: Array<[string, string, string]> = [
      [path.join(fsOwner, "dist/native.js"), "@openclaw/fs-safe-darwin-arm64", fsNative],
      [path.join(procOwner, "dist/native.js"), "@openclaw/proc-safe-darwin-arm64", procNative],
      [path.join(vecOwner, "index.mjs"), "sqlite-vec-darwin-arm64/vec0.dylib", vecNative],
    ];
    for (const [owner, specifier, expected] of resolutions) {
      const parent = path.join(destination, path.relative(root, owner));
      const resolved = resolve(pathToFileURL(parent).href, specifier);
      expect(resolved).toContain(`${destination}/native/`);
      expect(resolved).not.toContain(".pnpm");
      expect(
        finalized.files.some((file: { source: string }) =>
          file.source.startsWith(path.relative(root, expected)),
        ),
      ).toBe(true);
    }
    const parent = path.join(destination, path.relative(root, fsOwner), "dist/native.js");
    expect(resolve(parent, "../package.json")).toMatch(/native\/.+\/package\.json$/);
    expect(
      finalized.files.filter((file: { category: string }) => file.category === "nativeAddons"),
    ).toHaveLength(2);
    expect(
      finalized.files.some((file: { destination: string }) =>
        file.destination.endsWith("archive-parser.wasm"),
      ),
    ).toBe(true);
    expect(
      finalized.files.every(
        (file: { destination: string }) =>
          !file.destination.includes(".pnpm") && !/\.[cm]?js$/.test(file.destination),
      ),
    ).toBe(true);
    const report = pruneStandaloneRuntime(root, finalized.files);
    expect(report.categories.dependencyLicenses?.files).toBe(1);
    expect(
      fs.readFileSync(
        path.join(root, "native/@openclaw+fs-safe@1.0.0/@openclaw/fs-safe/LICENSE"),
        "utf8",
      ),
    ).toBe("MIT");
  });

  it("rebases resource expressions and resolves embedded optional wrappers through their original identity", () => {
    const { root, write, pkg } = fixture();
    const native = pkg(
      "terminal-native",
      { main: "lib/index.js", type: "commonjs" },
      {
        "lib/index.js": "module.exports = require('../binding.node');",
        "binding.node": "native",
        "assets/table.wasm": "wasm",
        "prebuilds/linux-x64/unused.node": "other-host",
      },
    );
    const owner = pkg(
      "terminal",
      { optionalDependencies: { "terminal-native": "1.0.0" } },
      { "index.js": "module.exports = require(selected);" },
    );
    write(path.join(root, "package.json"), JSON.stringify({ dependencies: { terminal: "1.0.0" } }));
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    expect(adapter.additionalModuleEntries).toEqual([
      path.relative(root, path.join(native, "lib/index.js")),
    ]);
    adapter.transform({
      filename: path.join(owner, "index.js"),
      contents: "module.exports = require(selected);",
    });
    const source =
      "(() => [__dirname, __filename, import.meta.url, import.meta.dirname, '__dirname'])";
    const transformed = adapter.transform({
      filename: path.join(native, "lib/index.js"),
      contents: source,
    });
    const embedded = "/$bunfs/root/terminal-native.js";
    const {
      context,
      finalized,
      root: destination,
    } = evaluate(adapter, { [path.relative(root, path.join(native, "lib/index.js"))]: embedded });
    context["__openclawStandaloneRootUrl"] = pathToFileURL(destination + "/").href;
    const values = vm.runInContext(transformed.contents, context)();
    expect(values[0]).toBe(`${destination}/native/terminal-native@1.0.0/terminal-native/lib`);
    expect(values[1]).toBe(`${values[0]}/index.js`);
    expect(values[2]).toBe(pathToFileURL(values[1]).href);
    expect(values[3]).toBe(values[0]);
    expect(values[4]).toBe("__dirname");
    expect(
      context["__openclawStandaloneNativeResolve"](
        path.join(destination, path.relative(root, owner), "index.js"),
        "terminal-native",
      ),
    ).toBe(embedded);
    expect(
      finalized.files.some((file: { source: string }) => file.source.includes("unused.node")),
    ).toBe(false);
  });

  it("keeps plugin asset roots and shadowed bindings while resolving core package resources", () => {
    const { root, write, pkg } = fixture();
    const native = pkg("native-helper", { main: "binding.node" }, { "binding.node": "native" });
    write(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", dependencies: { "native-helper": "1.0.0" } }),
    );
    const plugin = path.join(root, "dist/extensions/example");
    write(path.join(plugin, "package.json"), JSON.stringify({ name: "example-plugin" }));
    write(path.join(plugin, "helper.wasm"), "plugin");
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    const pluginCode = "const asset = new URL('./helper.wasm', import.meta.url);";
    expect(
      adapter.transform({ filename: path.join(plugin, "index.js"), contents: pluginCode }).contents,
    ).toBe(pluginCode);
    const source =
      "(() => [((__dirname) => __dirname)('local'), {__dirname}, (() => { const __filename = 'bound'; return __filename; })()])";
    const transformed = adapter.transform({
      filename: path.join(native, "binding.js"),
      contents: source,
    });
    const { context, root: destination } = evaluate(adapter);
    const values = vm.runInContext(transformed.contents, context)();
    expect(values[0]).toBe("local");
    expect(values[1]["__dirname"]).toBe(`${destination}/native/native-helper@1.0.0/native-helper`);
    expect(values[2]).toBe("bound");
    expect(
      context["__openclawStandaloneNativeResolve"](`${destination}/dist/entry.js`, "native-helper"),
    ).toBe(`${destination}/native/native-helper@1.0.0/native-helper/binding.node`);
    expect(
      context["__openclawStandaloneNativeResolve"](
        "/external/plugins/example/index.js",
        "native-helper",
      ),
    ).toBeUndefined();
    expect(
      context["__openclawStandaloneNativeResolve"](
        "/external/plugins/example/index.js",
        "./binding.node",
      ),
    ).toBeUndefined();
  });

  it("preserves the separate Copilot runtime contract and package search paths", () => {
    const { root, write, pkg } = fixture();
    const platformName = "@github/copilot-sdk-darwin-arm64";
    const runtime = pkg(
      platformName,
      {},
      {
        "prebuilds/darwin-arm64/runtime.node": "native",
        "prebuilds/darwin-arm64/copilot-runtime": "executable",
        "copilot-sdk/extension.js": "export const external = true;",
        "schemas/api.schema.json": "{}",
        "definitions/task.agent.yaml": "name: task",
        "plugins/computer-use/plugin.json": "{}",
        "assets/unused.png": "excluded by runtime owner",
        "index.js": "excluded by runtime owner",
      },
    );
    const sdk = pkg(
      "@github/copilot-sdk",
      { optionalDependencies: { [platformName]: "1.0.0" } },
      { "dist/runtimeArtifacts.js": "export const url = import.meta.url;" },
    );
    write(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@github/copilot-sdk": "1.0.0" } }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    adapter.transform({
      filename: path.join(sdk, "dist/runtimeArtifacts.js"),
      contents: "export const url = import.meta.url;",
    });
    const { context, finalized, root: destination } = evaluate(adapter);
    const search = context["__openclawStandaloneNativeResolvePaths"](
      path.join(destination, path.relative(root, sdk), "dist/runtimeArtifacts.js"),
      platformName,
    );
    expect(search).toEqual([`${destination}/native/@github+copilot-sdk-darwin-arm64@1.0.0`]);
    expect(
      context["__openclawStandaloneNativeResolvePaths"]("/external/plugin/index.js", platformName),
    ).toBeUndefined();
    const sources = finalized.files.map((file: { source: string }) => file.source);
    expect(sources).toContain(`${path.relative(root, runtime)}/copilot-sdk/extension.js`);
    expect(sources).toContain(`${path.relative(root, runtime)}/definitions/task.agent.yaml`);
    expect(sources).not.toContain(`${path.relative(root, runtime)}/assets/unused.png`);
    expect(sources).not.toContain(`${path.relative(root, runtime)}/index.js`);
    expect(() =>
      adapter.finalize({
        embeddedPaths: {
          [`${path.relative(root, runtime)}/copilot-sdk/extension.js`]: "/$bunfs/duplicate.js",
        },
      }),
    ).toThrow("already embedded");
  });

  it("does not admit installed development prebuilds or resources absent from the runtime graph", () => {
    const { root, write, pkg } = fixture();
    pkg("dev-native", { main: "binding.node" }, { "binding.node": "dev" });
    pkg("unused-native", { main: "binding.node" }, { "binding.node": "unused" });
    write(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "unused-native": "1.0.0" },
        devDependencies: { "dev-native": "1.0.0" },
      }),
    );
    const adapter = createStandaloneNativeAdapter({
      runtimeRoot: root,
      parse,
      platform: "darwin",
      arch: "arm64",
    });
    expect(adapter.finalize().files).toEqual([]);
    expect(adapter.additionalModuleEntries).toEqual([]);
  });
});
