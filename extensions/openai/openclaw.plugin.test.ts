import { describe, expect, it } from "vitest";
import {
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_VARIANT_MODEL_IDS,
} from "./model-route-contract.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createOpenAIProvider } from "./provider-contract-api.js";
import { buildOpenAISetupProvider } from "./setup-api.js";

const WIZARD_METADATA_KEYS = [
  "choiceId",
  "choiceLabel",
  "choiceHint",
  "assistantPriority",
  "assistantVisibility",
  "onboardingFeatured",
  "groupId",
  "groupLabel",
  "groupHint",
] as const;

type Wizard = NonNullable<ReturnType<typeof createOpenAIProvider>["auth"][number]["wizard"]>;
function comparableWizardFields(choice: Wizard) {
  return Object.fromEntries(
    WIZARD_METADATA_KEYS.flatMap((key) => (choice[key] === undefined ? [] : [[key, choice[key]]])),
  );
}

function pick<T, K extends keyof T>(value: T, ...keys: K[]) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function comparableProviderMetadata(provider: ReturnType<typeof createOpenAIProvider>) {
  return {
    ...pick(provider, "id", "label", "hookAliases", "docsPath", "envVars"),
    auth: provider.auth.map((method) => ({
      ...pick(method, "id", "kind", "label", "hint"),
      wizard: comparableWizardFields(method.wizard ?? {}),
    })),
  };
}

const choices = manifest.providerAuthChoices ?? [];
const choice = (id: string) => choices.find((entry) => entry.choiceId === id);
const models = manifest.modelCatalog?.providers?.openai?.models ?? [];
const model = (id: string) => models.find((entry) => entry.id === id);
const sparkSuppression = (provider: string) =>
  manifest.modelCatalog?.suppressions?.find(
    (entry) => entry.provider === provider && entry.model === "gpt-5.3-codex-spark",
  );

describe("OpenAI plugin manifest", () => {
  it("owns canonical OpenAI session route state for Doctor cleanup", () => {
    expect(manifest.sessionRouteStateOwners).toEqual([
      {
        id: "openai",
        label: "OpenAI",
        providerIds: ["openai"],
        authProfilePrefixes: ["openai:"],
      },
    ]);
  });

  it("exposes only current OpenAI login choices", () => {
    expect(choice("openai")).not.toHaveProperty("deprecatedChoiceIds");
  });

  it("routes setup through the OpenAI setup runtime", () => {
    expect("legacyPluginIds" in manifest).toBe(false);
    expect(manifest.setup?.providers?.map((provider) => provider.id)).toEqual(["openai"]);
    expect("providerAuthAliases" in manifest).toBe(false);
  });

  it("classifies ChatGPT backend traffic with the supported OpenAI endpoint class", () => {
    const chatGptEndpoint = manifest.providerEndpoints?.find((endpoint) =>
      endpoint.hosts?.includes("chatgpt.com"),
    );
    expect(chatGptEndpoint?.endpointClass).toBe("openai");
  });

  it("classifies regional API hosts as public OpenAI endpoints", () => {
    const publicEndpoint = manifest.providerEndpoints?.find((endpoint) =>
      endpoint.hosts?.includes("api.openai.com"),
    );
    expect(publicEndpoint?.endpointClass).toBe("openai-public");
    expect(publicEndpoint?.hostSuffixes).toContain(".api.openai.com");
  });

  it("keeps OpenAI media-understanding manifest metadata aligned with runtime audio support", () => {
    expect(manifest.mediaUnderstandingProviderMetadata?.openai).toMatchObject({
      capabilities: ["image", "audio"],
      defaultModels: { image: "gpt-6-astra", audio: "gpt-4o-transcribe" },
      autoPriority: { image: 20, audio: 20 },
    });
  });

  it("keeps million-token OpenAI models on the ordinary runtime budget by default", () => {
    for (const id of [
      ...OPENAI_GPT_56_VARIANT_MODEL_IDS,
      OPENAI_GPT_55_MODEL_ID,
      OPENAI_GPT_55_PRO_MODEL_ID,
    ]) {
      expect(model(id), id).toMatchObject({
        contextTokens: 272_000,
        maxTokens: 128_000,
      });
    }
  });

  it("replaces deprecated GPT-5.5 models with canonical GPT-5.6 Sol", () => {
    for (const id of [OPENAI_GPT_55_MODEL_ID, OPENAI_GPT_55_PRO_MODEL_ID]) {
      expect(model(id)?.replacedBy, id).toBe("gpt-5.6-sol");
    }
  });

  it("labels and orders OpenAI authentication choices", () => {
    const group = {
      groupId: "openai",
      groupLabel: "OpenAI",
      groupHint: "Codex login, Sign in with ChatGPT (Beta), or API key",
    };
    for (const [id, choiceLabel, choiceHint] of [
      ["openai", "Codex login (browser)", "Sign in to Codex locally with your ChatGPT account"],
      [
        "openai-device-code",
        "Codex login (device code)",
        "Use a browser code when OpenClaw runs on a remote VM",
      ],
      ["openai-api-key", "OpenAI API Key", "Use your OpenAI API key directly"],
    ]) {
      expect(choice(id)).toMatchObject({ choiceLabel, choiceHint, ...group });
    }
    for (const id of ["openai", "openai-device-code"]) {
      expect(choice(id)).not.toHaveProperty("assistantVisibility");
    }
    expect(choice("openai-device-code")?.onboardingFeatured).toBe(true);
    expect(choice("openai")?.onboardingFeatured).not.toBe(true);
    expect(choice("openai-token-sharing")).toMatchObject({
      choiceLabel: "Sign in with ChatGPT (Beta)",
      choiceHint: "Authorize OpenClaw for eligible Responses models using your Codex allowance",
    });
    expect(choices.find((entry) => entry.provider === "openai" && entry.method === "api-key")).toBe(
      choice("openai-api-key"),
    );
    expect(
      choices
        .toSorted((a, b) => (a.assistantPriority ?? 0) - (b.assistantPriority ?? 0))
        .map((entry) => entry.choiceId),
    ).toEqual(["openai-device-code", "openai", "openai-token-sharing", "openai-api-key"]);
    expect(choices.map((entry) => entry.choiceLabel)).not.toContain("OpenAI Codex (ChatGPT OAuth)");
    expect(choices.map((entry) => entry.groupHint)).not.toContain("Codex OAuth + API key");
    expect(choices.map((entry) => entry.groupHint)).not.toContain("API key or Codex sign-in");
  });

  it("keeps Spark suppression conditional on direct OpenAI API rows", () => {
    expect(sparkSuppression("openai")?.when).toEqual({
      baseUrlHosts: ["api.openai.com"],
    });
  });

  it("keeps the Azure transport alias and Spark suppression owned by the manifest", () => {
    expect(manifest.modelCatalog?.aliases?.["azure-openai-responses"]).toEqual({
      provider: "openai",
      api: "azure-openai-responses",
    });
    const azureSparkSuppression = sparkSuppression("azure-openai-responses");
    expect(azureSparkSuppression).toMatchObject({
      provider: "azure-openai-responses",
      model: "gpt-5.3-codex-spark",
    });
    expect(azureSparkSuppression).not.toHaveProperty("when");
  });

  it("keeps manifest auth choices aligned with the lightweight provider descriptor", () => {
    const provider = createOpenAIProvider();
    for (const entry of choices) {
      const key = `${entry.provider}:${entry.method}`;
      const method = provider.auth.find((candidate) => candidate.id === entry.method);

      expect(method, key).toBeDefined();
      expect(comparableWizardFields(method?.wizard ?? {}), key).toEqual(
        comparableWizardFields(entry),
      );
    }
  });

  it.each([
    ["setup", buildOpenAISetupProvider],
    ["full runtime", buildOpenAIProvider],
  ])("keeps %s provider metadata on the lightweight descriptor", (_surface, buildProvider) => {
    expect(comparableProviderMetadata(buildProvider())).toEqual(
      comparableProviderMetadata(createOpenAIProvider()),
    );
  });
});
