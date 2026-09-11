/**
 * BytePlus provider plugin entrypoint for model and video generation providers.
 */
import { buildOpenAICompatibleProviderFamilyCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyProviderConnectionConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  BYTEPLUS_PROVIDER_CATALOG,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
} from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildBytePlusVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "byteplus";
const BYTEPLUS_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "byteplus-plan")!;

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "BytePlus Provider",
  description: "BytePlus provider plugin",
  manifest,
  provider: {
    label: "BytePlus",
    docsPath: "/concepts/model-providers#byteplus-international",
    manifestAuth: {
      defaultModel: BYTEPLUS_DEFAULT_MODEL_REF,
      applyConfig: (cfg) =>
        applyProviderConnectionConfig(cfg, {
          providerId: "byteplus-plan",
          api: "openai-completions",
          baseUrl: BYTEPLUS_CODING_BASE_URL,
          catalogModels: BYTEPLUS_CODING_MODEL_CATALOG,
          aliases: [BYTEPLUS_DEFAULT_MODEL_REF],
        }),
    },
    ...buildOpenAICompatibleProviderFamilyCatalog({
      discoveryMode: "strict",
      entries: BYTEPLUS_PROVIDER_CATALOG.entries,
      staticCatalog: BYTEPLUS_PROVIDER_CATALOG.staticCatalog,
      augmentModelCatalog: BYTEPLUS_PROVIDER_CATALOG.augmentModelCatalog,
    }),
  },
  register(api) {
    api.registerVideoGenerationProvider(buildBytePlusVideoGenerationProvider());
  },
});
