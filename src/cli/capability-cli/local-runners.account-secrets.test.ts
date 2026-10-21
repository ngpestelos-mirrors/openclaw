import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { resolveApiKeyForProviderCore } from "../../agents/model-auth.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../secrets/runtime.test-support.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

setupSecretsRuntimeSnapshotTestHooks();

type ProviderEgressParams = { cfg?: OpenClawConfig; config?: OpenClawConfig; agentDir?: string };

const hoisted = vi.hoisted<{
  rawCfg: OpenClawConfig;
  egressAuth: Array<{ source?: string; apiKey?: string }>;
}>(() => ({ rawCfg: {}, egressAuth: [] }));

// Stands in for the provider plugin at its egress boundary: it performs the same
// saved-account auth lookup a real provider runs before sending a request.
function withEgressAuth<T>(result: T) {
  return vi.fn(async (params: ProviderEgressParams) => {
    const { source, apiKey } = await resolveApiKeyForProviderCore({
      provider: "customacct",
      cfg: params.cfg ?? params.config,
      agentDir: params.agentDir,
    });
    hoisted.egressAuth.push({ source, apiKey });
    return result;
  });
}

function mediaMock<T>(output: T) {
  return withEgressAuth({ provider: "customacct", model: "test-model", ...output });
}

vi.mock("../../image-generation/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../image-generation/runtime.js")>()),
  generateImage: mediaMock({ attempts: [], images: [] }),
}));

vi.mock("../../video-generation/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../video-generation/runtime.js")>()),
  generateVideo: mediaMock({ attempts: [], videos: [] }),
}));

vi.mock("../../media-understanding/runtime.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../media-understanding/runtime.js")>()),
    describeImageFile: mediaMock({ text: "synthetic-ok" }),
    describeVideoFile: mediaMock({ text: "synthetic-ok" }),
    transcribeAudioFile: mediaMock({ text: "synthetic-ok" }),
  };
});

vi.mock("../../plugin-sdk/memory-core-bundled-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/memory-core-bundled-runtime.js")>()),
  createEmbeddingProvider: withEgressAuth({
    provider: {
      id: "customacct",
      model: "test-model",
      embedBatch: async (texts: string[]) => texts.map(() => [0.5]),
    },
  }),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => hoisted.rawCfg,
  loadConfig: () => hoisted.rawCfg,
  captureRuntimeConfigAsyncReader: () => async () => hoisted.rawCfg,
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
}));

vi.mock("./output.js", () => ({
  emitJsonOrText: vi.fn(),
  formatEnvelopeForText: vi.fn(),
  providerSummaryText: vi.fn(),
}));

import { registerAudioCapabilityCommands as registerAudio } from "./audio.js";
import { registerEmbeddingCapabilityCommands as registerEmbedding } from "./embedding.js";
import { registerImageCapabilityCommands as registerImage } from "./image.js";
import { registerVideoCapabilityCommands as registerVideo } from "./video.js";

const ENV_ACCOUNT_KEY = "OPENCLAW_TEST_CAPABILITY_ACCOUNT_KEY";
const ACCOUNT_KEY_VALUE = "synthetic-capability-account-key"; // pragma: allowlist secret

async function runLocalCapability(argv: string[], agent = "ops"): Promise<void> {
  const capability = new Command();
  for (const register of [registerImage, registerEmbedding, registerAudio, registerVideo]) {
    register(capability);
  }
  await capability.parseAsync([...argv, "--agent", agent, "--json"], { from: "user" });
}

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-capability-account-",
    env: { [ENV_ACCOUNT_KEY]: ACCOUNT_KEY_VALUE },
  });
  const agentDir = state.agentDir("ops");
  hoisted.rawCfg = {
    agents: {
      defaults: { workspace: join(agentDir, "workspace") },
      entries: { ops: { agentDir } },
    },
    models: {
      providers: {
        customacct: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [] },
      },
    },
  };
  // Production CLI boot pins the authored config as the runtime source first.
  setRuntimeConfigSnapshot(structuredClone(hoisted.rawCfg), structuredClone(hoisted.rawCfg));
  hoisted.egressAuth.length = 0;
  const seeded = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      store.profiles["customacct:saved"] = {
        type: "api_key",
        provider: "customacct",
        keyRef: { source: "env", provider: "default", id: ENV_ACCOUNT_KEY },
      };
      return true;
    },
  });
  expect(seeded).not.toBeNull();
});

afterEach(async () => {
  clearSecretsRuntimeSnapshotState();
  await state.cleanup();
});

it.each([
  ["image generate", ["image", "generate", "--prompt", "a red square"]],
  ["image describe", ["image", "describe", "--file", "input.png"]],
  ["embedding create", ["embedding", "create", "--text", "hello", "--provider", "customacct"]],
  ["audio transcribe", ["audio", "transcribe", "--file", "input.wav"]],
  ["video generate", ["video", "generate", "--prompt", "a red square"]],
  ["video describe", ["video", "describe", "--file", "input.mp4"]],
])("infer %s uses only the durable owner’s saved credential", async (_name, argv) => {
  await runLocalCapability(argv);

  expect(hoisted.egressAuth).toEqual([
    {
      source: "profile:customacct:saved",
      apiKey: ACCOUNT_KEY_VALUE,
    },
  ]);
  hoisted.rawCfg = {
    ...hoisted.rawCfg,
    agents: {
      ...hoisted.rawCfg.agents,
      entries: { restored: { agentDir: state.agentDir("ops") } },
    },
  };
  for (const activeSnapshot of [true, false]) {
    if (!activeSnapshot) {
      clearSecretsRuntimeSnapshotState();
    }
    await expect(runLocalCapability(argv, "restored")).rejects.toThrow(
      "belongs to agent ops; requested agent restored",
    );
    expect(hoisted.egressAuth).toHaveLength(1);
  }
});
