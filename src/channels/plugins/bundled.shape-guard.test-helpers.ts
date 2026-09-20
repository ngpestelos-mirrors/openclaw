import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

const requireModule = createRequire(import.meta.url);

export function mockChannelPluginModuleLoader(): void {
  vi.doMock("./module-loader.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./module-loader.js")>();
    return {
      ...actual,
      loadChannelPluginModule: ({ modulePath }: { modulePath: string }) =>
        requireModule(modulePath),
    };
  });
}

export function makeBundledEsmFixtureRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  return root;
}

export function writeAlphaSdkAliasDistFixture(pluginDir: string, label: string) {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    [
      'import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";',
      "export default defineBundledChannelEntry({",
      "  id: 'alpha',",
      "  name: 'Alpha',",
      "  description: 'Alpha',",
      "  importMetaUrl: import.meta.url,",
      "  plugin: { specifier: './plugin.js', exportName: 'plugin' },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "plugin.js"),
    [
      "export const plugin = {",
      "  id: 'alpha',",
      `  meta: { id: 'alpha', label: '${label}' },`,
      "  capabilities: {},",
      "  config: {},",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}
