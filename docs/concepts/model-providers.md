---
summary: "Index of the model provider reference: quick rules, Control UI and keys, bundled provider plugins, and custom providers"
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: "Model providers"
sidebarTitle: "Model providers"
---

Reference for **LLM/model providers** (not chat channels like WhatsApp/Telegram). For model selection rules, see [Models](/concepts/models).

This page is an index. The provider reference is documented on four pages, one
per reader job. Open the page that matches your task.

| Page                                                                              | Read it when                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Quick rules](/concepts/model-providers/quick-rules)                              | You need model refs, CLI helpers, or the rules that decide your primary model and OpenAI runtime.                   |
| [Control UI and API keys](/concepts/model-providers/control-ui-and-keys)          | You are configuring providers from Settings -> Models, or setting up multiple API keys and rotation.                |
| [Official provider plugins](/concepts/model-providers/official-provider-plugins)  | You are setting up a bundled provider, or need its id, auth env, example model, and quirks.                         |
| [Custom providers and local runtimes](/concepts/model-providers/custom-providers) | You are configuring a provider through `models.providers`, a custom base URL, a proxy, or a local inference server. |

## When credentials enable a provider

OpenClaw checks whether a provider is enabled for use before resolving credentials
for model requests or authenticated model discovery:

- An explicit `models.providers.<id>` entry permits that provider to use its
  supported credentials.
- Stored auth profiles and native CLI accounts remain bound to their provider.
- An environment variable alone enables a provider only when exactly one distinct
  provider ID directly declares it in the plugin manifest's
  `setup.providers[].envVars`. IDs are compared after trimming and lowercasing;
  auth aliases do not transfer this permission to another provider.
- A key shared by multiple declared providers requires an explicit provider entry
  or a stored profile for the intended provider. This includes OpenCode Zen/Go
  keys, `MINIMAX_API_KEY`, `KIMI_API_KEY`, `KIMICODE_API_KEY`, `OLLAMA_API_KEY`,
  `OPENROUTER_API_KEY`, `STEPFUN_API_KEY`, and Qwen's `QWEN_API_KEY`,
  `DASHSCOPE_API_KEY`, and `MODELSTUDIO_API_KEY`.
- Generic credentials such as `GH_TOKEN`, `GITHUB_TOKEN`, `MODEL_API_KEY`, the AWS
  credential chain, and Google Application Default Credentials do not enable a
  provider by themselves.

Unique provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`OPENAI_API_KEY` still work without a `models.providers` entry. Selecting a model
or setting `discovery.enabled: true` does not grant credential use. Discovery
settings only control catalog discovery; public catalogs remain browsable.

When upgrading, run `openclaw doctor --fix` once to preserve existing shared-key
selections. Doctor adds an env SecretRef for a provider selected as a primary,
fallback, or user-pinned session model. It names the variable and provider in its
notice, never the key value. It does not enroll unselected siblings or use generic
credentials. Later selections need their own explicit binding.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/concepts/model-providers#byteplus-international` still resolves.
Each entry points at the page that now holds the content.

- <a id="quick-rules" />[Quick rules](/concepts/model-providers/quick-rules#quick-rules)
- <a id="model-refs-and-cli-helpers" />[Model refs and CLI helpers](/concepts/model-providers/quick-rules#model-refs-and-cli-helpers)
- <a id="adding-provider-auth-does-not-change-your-primary-model" />[Adding provider auth does not change your primary model](/concepts/model-providers/quick-rules#adding-provider-auth-does-not-change-your-primary-model)
- <a id="openai-provider-runtime-split" />[OpenAI provider/runtime split](/concepts/model-providers/quick-rules#openai-provider-runtime-split)
- <a id="cli-runtimes" />[CLI runtimes](/concepts/model-providers/quick-rules#cli-runtimes)
- <a id="configure-providers-in-the-control-ui" />[Configure providers in the Control UI](/concepts/model-providers/control-ui-and-keys#configure-providers-in-the-control-ui)
- <a id="plugin-owned-provider-behavior" />[Plugin-owned provider behavior](/concepts/model-providers/control-ui-and-keys#plugin-owned-provider-behavior)
- <a id="api-key-rotation" />[API key rotation](/concepts/model-providers/control-ui-and-keys#api-key-rotation)
- <a id="key-sources-and-priority" />[Key sources and priority](/concepts/model-providers/control-ui-and-keys#key-sources-and-priority)
- <a id="when-rotation-kicks-in" />[When rotation kicks in](/concepts/model-providers/control-ui-and-keys#when-rotation-kicks-in)
- <a id="official-provider-plugins" />[Official provider plugins](/concepts/model-providers/official-provider-plugins#official-provider-plugins)
- <a id="openai" />[OpenAI](/concepts/model-providers/official-provider-plugins#openai)
- <a id="anthropic" />[Anthropic](/concepts/model-providers/official-provider-plugins#anthropic)
- <a id="openai-chatgpt%2Fcodex-oauth" /><a id="openai-chatgpt/codex-oauth" />[OpenAI ChatGPT/Codex OAuth](/concepts/model-providers/official-provider-plugins#openai-chatgpt/codex-oauth)
- <a id="other-subscription-style-hosted-options" />[Other subscription-style hosted options](/concepts/model-providers/official-provider-plugins#other-subscription-style-hosted-options)
- <a id="opencode" />[OpenCode](/concepts/model-providers/official-provider-plugins#opencode)
- <a id="google-gemini-(api-key)" /><a id="google-gemini-api-key" />[Google Gemini (API key)](/concepts/model-providers/official-provider-plugins#google-gemini-api-key)
- <a id="google-vertex-and-gemini-cli-runtime" />[Google Vertex and Gemini CLI runtime](/concepts/model-providers/official-provider-plugins#google-vertex-and-gemini-cli-runtime)
- <a id="z.ai-(glm)" /><a id="z-ai-glm" />[Z.AI (GLM)](/concepts/model-providers/official-provider-plugins#z-ai-glm)
- <a id="vercel-ai-gateway" />[Vercel AI Gateway](/concepts/model-providers/official-provider-plugins#vercel-ai-gateway)
- <a id="other-bundled-provider-plugins" />[Other bundled provider plugins](/concepts/model-providers/official-provider-plugins#other-bundled-provider-plugins)
- <a id="quirks-worth-knowing" />[Quirks worth knowing](/concepts/model-providers/official-provider-plugins#quirks-worth-knowing)
- <a id="openrouter" />[OpenRouter](/concepts/model-providers/official-provider-plugins#openrouter)
- <a id="kilo-gateway" />[Kilo Gateway](/concepts/model-providers/official-provider-plugins#kilo-gateway)
- <a id="minimax-1" />[MiniMax (quirks)](/concepts/model-providers/official-provider-plugins#minimax)
- <a id="nvidia" />[NVIDIA](/concepts/model-providers/official-provider-plugins#nvidia)
- <a id="xai" />[xAI](/concepts/model-providers/official-provider-plugins#xai)
- <a id="providers-via-models.providers-(custom%2Fbase-url)" /><a id="providers-via-models-providers-custom/base-url" />[Providers via `models.providers` (custom/base URL)](/concepts/model-providers/custom-providers#providers-via-models-providers-custom/base-url)
- <a id="moonshot-ai-(kimi)" /><a id="moonshot-ai-kimi" />[Moonshot AI (Kimi)](/concepts/model-providers/custom-providers#moonshot-ai-kimi)
- <a id="kimi-coding" />[Kimi Coding](/concepts/model-providers/custom-providers#kimi-coding)
- <a id="volcano-engine-(doubao)" /><a id="volcano-engine-doubao" />[Volcano Engine (Doubao)](/concepts/model-providers/custom-providers#volcano-engine-doubao)
- <a id="standard-models" />[Standard models (Volcano Engine)](/concepts/model-providers/custom-providers#standard-models)
- <a id="coding-models-volcengine-plan" />[Coding models (volcengine-plan)](/concepts/model-providers/custom-providers#coding-models-volcengine-plan)
- <a id="byteplus-(international)" /><a id="byteplus-international" />[BytePlus (International)](/concepts/model-providers/custom-providers#byteplus-international)
- <a id="standard-models-2" />[Standard models (BytePlus)](/concepts/model-providers/custom-providers#standard-models-2)
- <a id="coding-models-byteplus-plan" />[Coding models (byteplus-plan)](/concepts/model-providers/custom-providers#coding-models-byteplus-plan)
- <a id="synthetic" />[Synthetic](/concepts/model-providers/custom-providers#synthetic)
- <a id="minimax" />[MiniMax](/concepts/model-providers/custom-providers#minimax)
- <a id="llama.cpp" /><a id="llama-cpp" />[llama.cpp](/concepts/model-providers/custom-providers#llama-cpp)
- <a id="lm-studio" />[LM Studio](/concepts/model-providers/custom-providers#lm-studio)
- <a id="ollama" />[Ollama](/concepts/model-providers/custom-providers#ollama)
- <a id="vllm" />[vLLM](/concepts/model-providers/custom-providers#vllm)
- <a id="sglang" />[SGLang](/concepts/model-providers/custom-providers#sglang)
- <a id="local-proxies-(lm-studio%2C-vllm%2C-litellm%2C-etc.)" /><a id="local-proxies-lm-studio-vllm-litellm-etc" />[Local proxies (LM Studio, vLLM, LiteLLM, etc.)](/concepts/model-providers/custom-providers#local-proxies-lm-studio-vllm-litellm-etc)
- <a id="default-optional-fields" />[Default optional fields](/concepts/model-providers/custom-providers#default-optional-fields)
- <a id="proxy-route-shaping-rules" />[Proxy-route shaping rules](/concepts/model-providers/custom-providers#proxy-route-shaping-rules)

## CLI examples

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

See also: [Configuration](/gateway/configuration) for full configuration examples.

## Related

- [Configuration reference](/gateway/config-agents#agent-defaults) - model config keys
- [Model failover](/concepts/model-failover) - fallback chains and retry behavior
- [Models](/concepts/models) - model configuration and aliases
- [Providers](/providers) - per-provider setup guides
- [Agent harness plugins](/plugins/sdk-agent-harness) - SDK surface for plugins that replace the embedded agent executor
- [`openclaw models`](/cli/models) - list, select, and authenticate providers from the CLI
