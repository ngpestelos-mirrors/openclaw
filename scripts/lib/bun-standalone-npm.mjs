import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** npm computes its CLI and command filenames; retain those lazy modules as image entries. */
export function prepareStandaloneNpm({ runtimeRoot, parse }) {
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  const npmRoot = path.dirname(require.resolve("npm/package.json"));
  const relative = (filename) => path.relative(runtimeRoot, filename).split(path.sep).join("/");
  const commonJsEntries = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(filename);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        commonJsEntries.push(relative(filename));
      }
    }
  }
  collect(path.join(npmRoot, "lib"));
  const entries = commonJsEntries.toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const cliEntry = "standalone-npm-cli.mjs";
  fs.writeFileSync(
    path.join(runtimeRoot, cliEntry),
    `import cli from ${JSON.stringify(path.join(npmRoot, "lib/cli.js"))};\nawait cli(process);\n`,
  );
  return {
    moduleEntries: [cliEntry, ...entries],
    commonJsEntries: entries,
    transform({ contents: originalContents }) {
      let contents = originalContents;
      if (!contents.includes("resolveBundledNpmCommand")) {
        return { contents, count: 0 };
      }
      const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
      const pending = [ast];
      const edits = [];
      while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object") {
          continue;
        }
        if (node.type === "FunctionDeclaration" && node.id?.name === "resolveBundledNpmCommand") {
          if (node.params.length !== 1 || node.params[0].type !== "Identifier") {
            throw new Error("Unsupported bundled npm command owner");
          }
          edits.push([
            node.body.start,
            node.body.end,
            `{ return [process.execPath, globalThis.__openclawStandaloneNativePath(${JSON.stringify(cliEntry)}), ...${node.params[0].name}]; }`,
          ]);
          continue;
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            pending.push(...value);
          } else if (value && typeof value === "object") {
            pending.push(value);
          }
        }
      }
      for (const [start, end, replacement] of edits.toSorted((a, b) => b[0] - a[0])) {
        contents = contents.slice(0, start) + replacement + contents.slice(end);
      }
      return { contents, count: edits.length };
    },
  };
}
