import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse } from "acorn";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFrontmatterBlockResult } from "../../packages/markdown-core/src/frontmatter.js";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneMetadataAdapter } from "../../scripts/lib/bun-standalone-metadata.mjs";
import { resolveHookManifestMetadata } from "../../src/hooks/frontmatter.js";
import {
  openRootFileSync,
  readFileDescriptorBoundedSync,
} from "../../src/infra/boundary-file-read.js";
import { PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "../../src/plugins/package-entrypoints.js";
import { openPluginRootFileSync } from "../../src/plugins/path-safety.js";
import { createPluginCacheSdk, getPluginSdkHostFacts } from "../../src/plugins/plugin-cache-sdk.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function ownerSource(relative: string, functionName?: string): string {
  const source = stripTypeScriptTypes(
    fs.readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"),
  );
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  return ast.body
    .flatMap((statement) => {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      return (declaration?.type === "FunctionDeclaration" &&
        (!functionName || declaration.id?.name === functionName)) ||
        (functionName &&
          declaration?.type === "VariableDeclaration" &&
          declaration.declarations.some(
            (entry) => entry.id.type === "Identifier" && entry.id.name === functionName,
          ))
        ? [source.slice(declaration.start, declaration.end)]
        : [];
    })
    .join("\n");
}

function fixture({ withPublicSurfaces = false, minifiedMetadata = false } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-metadata-"));
  temporaryRoots.push(runtime);
  const plugin = path.join(runtime, "dist/extensions/example");
  const sdk = path.join(runtime, "dist/plugin-sdk");
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(sdk, { recursive: true });
  const entry = path.join(plugin, "index.js");
  const doctor = path.join(plugin, "doctor-contract-api.js");
  const sdkEntry = path.join(sdk, "example.js");
  const launcher = path.join(runtime, "openclaw.mjs");
  const bridge = path.join(runtime, "dist/mcp/plugin-tools-serve.js");
  const hookDir = path.join(runtime, "dist/bundled/image-hook");
  const hookHandler = path.join(hookDir, "handler.js");
  const secretEntrypoint = path.join(plugin, "handlers/resolver.js");
  const undeclaredEntrypoint = path.join(plugin, "handlers/other.js");
  const mxc = path.join(runtime, "dist/extensions/mxc");
  const mxcLauncher = path.join(mxc, "mxc-spawn-launcher.mjs");
  const vault = path.join(runtime, "dist/extensions/vault");
  const vaultResolver = path.join(vault, "vault-secret-ref-resolver.js");
  const doctorBytes = Buffer.from("export const contract = { version: 1 };\n");
  fs.writeFileSync(entry, "export default {};\n");
  fs.writeFileSync(doctor, doctorBytes);
  fs.writeFileSync(sdkEntry, 'import "./schema.json";\n');
  fs.writeFileSync(path.join(sdk, "schema.json"), "{}");
  fs.writeFileSync(path.join(plugin, "package.json"), "{}");
  fs.writeFileSync(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      secretProviderIntegrations: {
        example: { command: "${node}", args: ["./handlers/resolver.js"] },
      },
    }),
  );
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "HOOK.md"),
    '---\nname: image-hook\ndescription: Embedded handler\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n',
  );
  fs.mkdirSync(path.dirname(secretEntrypoint));
  fs.mkdirSync(mxc, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  for (const dir of [mxc, vault]) {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}");
  }
  const imageEntries = [
    entry,
    doctor,
    sdkEntry,
    launcher,
    bridge,
    hookHandler,
    secretEntrypoint,
    undeclaredEntrypoint,
    mxcLauncher,
    vaultResolver,
  ];
  const sourceFiles: string[] = [];
  if (withPublicSurfaces) {
    const sourcePlugin = path.join(runtime, "extensions/example");
    fs.mkdirSync(sourcePlugin, { recursive: true });
    fs.writeFileSync(path.join(sourcePlugin, "package.json"), '{"name":"@openclaw/example"}');
    for (const filename of [
      "api.ts",
      "runtime-api.ts",
      "diagnostics-api.mts",
      "test-api.ts",
      "internal.ts",
    ]) {
      const sourceFile = path.join(sourcePlugin, filename);
      sourceFiles.push(sourceFile);
      fs.writeFileSync(sourceFile, "export {};\n");
      imageEntries.push(path.join(plugin, `${path.parse(filename).name}.js`));
    }
    imageEntries.push(path.join(plugin, "unlisted-api.js"));
  }
  for (const file of imageEntries.slice(5)) {
    fs.writeFileSync(file, "export default () => {};\n");
  }
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(launcher, "export {};\n");
  fs.writeFileSync(bridge, "export {};\n");
  fs.writeFileSync(
    path.join(runtime, "dist/sdk-alias-fixture.js"),
    String.raw`const JS_STATIC_RELATIVE_DEPENDENCY_PATTERN = /(?:import|export)\s*['"]([^'"]+)['"]/g;`,
  );
  const embeddedPaths = Object.fromEntries(
    imageEntries.map((file) => [
      path.relative(runtime, file).split(path.sep).join("/"),
      `image:${file}`,
    ]),
  );
  const adapter = createStandaloneMetadataAdapter({ runtimeRoot: runtime, embeddedPaths, parse });
  imageEntries.forEach((file) => fs.unlinkSync(file));
  sourceFiles.forEach((file) => fs.unlinkSync(file));
  const imageFiles = new Set(imageEntries);
  const observedFs = new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        !["readFileSync", "statSync", "lstatSync", "existsSync", "realpathSync"].includes(
          String(property),
        )
      ) {
        return value;
      }
      return (...args: unknown[]) => {
        if (typeof args[0] === "string" && imageFiles.has(args[0])) {
          throw new Error(`Unexpected disk access: ${String(property)} ${args[0]}`);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const roots = new Map<
    string,
    {
      paths: Map<string, unknown>;
      checkedEntries: Map<string, unknown>;
      files: Map<string, unknown>;
    }
  >();
  const getRoot = (name: string) => {
    let root = roots.get(name);
    if (!root) {
      root = { paths: new Map(), checkedEntries: new Map(), files: new Map() };
      roots.set(name, root);
    }
    return root;
  };
  const safeOpen = vi.fn(() => ({ ok: false, reason: "path" }));
  const rootOpen = vi.fn(openRootFileSync);
  const sdkCache = createPluginCacheSdk();
  const context = vm.createContext({
    path,
    URL,
    Buffer,
    crypto,
    fs: observedFs,
    root: runtime,
    __openclawStandaloneRootUrl: pathToFileURL(`${runtime}${path.sep}`).href,
    process,
    DEFAULT_PLUGIN_METADATA_MAX_BYTES: 16 * 1024 * 1024,
    require: createRequire(import.meta.url),
    getPluginCacheRoot: getRoot,
    getPluginCache: () => ({ sdk: sdkCache }),
    getPluginSdkHostFacts,
    isRecord,
    PUBLIC_SURFACE_SOURCE_EXTENSIONS,
    openClawRootFsSync: observedFs,
    fileURLToPath: (value: string) => new URL(value).pathname,
    bindPluginCacheRoot: (name: string) => getRoot(name),
    openPluginRootFileSync: safeOpen,
    openRootFileSync: rootOpen,
    readFileDescriptorBoundedSync,
    parseFrontmatterBlockResult,
    resolveHookManifestMetadata,
    HOOK_METADATA_MAX_BYTES: 1024 * 1024,
    isPathInside: (root: string, target: string) => {
      const relative = path.relative(root, target);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    },
    materializeErrorStack: () => {},
    FsSafeError: class extends Error {},
    safeFileSignature: (name: string) => observedFs.statSync(name),
    safeHashFile: ({ filePath }: { filePath: string }) =>
      crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    normalizeLowercaseStringOrEmpty: (value: string) => value.toLowerCase(),
  });
  vm.runInContext(adapter.bootstrap.replace("import.meta.require(", "require("), context);
  for (const [file, name] of [
    ["src/plugins/plugin-cache-files.ts", undefined],
    ["src/plugins/plugin-registry-snapshot.ts", "fileContentMatches"],
    ["src/plugins/sdk-alias.ts", "checkDistPluginSdkArtifact"],
    ["src/infra/openclaw-root.ts", "candidateDirsFromArgv1"],
    ["src/infra/openclaw-root.ts", "dedupeCandidates"],
    ["extensions/acpx/src/config.ts", undefined],
    ["src/hooks/discovery.ts", "loadHookFromDir"],
    ["src/hooks/discovery.ts", "readRootFileUtf8"],
    ["src/hooks/discovery.ts", "withOpenedRootFileSync"],
    ["src/secrets/provider-integrations.ts", "resolvePluginRelativePath"],
    ["src/secrets/provider-integrations.ts", "isSecurePosixPathStat"],
    ["src/secrets/provider-integrations.ts", "resolveNodeEntrypointArg"],
    ["extensions/mxc/src/plugin-root.ts", undefined],
    ["extensions/vault/src/cli.ts", "resolveResolverScriptPath"],
  ] as const) {
    const source = ownerSource(file, name);
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/owner.js"),
      contents:
        minifiedMetadata && file === "src/plugins/plugin-cache-files.ts"
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source,
    });
    vm.runInContext(
      transformed.contents.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(entry).href)),
      context,
    );
  }
  return {
    runtime,
    plugin,
    sdk,
    entry,
    doctor,
    sdkEntry,
    doctorBytes,
    launcher,
    bridge,
    hookDir,
    hookHandler,
    secretEntrypoint,
    undeclaredEntrypoint,
    mxc,
    mxcLauncher,
    vault,
    vaultResolver,
    safeOpen,
    rootOpen,
    context,
    adapter,
  };
}

describe("standalone image metadata", () => {
  it("leaves prototype-named functions unchanged in minified metadata modules", () => {
    const { runtime, entry, context, adapter } = fixture();
    const source = transformSync(
      `function valueOf(value) { return value + 1; }
       function constructor(value) { return value * 2; }
       ${ownerSource("src/plugins/plugin-cache-files.ts", "pluginCacheExistsSync")}`,
      { minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: true },
    ).code;
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/minified-metadata.js"),
      contents: source,
    });
    vm.runInContext(transformed.contents, context);
    expect(vm.runInContext("[valueOf(4), constructor(3)]", context)).toEqual([5, 6]);
    expect(context.pluginCacheExistsSync(entry)).toBe(true);
  });

  it.each([false, true])(
    "admits embedded plugin sources and caches Doctor bytes (minified=%s)",
    (minifiedMetadata) => {
      const { plugin, entry, doctor, doctorBytes, context, safeOpen } = fixture({
        minifiedMetadata,
      });
      expect(context.pluginCacheExistsSync(entry)).toBe(true);
      expect(context.pluginCacheStatSync(entry).isFile()).toBe(true);
      expect(context.pluginCacheLstatSync(entry).isSymbolicLink()).toBe(false);
      expect(context.pluginCacheRealpathSync(entry)).toBe(entry);
      expect(
        context.checkPluginCacheEntry({
          rootDir: plugin,
          relativePath: "index.js",
          rejectHardlinks: true,
        }),
      ).toEqual({ ok: true, exists: true, path: entry, rootRealPath: plugin });
      const imageRead = vi.fn(context["__openclawStandaloneImageRead"]);
      context["__openclawStandaloneImageRead"] = imageRead;
      const file = context.readPluginCacheFile({
        rootDir: plugin,
        relativePath: "doctor-contract-api.js",
        rejectHardlinks: true,
      });
      expect(file.contents).toEqual(doctorBytes);
      expect(
        context.readPluginCacheFile({
          rootDir: plugin,
          relativePath: "doctor-contract-api.js",
          rejectHardlinks: true,
        }),
      ).toBe(file);
      expect(imageRead).toHaveBeenCalledOnce();
      expect(context.fileContentMatches(doctor, file.hash)).toBe(true);
      expect(context.fileContentMatches(doctor, "different-build")).toBe(false);
      expect(
        context.readPluginCacheFile({
          rootDir: plugin,
          relativePath: "doctor-contract-api.js",
          rejectHardlinks: true,
          maxBytes: 1,
        }).ok,
      ).toBe(false);
      expect(safeOpen).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps external plugin admission physical (minified=%s)",
    (minifiedMetadata) => {
      const { runtime, plugin, context, safeOpen } = fixture({ minifiedMetadata });
      const external = path.join(runtime, "external");
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, "index.js"), "external");
      expect(
        context.checkPluginCacheEntry({
          rootDir: external,
          relativePath: "index.js",
          rejectHardlinks: true,
        }).ok,
      ).toBe(false);
      expect(
        context.checkPluginCacheEntry({
          rootDir: external,
          relativePath: "../dist/extensions/example/index.js",
          rejectHardlinks: true,
        }).ok,
      ).toBe(false);
      const alias = path.join(runtime, "alias");
      fs.symlinkSync(plugin, alias);
      expect(
        context.readPluginCacheFile({
          rootDir: alias,
          relativePath: "doctor-contract-api.js",
          rejectHardlinks: true,
        }).ok,
      ).toBe(false);
      expect(safeOpen).toHaveBeenCalledTimes(3);
    },
  );

  it("preserves public file discovery and checks non-JavaScript SDK dependencies", () => {
    const { plugin, sdk, sdkEntry, context } = fixture();
    const entries = context.readPluginCacheDirectory(plugin);
    expect(entries.map((entry: fs.Dirent) => entry.name).toSorted()).toEqual([
      "doctor-contract-api.js",
      "handlers",
      "index.js",
      "openclaw.plugin.json",
      "package.json",
    ]);
    expect(context.checkDistPluginSdkArtifact(sdkEntry)).toBe(true);
    fs.unlinkSync(path.join(sdk, "schema.json"));
    // The owning metadata cache is stable for a process; use a fresh direct existence reader.
    expect(context["__openclawStandaloneSdkComplete"](sdkEntry, fs.existsSync)).toBe(false);
  });

  it("preserves source-declared package API aliases without source or built JavaScript on disk", () => {
    const { runtime, plugin, context, adapter } = fixture({ withPublicSurfaces: true });
    context.openPluginRootFileSync = openPluginRootFileSync;
    for (const name of [
      "BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN",
      "sdkHost",
      "readSdkJsonFile",
      "readPluginSdkPackageJson",
      "readBundledPluginPackageName",
      "listBundledPluginPublicSurfaceSourceBasenames",
      "resolveBundledPluginPublicSurfaceAliasTarget",
      "normalizeJitiAliasTargetPath",
      "resolveBundledPluginPackagePublicSurfaceAliasMap",
    ]) {
      const transformed = adapter.transform({
        filename: path.join(runtime, "dist/sdk-owner.js"),
        contents: ownerSource("src/plugins/sdk-alias.ts", name),
      });
      vm.runInContext(transformed.contents, context);
    }
    const aliases = (packageRoot: string, includePrivateQa = false) =>
      context.resolveBundledPluginPackagePublicSurfaceAliasMap({
        packageRoot,
        orderedKinds: ["src", "dist"],
        includePrivateQa,
      });
    expect(fs.existsSync(path.join(runtime, "extensions/example/api.ts"))).toBe(false);
    expect(fs.existsSync(path.join(plugin, "api.js"))).toBe(false);
    expect(aliases(runtime)).toEqual({
      "@openclaw/example/api.js": path.join(plugin, "api.js"),
      "@openclaw/example/diagnostics-api.js": path.join(plugin, "diagnostics-api.js"),
      "@openclaw/example/runtime-api.js": path.join(plugin, "runtime-api.js"),
    });
    expect(aliases(runtime, true)).toEqual({
      ...aliases(runtime),
      "@openclaw/example/test-api.js": path.join(plugin, "test-api.js"),
    });

    const externalRoot = path.join(runtime, "external-host");
    const externalPlugin = path.join(externalRoot, "extensions/external");
    fs.mkdirSync(externalPlugin, { recursive: true });
    fs.writeFileSync(path.join(externalPlugin, "package.json"), '{"name":"@openclaw/external"}');
    fs.writeFileSync(path.join(externalPlugin, "api.ts"), "export {};\n");
    expect(aliases(externalRoot)).toEqual({
      "@openclaw/external/api.js": path.join(externalPlugin, "api.ts"),
    });
  });

  it("resolves absent image-only directories without accepting symlink escapes", () => {
    const { runtime, sdk, sdkEntry, context, safeOpen } = fixture();
    fs.unlinkSync(path.join(sdk, "schema.json"));
    fs.rmdirSync(sdk);
    expect(context.pluginCacheExistsSync(sdk)).toBe(true);
    expect(context.pluginCacheStatSync(sdk).isDirectory()).toBe(true);
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const stat = vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => context["__openclawStandaloneImageStat"](sdk)).toThrow(failure);
    } finally {
      stat.mockRestore();
    }
    expect(context.pluginCacheRealpathSync(sdk)).toBe(sdk);
    expect(context.readPluginCacheDirectory(sdk).map((entry: fs.Dirent) => entry.name)).toEqual([
      "example.js",
    ]);
    expect(
      context.checkPluginCacheEntry({
        rootDir: sdk,
        relativePath: "example.js",
        rejectHardlinks: true,
      }),
    ).toEqual({ ok: true, path: sdkEntry, rootRealPath: sdk, exists: true });
    const external = path.join(runtime, "external-sdk");
    fs.mkdirSync(external);
    fs.symlinkSync(external, sdk);
    expect(
      context.checkPluginCacheEntry({
        rootDir: sdk,
        relativePath: "example.js",
        rejectHardlinks: true,
      }).ok,
    ).toBe(false);
    expect(safeOpen).toHaveBeenCalledOnce();
  });

  it("recognizes the filesystem import aliases emitted by bundled chunks", () => {
    const { runtime, plugin, context, adapter } = fixture();
    context.fsSync = context.fs;
    const contents =
      'import fsSync from "node:fs";\n' +
      ownerSource("src/plugins/plugin-cache-files.ts", "readPluginCacheDirectory").replaceAll(
        "fs.readdirSync",
        "fsSync.readdirSync",
      );
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/aliased.js"),
      contents,
    });
    vm.runInContext(transformed.contents.replace('import fsSync from "node:fs";', ""), context);
    expect(
      context
        .readPluginCacheDirectory(plugin)
        .map((entry: fs.Dirent) => entry.name)
        .toSorted(),
    ).toEqual([
      "doctor-contract-api.js",
      "handlers",
      "index.js",
      "openclaw.plugin.json",
      "package.json",
    ]);
  });

  it("preserves physical directory permissions and symlink types in image metadata", () => {
    const { plugin, sdk, runtime, context } = fixture();
    fs.chmodSync(plugin, 0o777);
    expect(context.pluginCacheStatSync(plugin).mode & 0o777).toBe(0o777);
    expect(context.pluginCacheLstatSync(plugin).uid).toBe(fs.lstatSync(plugin).uid);
    fs.unlinkSync(path.join(sdk, "schema.json"));
    fs.rmdirSync(sdk);
    const target = path.join(runtime, "sdk-target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, sdk);
    expect(context.pluginCacheLstatSync(sdk).isSymbolicLink()).toBe(true);
    expect(context.pluginCacheStatSync(sdk).isDirectory()).toBe(true);
  });

  it("discovers and prepares a bundled hook with its handler only in the executable", async () => {
    const { runtime, hookDir, hookHandler, context, adapter, rootOpen } = fixture();
    const entry = context.loadHookFromDir({ hookDir, source: "openclaw-bundled" });
    expect(entry.hook.handlerPath).toBe(hookHandler);
    expect(entry.metadata.events).toEqual(["command:new"]);
    expect(rootOpen.mock.calls.some(([params]) => params.absolutePath === hookHandler)).toBe(false);
    const importHandler = vi.fn(async () => ({ default: () => {} }));
    Object.assign(context, {
      hookOwner: { generation: { registrations: [] } },
      isHookLoadable: () => true,
      resolveInternalHookSelection: async () => ({ configured: true }),
      prepareWorkspaceHookEntries: () => ({ entries: [entry], sources: [] }),
      safeRealpathSync: (name: string) => fs.realpathSync(name),
      openRootFile: async () => {
        throw new Error("Unexpected physical handler open");
      },
      log: { debug: () => {}, warn: () => {} },
      isKnownInternalHookEventKey: () => true,
      resolveFunctionModuleExport: ({ mod }: { mod: { default: unknown } }) => mod.default,
      safeLogValue: (value: string) => value,
      buildImportUrl: (name: string) => pathToFileURL(name).href,
      __openclawStandaloneImport: importHandler,
    });
    const filename = path.join(runtime, "dist/hooks-loader.js");
    const transformed = adapter.transform({
      filename,
      contents: ownerSource("src/hooks/loader.ts", "prepareInternalHooks"),
    });
    vm.runInContext(
      rewriteStandaloneImports({
        ...transformed,
        filename,
        runtimeRoot: runtime,
        embeddedPaths: {},
        moduleAliases: {},
        workerThreadsShim: "",
        parse,
      }),
      context,
    );
    const prepared = await context.prepareInternalHooks({}, runtime);
    expect(prepared.loadedCount).toBe(1);
    expect(importHandler).toHaveBeenCalledWith(
      pathToFileURL(filename).href,
      pathToFileURL(hookHandler).href,
    );

    expect(
      context.loadHookFromDir({ hookDir, source: "openclaw-managed" }).hook.handlerPath,
    ).toBeUndefined();
    const alias = path.join(runtime, "hook-alias");
    fs.symlinkSync(hookDir, alias);
    expect(
      context["__openclawStandaloneHookEntry"]({
        source: "openclaw-bundled",
        rootPath: alias,
        absolutePath: path.join(alias, "handler.js"),
      }),
    ).toBeUndefined();
    expect(
      context["__openclawStandaloneHookEntry"]({
        source: "openclaw-bundled",
        rootPath: path.join(runtime, "external"),
        absolutePath: hookHandler,
      }),
    ).toBeUndefined();
  });

  it("admits declared embedded secret resolvers while retaining physical parent trust", () => {
    const { runtime, plugin, secretEntrypoint, undeclaredEntrypoint, rootOpen, context } =
      fixture();
    const resolve = (pluginRoot: string, entrypoint = "./handlers/resolver.js") =>
      context.resolveNodeEntrypointArg({
        integration: { command: "${node}", args: [entrypoint] },
        pluginRoot,
        rejectHardlinks: true,
      });
    expect(resolve(plugin)).toBe(secretEntrypoint);
    expect(rootOpen).not.toHaveBeenCalled();
    expect(resolve(plugin, "./handlers/other.js")).toBeUndefined();
    expect(rootOpen.mock.calls.at(-1)?.[0].absolutePath).toBe(undeclaredEntrypoint);
    fs.chmodSync(path.dirname(secretEntrypoint), 0o777);
    expect(resolve(plugin)).toBeUndefined();
    fs.chmodSync(path.dirname(secretEntrypoint), 0o755);
    fs.chmodSync(plugin, 0o777);
    expect(resolve(plugin)).toBeUndefined();
    fs.chmodSync(plugin, 0o755);
    expect(resolve(plugin, "../example/handlers/resolver.js")).toBeUndefined();
    const external = path.join(runtime, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "resolver.js"), "export {};\n");
    expect(resolve(external, "./resolver.js")).toBe(path.join(external, "resolver.js"));
    const alias = path.join(runtime, "plugin-alias");
    fs.symlinkSync(plugin, alias);
    expect(resolve(alias)).toBeUndefined();
  });

  it("resolves embedded MXC and Vault child entrypoints without probing JavaScript", async () => {
    const { runtime, mxc, mxcLauncher, vault, vaultResolver, context, adapter } = fixture();
    expect(context.resolveMxcLauncherPath(pathToFileURL(path.join(mxc, "index.js")).href)).toBe(
      mxcLauncher,
    );
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/vault-cli.js"),
      contents: ownerSource("extensions/vault/src/cli.ts", "resolveResolverScriptPath"),
    });
    context.pathExists = async (name: string) => fs.existsSync(name);
    vm.runInContext(
      transformed.contents.replaceAll(
        "import.meta.url",
        JSON.stringify(pathToFileURL(path.join(vault, "src/cli.js")).href),
      ),
      context,
    );
    expect(await context.resolveResolverScriptPath()).toBe(vaultResolver);
  });

  it("keeps embedded launcher and ACPX bridge filename probes off disk", () => {
    const { runtime, launcher, bridge, context } = fixture();
    const acpx = path.join(runtime, "dist/extensions/acpx");
    fs.mkdirSync(acpx, { recursive: true });
    fs.writeFileSync(path.join(acpx, "package.json"), "{}");
    fs.writeFileSync(path.join(acpx, "openclaw.plugin.json"), "{}");
    expect(context.candidateDirsFromArgv1(launcher)).toEqual([runtime]);
    expect(
      context.resolveManagedToolsMcpServerConfig(
        "plugin-tools-serve",
        pathToFileURL(path.join(acpx, "index.js")).href,
      ),
    ).toEqual({ command: process.execPath, args: [bridge] });

    const external = path.join(runtime, "external");
    const externalPlugin = path.join(external, "extensions/acpx");
    fs.mkdirSync(externalPlugin, { recursive: true });
    fs.writeFileSync(path.join(externalPlugin, "package.json"), "{}");
    fs.writeFileSync(path.join(externalPlugin, "openclaw.plugin.json"), "{}");
    expect(
      context.resolveManagedToolsMcpServerConfig(
        "plugin-tools-serve",
        pathToFileURL(path.join(externalPlugin, "index.js")).href,
      ),
    ).toEqual({
      command: process.execPath,
      args: ["--import", "tsx", path.join(external, "src/mcp/plugin-tools-serve.ts")],
    });
    const externalLauncher = path.join(external, "openclaw.mjs");
    fs.writeFileSync(externalLauncher, "external");
    const link = path.join(runtime, "external-launcher");
    fs.symlinkSync(externalLauncher, link);
    expect(context.candidateDirsFromArgv1(link)).toEqual([external, runtime]);
  });
});
