import fs from "node:fs";
import path from "node:path";

const developmentFile = /(?:\.map|\.d\.[cm]?ts|\.tsbuildinfo)$/;

/** Disk resources have owners; compiled modules never become a second code distribution. */
export function standaloneResourceCategory(name, declaredPluginAssets = new Set()) {
  if (developmentFile.test(name)) {
    return undefined;
  }
  if (name === "LICENSE" || name === "THIRD_PARTY_NOTICES.md") {
    return "licenses";
  }
  if (/^dist\/[^/]+\.LICENSE$/.test(name)) {
    return "licenses";
  }
  if (name.startsWith("docs/reference/templates/") || name.startsWith("dist/export-html/")) {
    return "templates";
  }
  if (name === "docs/docs.json" || (name.startsWith("docs/") && name.endsWith(".md"))) {
    return "docs";
  }
  if (name.startsWith("skills/") || name.startsWith("custodian-skills/")) {
    return "skills";
  }
  if (name.startsWith("dist/control-ui/")) {
    return "controlUi";
  }
  if (name.startsWith("dist/assets/") || name.startsWith("dist/canvas-host/a2ui/")) {
    return "runtimeAssets";
  }
  if (/^dist\/bundled\/[^/]+\/HOOK\.md$/.test(name)) {
    return "hookMetadata";
  }
  if (
    /^(?:dist\/extensions|extensions|packages)\/.+\/(?:package|openclaw\.plugin)\.json$/.test(name)
  ) {
    return "pluginMetadata";
  }
  if (
    /^dist\/extensions\/[^/]+\/(?:assets|skills|bundled-skills|templates|web\/dist|dist\/control-ui|chrome-extension)\//.test(
      name,
    )
  ) {
    return "pluginAssets";
  }
  // Declared host child scripts stay embedded and use the standalone child dispatcher.
  if (declaredPluginAssets.has(name) && !/\.[cm]?js$/.test(name)) {
    return "pluginAssets";
  }
  if (/^dist\/extensions\/[^/]+\/.+\.(?:json|md|sql|wasm)$/.test(name)) {
    return "pluginAssets";
  }
  if (/^dist\/[^/]+\.(?:wasm|ttf|otf)$/.test(name)) {
    return "runtimeAssets";
  }
  if (
    name === "package.json" ||
    name === "openclaw-install-owner.json" ||
    /^dist\/(?:build-info\.json|cli-startup-metadata\.json|channel-catalog\.json|runtime-dependency-ownership\.json|\.buildstamp|\.runtime-postbuildstamp)$/.test(
      name,
    )
  ) {
    return "runtimeMetadata";
  }
  return undefined;
}

function walk(root, callback, relative = "") {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) {
      walk(root, callback, name);
    } else {
      callback(name, item.isSymbolicLink());
    }
  }
}

/** Replace the build snapshot only after compilation, flattening approved resources into files. */
export function pruneStandaloneRuntime(
  root,
  dependencyResources = [],
  declaredPluginAssets = new Set(),
) {
  const resources = new Map();
  let originalFiles = 0;
  let originalBytes = 0;
  let removedSymlinks = 0;
  walk(root, (name, symlink) => {
    if (symlink) {
      removedSymlinks += 1;
    } else {
      originalFiles += 1;
      originalBytes += fs.statSync(path.join(root, name)).size;
    }
    if (name.split("/").includes("node_modules")) {
      return;
    }
    const category = standaloneResourceCategory(name, declaredPluginAssets);
    if (category) {
      resources.set(name, { source: name, category });
    }
  });
  for (const resource of dependencyResources) {
    const { source, destination, category } = resource;
    for (const name of [source, destination]) {
      if (!name || path.posix.isAbsolute(name) || name.split("/").includes("..")) {
        throw new Error(`Invalid standalone resource path: ${name}`);
      }
    }
    if (resources.has(destination)) {
      throw new Error(`Duplicate standalone resource: ${destination}`);
    }
    resources.set(destination, { source, category });
  }
  const minimal = fs.mkdtempSync(path.join(path.dirname(root), ".standalone-resources-"));
  /** @type {Record<string, { files: number, bytes: number }>} */
  const categories = {};
  let retainedFiles = 0;
  let retainedBytes = 0;
  try {
    const canonicalRoot = fs.realpathSync(root) + path.sep;
    for (const [destination, { source, category }] of resources) {
      const filename = fs.realpathSync(path.join(root, source));
      if (!filename.startsWith(canonicalRoot) || !fs.statSync(filename).isFile()) {
        throw new Error(`Standalone resource is not a contained regular file: ${source}`);
      }
      const output = path.join(minimal, destination);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(filename, output, fs.constants.COPYFILE_FICLONE);
      const size = fs.statSync(output).size;
      const counts = (categories[category] ??= { files: 0, bytes: 0 });
      counts.files += 1;
      counts.bytes += size;
      retainedFiles += 1;
      retainedBytes += size;
    }
    fs.rmSync(root, { recursive: true });
    fs.renameSync(minimal, root);
  } finally {
    fs.rmSync(minimal, { recursive: true, force: true });
  }
  return {
    policy: "runtime-resources-v1",
    removedFiles: originalFiles - retainedFiles,
    removedBytes: originalBytes - retainedBytes,
    removedSymlinks,
    categories,
    sidecarPlugins: [],
  };
}
