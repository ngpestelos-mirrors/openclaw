// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "construction-borrow-proof" });
  await resetPreparedModelRuntimeHarness(state);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

it("retains an admitted raw registry while its previous generation releases during preparation", async () => {
  const config = {};
  const registry = createEmptyPluginRegistry();
  const metadata = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
  });
  const input = {
    config,
    agentDir: state.agentDir("default"),
    workspaceDir: state.workspaceDir,
    env: state.env,
    skipCredentials: true,
  };
  const prepare = () =>
    prepareWorkspaceBuildGroup([input], "static", {}, () => registry, undefined, metadata);
  const first = await prepare();
  const releaseFirst = retainPreparedPluginGeneration(first.pluginGeneration);
  const entered = createDeferred();
  const resume = createDeferred();
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return { entries: [] };
  });
  const replacement = prepare();
  void replacement.catch(() => {});
  try {
    await Promise.race([
      entered.promise,
      replacement.then(() => {
        throw new Error("did not pause");
      }),
    ]);
    await releaseFirst();
    resume.resolve();
    await expect(replacement).resolves.toHaveProperty("pluginGeneration.pluginRegistry", registry);
  } finally {
    resume.resolve();
    await Promise.allSettled([
      releaseFirst(),
      replacement.then((result) => retainPreparedPluginGeneration(result.pluginGeneration)()),
    ]);
  }
});
