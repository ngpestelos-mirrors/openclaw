import type { IndexHtmlTransformContext, Plugin } from "vite";
import { collectControlUiStaticAssets } from "./control-ui-boot-preloads.ts";

// Critical component entries only; never walk optional dynamic imports such as
// editors, terminals, or plugin runtimes from a page's static graph.
const entries = {
  "new-session": [
    "pages/new-session/new-session-page-entry.ts",
    "pages/new-session/creation-composer-render.tsx",
  ],
  claws: ["pages/claws/page.tsx"],
  dashboards: ["pages/dashboards/dashboards-page.tsx"],
  usage: ["pages/usage/usage-page.tsx"],
  cron: ["pages/cron/cron-page-entry.tsx", "pages/cron/cron-page.tsx"],
  sessions: ["pages/sessions/sessions-page.tsx"],
  systems: ["pages/systems/systems-route-view.tsx"],
  activity: ["pages/activity/activity-route.tsx"],
  meetings: ["pages/meetings/meetings-page.tsx"],
  plugins: ["pages/plugins/plugins-page.tsx"],
  apps: ["pages/apps/apps-page.tsx"],
  portals: ["pages/portals/portals-page.tsx"],
  palette: ["components/command-palette.tsx"],
  "model-picker": ["pages/chat/components/chat-model-picker-panel.tsx"],
  shortcuts: ["components/keyboard-shortcuts-dialog.tsx"],
  debug: ["pages/debug/debug-overlay.tsx", "pages/debug/debug-overlay-content.tsx"],
};

export function collectControlUiNavigationPreloads(
  bundle: NonNullable<IndexHtmlTransformContext["bundle"]>,
): Record<string, string[]> {
  const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
  const result: Record<string, string[]> = {};
  for (const [name, sources] of Object.entries(entries)) {
    const assets = new Set<string>();
    for (const source of sources) {
      const chunk = chunks.find((candidate) =>
        Object.keys(candidate.modules).some((id) => id.endsWith(`/ui/src/${source}`)),
      );
      if (chunk) {
        collectControlUiStaticAssets(bundle, chunk.fileName, assets);
      }
    }
    if (assets.size) {
      result[name] = [...assets].filter((file) => /\.(?:js|css)$/u.test(file));
    }
  }
  return result;
}

/** A hashed, deferred descriptor keeps route URLs and libraries out of startup. */
export function controlUiNavigationPreloadsPlugin(): Plugin {
  let fileName: string | undefined;
  return {
    name: "control-ui-navigation-preloads",
    apply: "build",
    generateBundle: {
      order: "pre",
      handler(_options, bundle) {
        const manifest = collectControlUiNavigationPreloads(bundle);
        if (Object.keys(manifest).length) {
          fileName = this.getFileName(
            this.emitFile({
              type: "asset",
              name: "navigation-preloads.json",
              source: JSON.stringify(manifest),
            }),
          );
        }
      },
    },
    transformIndexHtml: {
      order: "post",
      handler() {
        return fileName
          ? [
              {
                tag: "meta",
                attrs: { id: "openclaw-navigation-preloads", content: fileName },
                injectTo: "head",
              },
            ]
          : [];
      },
    },
  };
}
