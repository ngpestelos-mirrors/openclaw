// @vitest-environment node
import { build } from "vite";
import { expect, it } from "vitest";
import { controlUiNavigationPreloadsPlugin } from "../../config/control-ui-navigation-preloads.ts";

it("describes the emitted static JS/CSS graph without importing optional dynamic code", async () => {
  const modules: Record<string, string> = {
    "/entry.js": 'globalThis.page = () => import("/fixture/ui/src/pages/claws/page.tsx");',
    "/fixture/ui/src/pages/claws/page.tsx":
      'import "/page.css"; import "/shared.js"; export const dialog = () => import("/dialog.js");',
    "/page.css": ".claws-page { color: red; }",
    "/shared.js": "globalThis.sharedLoaded = true;",
    "/dialog.js": "globalThis.dialogLoaded = true;",
  };
  const built = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "navigation-fixture",
        resolveId: (id) => (id in modules ? id : undefined),
        load: (id) => modules[id],
      },
      controlUiNavigationPreloadsPlugin(),
    ],
    build: { write: false, rolldownOptions: { input: "/entry.js" } },
  });
  if (Array.isArray(built) || !("output" in built)) {
    throw new Error("Expected one production bundle");
  }
  const descriptor = built.output.find(
    (file) => file.type === "asset" && file.names.includes("navigation-preloads.json"),
  );
  if (!descriptor || descriptor.type !== "asset") {
    throw new Error("Missing navigation descriptor");
  }
  const manifest: Record<string, string[]> = JSON.parse(String(descriptor.source));
  const page = built.output.find(
    (file) => file.type === "chunk" && "/fixture/ui/src/pages/claws/page.tsx" in file.modules,
  );
  const dialog = built.output.find((file) => file.type === "chunk" && "/dialog.js" in file.modules);
  expect(manifest.claws).toContain(page?.fileName);
  expect(manifest.claws?.some((file) => file.endsWith(".css"))).toBe(true);
  expect(manifest.claws).not.toContain(dialog?.fileName);
  expect(descriptor.fileName).toMatch(/^assets\/navigation-preloads-[\w-]+\.json$/u);
});
