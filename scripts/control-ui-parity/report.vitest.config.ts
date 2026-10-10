import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "../../test/vitest/vitest.shared.config.ts";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ["scripts/control-ui-parity/report.test.ts"],
    environment: "node",
    setupFiles: [],
  },
});
