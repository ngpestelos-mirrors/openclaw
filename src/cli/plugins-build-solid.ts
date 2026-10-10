import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";

type SolidCompiler = {
  transform: (
    source: string,
    options: {
      filename: string;
      generate: "dom";
      dev: false;
      sourceMap: false;
    },
  ) => { code: string };
};

export function createSolidControlUiBuildPlugin(rootDir: string): Plugin {
  let compiler: SolidCompiler | undefined;
  return {
    name: "control-ui-solid",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path: sourcePath }) => {
        if (!compiler) {
          try {
            // SAFETY: The author-installed compiler exposes this public transform API.
            compiler = createRequire(path.join(rootDir, "package.json"))(
              "@solidjs/compiler",
            ) as SolidCompiler;
          } catch (cause) {
            throw new Error(
              "Install @solidjs/compiler in this plugin's devDependencies to build Solid TSX Control UI sources.",
              { cause },
            );
          }
        }
        const source = await fs.readFile(sourcePath, "utf8");
        const result = compiler.transform(source, {
          filename: sourcePath,
          generate: "dom",
          dev: false,
          sourceMap: false,
        });
        return {
          contents: result.code,
          // The native JSX transform preserves TypeScript for esbuild to strip.
          loader: "ts",
          resolveDir: path.dirname(sourcePath),
        };
      });
    },
  };
}
