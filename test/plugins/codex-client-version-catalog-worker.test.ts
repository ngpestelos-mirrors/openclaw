import { afterEach, expect, it } from "vitest";
import {
  rejectInstalledCodexAppServer,
  type InstalledCodexAppServer,
} from "../../extensions/codex/src/app-server/managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "../../extensions/codex/src/app-server/version.js";
import { PROVIDER_ID } from "../../src/agents/prepared-model-catalog-worker.test-support.js";
import { createStaticCatalogSnapshotFixture } from "../../src/agents/test-helpers/prepared-model-catalog-static-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "../../src/agents/test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });
// This thread's per-process Codex selection; the shared test setup seeds it empty.
const gatewayInstalledCodex = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codexInstalledAppServer")
] as {
  selection?: Promise<InstalledCodexAppServer | undefined>;
  selected?: InstalledCodexAppServer;
};

afterEach(() => {
  gatewayInstalledCodex.selection = Promise.resolve(undefined);
  delete gatewayInstalledCodex.selected;
});

it("hands catalog workers the bundled pin once the Gateway rejects the installed Codex", async () => {
  const installed: InstalledCodexAppServer = {
    command: "/opt/npm-global/lib/node_modules/@openai/codex/bin/codex.js",
    nativeCommand: "/opt/npm-global/lib/node_modules/@openai/codex/vendor/codex",
    version: "0.162.1",
  };
  gatewayInstalledCodex.selection = Promise.resolve(installed);
  gatewayInstalledCodex.selected = installed;
  const fixture = await createStaticSnapshot(
    0,
    {},
    { codexNativeOwner: true, reportCodexClientVersion: true },
  );
  const reportedByWorker = async () =>
    (await fixture.snapshot.loadFullModelCatalog!({ refresh: true, wait: true })).entries
      .filter((entry) => entry.provider === PROVIDER_ID && entry.id.startsWith("codex-client-"))
      .map((entry) => entry.id);

  expect(await reportedByWorker()).toEqual([`codex-client-${installed.version}`]);

  // First use: the installed binary fails to start, so Gateway turns run the bundled package.
  expect(rejectInstalledCodexAppServer(installed.command, new Error("spawn EACCES"))).toBe(true);

  expect(await reportedByWorker()).toEqual([`codex-client-${CODEX_APP_SERVER_VERSION}`]);
});
