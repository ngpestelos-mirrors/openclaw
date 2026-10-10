import { isControlUiBrowserSupported } from "./browser-capabilities.ts";

type BootImportMeta = ImportMeta & {
  readonly env?: { readonly VITE_OPENCLAW_REQUIRE_MODERN_BROWSER?: string };
};

// Dormant until the Solid cutover release enables this build-time flag.
const REQUIRE_MODERN_BROWSER =
  (import.meta as BootImportMeta).env?.VITE_OPENCLAW_REQUIRE_MODERN_BROWSER === "true";

export const unsupportedControlUiBrowser = REQUIRE_MODERN_BROWSER && !isControlUiBrowserSupported();

if (unsupportedControlUiBrowser) {
  // Both entry and bootstrap depend on this check, including when the bundler
  // moves bootstrap into a shared chunk. Remove the root before registration
  // can start it; the static graph keeps slow downloads under the mount watchdog.
  document.querySelector("openclaw-app")?.remove();
  void import("./unsupported-browser.ts").then(({ showUnsupportedBrowser }) => {
    showUnsupportedBrowser();
  });
}
