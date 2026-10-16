import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { parse } from "acorn";
import { afterEach, expect, it } from "vitest";
import { prepareStandaloneNpm } from "../../scripts/lib/bun-standalone-npm.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("dispatches npm installer commands without embedding interactive project tooling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-npm-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const write = (filename: string, contents: string) => {
    const target = path.join(runtimeRoot, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("node_modules/npm/package.json", JSON.stringify({ name: "npm", version: "1.0.0" }));
  write(
    "node_modules/npm/lib/cli.js",
    `const entry = require('node:path').join(__dirname, 'cli/entry.js');
module.exports = process => require(entry)(process);`,
  );
  write(
    "node_modules/npm/lib/cli/entry.js",
    `module.exports = process => require('../commands/' + process.argv[2] + '.js')(process);`,
  );
  write(
    "node_modules/npm/lib/commands/pack.js",
    `module.exports = async process => console.log(JSON.stringify(process.argv.slice(2)));`,
  );
  write("node_modules/npm/bin/npm-cli.js", "throw new Error('Disk CLI must not run');");
  write(
    "node_modules/npm/lib/commands/init.js",
    "throw new Error('Interactive init must not run');",
  );
  const npm = prepareStandaloneNpm({ runtimeRoot, parse });
  expect(npm.moduleEntries).toEqual([
    "standalone-npm-cli.mjs",
    "node_modules/npm/lib/cli.js",
    "node_modules/npm/lib/cli/entry.js",
    "node_modules/npm/lib/commands/pack.js",
  ]);
  expect(npm.commonJsEntries).toEqual(npm.moduleEntries.slice(1));
  const adapted = npm.transform({
    contents: `function resolveBundledNpmCommand(args) { throw new Error('Disk npm is unavailable'); }`,
  });
  const resolved: unknown = vm.runInNewContext(
    `${adapted.contents}; resolveBundledNpmCommand(['pack', 'fixture with spaces', '--ignore-scripts']);`,
    {
      process: { execPath: process.execPath },
      __openclawStandaloneNativePath: (entry: string) => path.join(runtimeRoot, entry),
    },
  );
  const command: [string, ...string[]] = [
    process.execPath,
    path.join(runtimeRoot, "standalone-npm-cli.mjs"),
    "pack",
    "fixture with spaces",
    "--ignore-scripts",
  ];
  expect(resolved).toEqual(command);
  const runtimeBootstrap = path.join(root, "bootstrap.mjs");
  fs.writeFileSync(
    runtimeBootstrap,
    `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(path.join(root, "openclaw"))} });`,
  );
  const launcher = path.join(root, "launcher.mjs");
  const driver = path.join(root, "driver.mjs");
  fs.writeFileSync(
    driver,
    `import fs from "node:fs";
import { createStandaloneEntrySource } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/bun-standalone-entry.mjs")).href)};
fs.writeFileSync(${JSON.stringify(launcher)}, createStandaloneEntrySource(${JSON.stringify({ runtimeRoot, runtimeBootstrap, moduleEntries: npm.moduleEntries, workerEntries: [] })}));
process.argv = ${JSON.stringify([process.execPath, launcher, ...command.slice(1)])};
await import(${JSON.stringify(pathToFileURL(launcher).href)});
`,
  );
  const child = spawnSync(
    command[0],
    ["--import", createRequire(import.meta.url).resolve("tsx"), driver],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(command.slice(2));
});
