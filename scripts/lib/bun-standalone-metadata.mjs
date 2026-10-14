import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function visit(node, callback, owner) {
  if (!node || typeof node !== "object") {
    return;
  }
  const current = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(
    node.type,
  )
    ? node
    : owner;
  callback(node, current);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, callback, current));
    } else if (value && typeof value === "object") {
      visit(value, callback, current);
    }
  }
}

/** Keep metadata reads on their existing owners; only immutable image bytes become build facts. */
export function createStandaloneMetadataAdapter({ runtimeRoot, embeddedPaths, parse }) {
  const doctor = {};
  const sdk = {};
  const imageFiles = {};
  const imageDirectories = {};
  const secretEntrypoints = {};
  const pluginRoots = new Set();
  const exportsByFile = new Map();
  // Split worker bundles shorten import locals while retaining their owners in export metadata.
  const resolvesTo = (callee, expected, ast, filename) => {
    if (callee?.type !== "Identifier") {
      return false;
    }
    if (callee.name === expected) {
      return true;
    }
    for (const statement of ast.body) {
      if (statement.type !== "ImportDeclaration" || !statement.source.value.startsWith(".")) {
        continue;
      }
      const imported = statement.specifiers.find(
        (specifier) => specifier.type === "ImportSpecifier" && specifier.local.name === callee.name,
      );
      if (!imported || !filename) {
        continue;
      }
      const target = path.resolve(path.dirname(filename), statement.source.value);
      let exports = exportsByFile.get(target);
      if (!exports) {
        exports = new Map();
        const targetAst = parse(fs.readFileSync(target, "utf8"), {
          ecmaVersion: "latest",
          sourceType: "module",
        });
        for (const node of targetAst.body) {
          if (node.type === "ExportNamedDeclaration" && !node.source) {
            for (const specifier of node.specifiers) {
              exports.set(
                specifier.exported.name ?? specifier.exported.value,
                specifier.local.name,
              );
            }
          }
        }
        exportsByFile.set(target, exports);
      }
      return exports.get(imported.imported.name ?? imported.imported.value) === expected;
    }
    return false;
  };
  const sdkOwner = fs
    .readdirSync(path.join(runtimeRoot, "dist"))
    .find((name) => /^sdk-alias-.*\.[cm]?js$/.test(name));
  if (!sdkOwner) {
    throw new Error("Missing standalone SDK dependency scanner");
  }
  const scannerSource = fs.readFileSync(path.join(runtimeRoot, "dist", sdkOwner), "utf8");
  let dependencyPattern;
  visit(parse(scannerSource, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.name === "JS_STATIC_RELATIVE_DEPENDENCY_PATTERN"
    ) {
      dependencyPattern = node.init?.value;
    }
  });
  if (!(dependencyPattern instanceof RegExp)) {
    throw new Error("Unsupported SDK dependency scanner");
  }
  // SDK aliases enumerate source filenames, then select an embedded built target.
  const extensionsRoot = path.join(runtimeRoot, "extensions");
  if (fs.existsSync(extensionsRoot)) {
    for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      (imageDirectories.extensions ??= {})[entry.name] = "directory";
      const directory = `extensions/${entry.name}`;
      const files = (imageDirectories[directory] ??= {});
      for (const file of fs.readdirSync(path.join(extensionsRoot, entry.name), {
        withFileTypes: true,
      })) {
        if (file.isFile()) {
          files[file.name] = "file";
        }
      }
    }
  }
  for (const entry of Object.keys(embeddedPaths).toSorted()) {
    const pluginRoot = entry.match(/^(dist(?:-runtime)?\/extensions\/[^/]+)\//)?.[1];
    if (pluginRoot) {
      pluginRoots.add(pluginRoot);
    }
    if (/\.[cm]?js$/.test(entry) && !entry.startsWith("../")) {
      imageFiles[entry] = fs.statSync(path.join(runtimeRoot, entry)).size;
      let child = entry;
      for (
        let parent = path.posix.dirname(child);
        parent !== ".";
        parent = path.posix.dirname(child)
      ) {
        (imageDirectories[parent] ??= {})[path.posix.basename(child)] = Object.hasOwn(
          imageFiles,
          child,
        )
          ? "file"
          : "directory";
        child = parent;
      }
    }
    if (
      /^dist(?:-runtime)?\/extensions\/[^/]+\/(?:dist\/)?(?:doctor-contract-api|contract-api)\.[cm]?js$/.test(
        entry,
      )
    ) {
      const bytes = fs.readFileSync(path.join(runtimeRoot, entry));
      doctor[entry] = {
        hash: createHash("sha256").update(bytes).digest("hex"),
        // Preserve the generic metadata cache's real contents contract for any subsequent reader.
        bytes: bytes.toString("base64"),
      };
    }
    if (!/^dist(?:-runtime)?\/plugin-sdk\/.+\.[cm]?js$/.test(entry)) {
      continue;
    }
    const contents = fs.readFileSync(path.join(runtimeRoot, entry), "utf8");
    const assets = [];
    let complete = true;
    for (const match of contents.matchAll(dependencyPattern)) {
      const target = path.resolve(runtimeRoot, path.dirname(entry), match[1]);
      if (!fs.existsSync(target)) {
        complete = false;
        continue;
      }
      const relative = path
        .relative(runtimeRoot, fs.realpathSync(target))
        .split(path.sep)
        .join("/");
      if (/\.[cm]?js$/.test(target)) {
        if (!Object.hasOwn(embeddedPaths, relative)) {
          throw new Error(`SDK dependency missing from image: ${entry} -> ${relative}`);
        }
      } else {
        assets.push(relative);
      }
    }
    sdk[entry] = {
      complete,
      assets: [...new Set(assets)].toSorted((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    };
  }
  for (const pluginRoot of pluginRoots) {
    const manifestPath = path.join(runtimeRoot, pluginRoot, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const integration of Object.values(manifest.secretProviderIntegrations ?? {})) {
      const entrypoint = integration.command === "${node}" && integration.args?.[0];
      if (typeof entrypoint !== "string" || !entrypoint.startsWith("./")) {
        continue;
      }
      const entry = path.posix.normalize(`${pluginRoot}/${entrypoint}`);
      if (entry.startsWith(`${pluginRoot}/`) && Object.hasOwn(imageFiles, entry)) {
        secretEntrypoints[entry] = pluginRoot;
      }
    }
  }
  if (!Object.keys(doctor).length || !Object.keys(sdk).length) {
    throw new Error("Missing standalone Doctor or SDK metadata facts");
  }
  const bootstrap = `(() => {
  const doctor = ${JSON.stringify(doctor)};
  const sdk = ${JSON.stringify(sdk)};
  const imageFiles = ${JSON.stringify(imageFiles)};
  const imageDirectories = ${JSON.stringify(imageDirectories)};
  const secretEntrypoints = ${JSON.stringify(secretEntrypoints)};
  const imageFs = import.meta.require("node:fs");
  const relative = (filename) => typeof filename === "string" && path.isAbsolute(filename)
    ? path.relative(root, filename).split(path.sep).join("/") : undefined;
  const get = (table, filename) => {
    const key = relative(filename);
    return Object.hasOwn(table, key) ? table[key] : undefined;
  };
  const stat = (filename, lstat = false) => {
    const size = get(imageFiles, filename);
    const directory = get(imageDirectories, filename) !== undefined;
    if (size === undefined && !directory) return;
    if (directory) {
      try { return lstat ? imageFs.lstatSync(filename) : imageFs.statSync(filename); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    const value = Object.create(imageFs.Stats.prototype);
    Object.assign(value, { dev: 0, ino: 0, mode: directory ? 0o40555 : 0o100444, nlink: 1, uid: 0, gid: 0,
      rdev: 0, size: size ?? 0, blksize: 4096, blocks: Math.ceil((size ?? 0) / 512),
      atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
      atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0) });
    return value;
  };
  const canonicalDirectory = (directory) => {
    const directoryEntry = relative(directory);
    if (directoryEntry === undefined || directoryEntry === ".." || directoryEntry.startsWith("../")) return;
    const suffix = [];
    let current = directory;
    try {
      const canonicalRuntime = imageFs.realpathSync(root);
      while (true) {
        try {
          const canonical = imageFs.realpathSync(current);
          if (canonical !== path.join(canonicalRuntime, path.relative(root, current))) return;
          return path.join(canonical, ...suffix.toReversed());
        } catch (error) {
          if (error?.code !== "ENOENT" || current === root) return;
          // A dangling symlink is not an absent image directory.
          try { imageFs.lstatSync(current); return; }
          catch (missing) { if (missing?.code !== "ENOENT") return; }
          suffix.push(path.basename(current));
          current = path.dirname(current);
        }
      }
    } catch { return; }
  };
  const scope = (params) => {
    const rootDir = path.resolve(params.rootDir);
    const filename = path.resolve(rootDir, params.relativePath);
    const local = path.relative(rootDir, filename);
    const rootEntry = relative(rootDir);
    if (!local || local === ".." || local.startsWith(".." + path.sep) ||
        path.isAbsolute(local) || rootEntry === undefined || rootEntry === ".." ||
        rootEntry.startsWith("../") || get(imageFiles, filename) === undefined) return;
    // Only image-owned roots can waive source-file admission; installed plugins retain safe opens.
    try {
      const canonicalRoot = canonicalDirectory(rootDir);
      if (canonicalRoot === undefined ||
          (params.rootRealPath !== undefined && path.resolve(params.rootRealPath) !== canonicalRoot)) return;
      return { filename, rootDir: canonicalRoot };
    } catch { return; }
  };
  globalThis.__openclawStandaloneImageStat = stat;
  globalThis.__openclawStandaloneImageLstat = (filename) => stat(filename, true);
  globalThis.__openclawStandaloneImageExists = (filename) =>
    get(imageFiles, filename) !== undefined || get(imageDirectories, filename) !== undefined ? true : undefined;
  globalThis.__openclawStandaloneImageRealpath = (filename) => {
    if (get(imageDirectories, filename) !== undefined) return canonicalDirectory(filename);
    if (get(imageFiles, filename) === undefined) return;
    const parent = canonicalDirectory(path.dirname(filename));
    return parent && path.join(parent, path.basename(filename));
  };
  globalThis.__openclawStandaloneImageDirectory = (directory, read) => {
    const children = get(imageDirectories, directory);
    let existing;
    try { existing = read(); }
    catch (error) {
      if (!children || error?.code !== "ENOENT") throw error;
      existing = [];
    }
    if (!children) return existing;
    const names = new Set(existing.map((entry) => entry.name));
    return [...existing, ...Object.entries(children).filter(([name]) => !names.has(name)).map(([name, kind]) => ({
      name, parentPath: directory, path: directory,
      isFile: () => kind === "file", isDirectory: () => kind === "directory",
      isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
      isFIFO: () => false, isSocket: () => false,
    }))];
  };
  globalThis.__openclawStandaloneImageCheck = (params) => {
    const selected = scope(params);
    return selected && { ok: true, path: selected.filename, rootRealPath: selected.rootDir, exists: true };
  };
  globalThis.__openclawStandaloneHookEntry = (params) => {
    if (params.source !== "openclaw-bundled" ||
        !/^dist(?:-runtime)?\\/bundled\\/[^/]+\\/(?:handler|index)\\.[cm]?js$/.test(relative(params.absolutePath))) return;
    const selected = scope({ rootDir: params.rootPath, relativePath: path.relative(params.rootPath, params.absolutePath) });
    return selected && { ok: true, path: selected.filename };
  };
  globalThis.__openclawStandaloneSecretEntrypoint = (params) => {
    const declaredRoot = get(secretEntrypoints, params.absolutePath);
    if (declaredRoot === undefined || declaredRoot !== relative(params.rootPath)) return;
    const selected = scope({ rootDir: params.rootPath, relativePath: path.relative(params.rootPath, params.absolutePath) });
    return selected && { ok: true, path: selected.filename, rootRealPath: selected.rootDir, stat: stat(selected.filename) };
  };
  globalThis.__openclawStandaloneImageRead = (params) => {
    const selected = scope(params);
    const fact = selected && get(doctor, selected.filename);
    if (!fact) return;
    const contents = Buffer.from(fact.bytes, "base64");
    return { ok: true, path: selected.filename, rootRealPath: selected.rootDir, contents,
      hash: fact.hash, signature: { size: contents.length, mtimeMs: 0, ctimeMs: 0 } };
  };
  globalThis.__openclawStandaloneDoctorHash = (filename) => get(doctor, filename)?.hash;
  globalThis.__openclawStandaloneSdkComplete = (filename, exists) => {
    const fact = get(sdk, filename);
    return fact ? fact.complete && fact.assets.every((asset) => exists(path.join(root, asset))) : undefined;
  };
})();\n`;
  return {
    bootstrap,
    facts: { doctor, sdk },
    transform({ filename, contents }) {
      if (
        !/checkDistPluginSdkArtifact|fileContentMatches|pluginCache(?:Exists|Stat|Lstat|Realpath)Sync|readPluginCache(?:File|Directory)|checkPluginCacheEntry|collectBundledPluginPublicSurfaceArtifacts|resolveBundledPluginGeneratedPath|resolveManagedToolsMcpServerConfig|candidateDirsFromArgv1|resolveHostPackageRoot|loadHookFromDir|prepareInternalHooks|resolveNodeEntrypointArg|resolveMxcLauncherPath|resolveResolverScriptPath/.test(
          contents,
        )
      ) {
        return { contents, count: 0 };
      }
      const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
      const edits = [];
      const slice = (node) => contents.slice(node.start, node.end);
      const fsBindings = new Set(["fs"]);
      for (const statement of ast.body) {
        if (
          statement.type === "ImportDeclaration" &&
          ["node:fs", "fs"].includes(statement.source.value)
        ) {
          for (const specifier of statement.specifiers) {
            if (["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(specifier.type)) {
              fsBindings.add(specifier.local.name);
            }
          }
        }
      }
      const isFsMember = (callee) => {
        let receiver = callee.object;
        if (receiver?.type === "MemberExpression" && receiver.property.name === "default") {
          receiver = receiver.object;
        }
        return receiver?.type === "Identifier" && fsBindings.has(receiver.name);
      };
      const adaptedOwners = new Set();
      visit(ast, (node, owner) => {
        if (node.type === "CallExpression") {
          const ownerName = owner?.id?.name;
          const isHookDiscovery =
            ownerName === "loadHookFromDir" &&
            resolvesTo(node.callee, "withOpenedRootFileSync", ast, filename);
          const isHookLoader =
            ownerName === "prepareInternalHooks" &&
            resolvesTo(node.callee, "openRootFile", ast, filename);
          const isSecretEntrypoint =
            ownerName === "resolveNodeEntrypointArg" &&
            resolvesTo(node.callee, "openRootFileSync", ast, filename);
          if (isHookDiscovery || isHookLoader || isSecretEntrypoint) {
            const options = node.arguments[0];
            if (options?.type !== "ObjectExpression") {
              throw new Error(`Unsupported standalone admission owner: ${ownerName}`);
            }
            let fact;
            if (isSecretEntrypoint) {
              fact = `globalThis.__openclawStandaloneSecretEntrypoint(${slice(options)})`;
            } else {
              const absolute = options.properties.find(
                (property) => property.key?.name === "absolutePath",
              )?.value;
              const source = isHookDiscovery
                ? `${slice(owner.params[0])}.source`
                : absolute?.type === "MemberExpression"
                  ? `${slice(absolute.object)}.source`
                  : undefined;
              if (!source) {
                throw new Error(`Unsupported standalone hook owner: ${ownerName}`);
              }
              fact = `globalThis.__openclawStandaloneHookEntry({ ...${slice(options)}, source: ${source} })`;
              if (isHookDiscovery) {
                fact += "?.path";
              }
            }
            edits.push([node.start, node.end, `(${fact} ?? ${slice(node)})`]);
            adaptedOwners.add(owner);
          }
          if (
            ["prepareInternalHooks", "resolveNodeEntrypointArg"].includes(ownerName) &&
            node.callee.type === "MemberExpression" &&
            isFsMember(node.callee) &&
            node.callee.property.name === "closeSync" &&
            node.arguments[0]?.type === "MemberExpression" &&
            node.arguments[0].property.name === "fd"
          ) {
            edits.push([
              node.start,
              node.end,
              `("fd" in ${slice(node.arguments[0].object)} && ${slice(node)})`,
            ]);
          }
          if (
            ownerName === "resolveResolverScriptPath" &&
            resolvesTo(node.callee, "pathExists", ast, filename)
          ) {
            edits.push([
              node.start,
              node.end,
              `(globalThis.__openclawStandaloneImageExists(${slice(node.arguments[0])}) ?? ${slice(node)})`,
            ]);
          }
        }
        if (node.type === "FunctionDeclaration" && node.params[0]?.type === "Identifier") {
          const parameter = slice(node.params[0]);
          const hook = {
            pluginCacheExistsSync: "ImageExists",
            pluginCacheStatSync: "ImageStat",
            pluginCacheLstatSync: "ImageLstat",
            pluginCacheRealpathSync: "ImageRealpath",
            checkPluginCacheEntry: "ImageCheck",
          }[node.id?.name];
          if (hook) {
            edits.push([
              node.body.start + 1,
              node.body.start + 1,
              `\nconst __imageFact = globalThis.__openclawStandalone${hook}(${parameter});\nif (__imageFact !== undefined) return __imageFact;\n`,
            ]);
          }
          if (node.id?.name === "readPluginCacheFile") {
            const cachedReturn = node.body.body.find(
              (statement) =>
                statement.type === "IfStatement" &&
                statement.test.type === "Identifier" &&
                statement.test.name === "cached",
            );
            if (!cachedReturn) {
              throw new Error("Unsupported standalone metadata read cache");
            }
            edits.push([
              cachedReturn.end,
              cachedReturn.end,
              `\nconst __imageFile = globalThis.__openclawStandaloneImageRead(${parameter});\nif (__imageFile !== undefined) {\nroot = bindPluginCacheRoot(lexicalRoot, __imageFile.rootRealPath);\nroot.files.set(key, __imageFile);\nreturn enforceFileSize(__imageFile, maxBytes);\n}\n`,
            ]);
            adaptedOwners.add(node);
          }
        }
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          isFsMember(node.callee) &&
          node.callee.property.name === "readdirSync" &&
          ["readPluginCacheDirectory", "collectBundledPluginPublicSurfaceArtifacts"].includes(
            owner?.id?.name,
          )
        ) {
          edits.push([
            node.start,
            node.end,
            `globalThis.__openclawStandaloneImageDirectory(${slice(node.arguments[0])}, () => ${slice(node)})`,
          ]);
        }
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          isFsMember(node.callee) &&
          node.callee.property.name === "existsSync" &&
          [
            "resolveBundledPluginGeneratedPath",
            "resolveManagedToolsMcpServerConfig",
            "resolveMxcLauncherPath",
          ].includes(owner?.id?.name)
        ) {
          edits.push([
            node.start,
            node.end,
            `(globalThis.__openclawStandaloneImageExists(${slice(node.arguments[0])}) ?? ${slice(node)})`,
          ]);
        }
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "realpathSync" &&
          ["candidateDirsFromArgv1", "resolveHostPackageRoot"].includes(owner?.id?.name)
        ) {
          edits.push([
            node.start,
            node.end,
            `(globalThis.__openclawStandaloneImageRealpath(${slice(node.arguments[0])}) ?? ${slice(node)})`,
          ]);
        }
        if (node.type !== "FunctionDeclaration") {
          return;
        }
        if (node.id?.name === "checkDistPluginSdkArtifact") {
          const first = node.body.body[0];
          const exists =
            first.test?.type === "UnaryExpression" && first.test.operator === "!"
              ? first.test.argument
              : undefined;
          if (
            first.type !== "IfStatement" ||
            node.params[0]?.type !== "Identifier" ||
            exists?.type !== "CallExpression" ||
            exists.arguments.length !== 1 ||
            slice(exists.arguments[0]) !== slice(node.params[0]) ||
            !resolvesTo(exists.callee, "pluginCacheExistsSync", ast, filename)
          ) {
            throw new Error("Unsupported SDK artifact existence check");
          }
          edits.push([
            first.end,
            first.end,
            `\nconst __imageComplete = globalThis.__openclawStandaloneSdkComplete(${slice(node.params[0])}, ${slice(exists.callee)});\nif (__imageComplete !== undefined) return __imageComplete;\n`,
          ]);
          adaptedOwners.add(node);
        }
        if (node.id?.name === "fileContentMatches") {
          const declaration = node.body.body.find(
            (statement) =>
              statement.type === "VariableDeclaration" &&
              statement.declarations.some(
                (entry) =>
                  entry.init?.type === "CallExpression" &&
                  entry.init.arguments.length === 1 &&
                  slice(entry.init.arguments[0]) === slice(node.params[0]) &&
                  resolvesTo(entry.init.callee, "safeFileSignature", ast, filename),
              ),
          );
          const current = declaration?.declarations.find(
            (entry) =>
              entry.init?.type === "CallExpression" &&
              entry.init.arguments.length === 1 &&
              slice(entry.init.arguments[0]) === slice(node.params[0]) &&
              resolvesTo(entry.init.callee, "safeFileSignature", ast, filename),
          );
          if (
            !current ||
            current.id.type !== "Identifier" ||
            node.params.slice(0, 2).some((param) => param.type !== "Identifier")
          ) {
            throw new Error("Unsupported plugin metadata freshness check");
          }
          // Test the image hash before the physical-signature shortcut, including image replacement.
          edits.push([
            declaration.start,
            declaration.start,
            `const __imageHash = globalThis.__openclawStandaloneDoctorHash(${slice(node.params[0])});\nif (__imageHash !== undefined) return __imageHash === ${slice(node.params[1])};\n`,
          ]);
          adaptedOwners.add(node);
        }
      });
      visit(ast, (node) => {
        if (
          node.type === "FunctionDeclaration" &&
          [
            "readPluginCacheFile",
            "fileContentMatches",
            "checkDistPluginSdkArtifact",
            "loadHookFromDir",
            "prepareInternalHooks",
            "resolveNodeEntrypointArg",
          ].includes(node.id?.name) &&
          !adaptedOwners.has(node)
        ) {
          throw new Error(`Unsupported standalone metadata owner: ${node.id.name}`);
        }
      });
      let transformed = contents;
      for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
        transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
      }
      return { contents: transformed, count: edits.length };
    },
  };
}
