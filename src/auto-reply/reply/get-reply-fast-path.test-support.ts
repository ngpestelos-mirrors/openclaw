import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { maybeResolveNativeSlashCommandFastReply } from "./get-reply-native-slash-fast-path.js";
import { markReplyConfigRuntimeMode } from "./reply-config-runtime-mode.js";

type NativeSlashFastReplyParams = Parameters<typeof maybeResolveNativeSlashCommandFastReply>[0];
type NativeSlashFastReplyDefaultKey =
  | "agentDir"
  | "agentCfg"
  | "defaultProvider"
  | "defaultModel"
  | "aliasIndex"
  | "provider"
  | "model"
  | "workspaceDir";

export function createNativeSlashFastReplyParams(
  overrides: Omit<NativeSlashFastReplyParams, NativeSlashFastReplyDefaultKey> &
    Partial<Pick<NativeSlashFastReplyParams, NativeSlashFastReplyDefaultKey>>,
): NativeSlashFastReplyParams {
  return {
    agentDir: "/tmp/agent",
    agentCfg: undefined,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byKey: new Map(), byAlias: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  };
}

export function markCompleteReplyConfig<T extends OpenClawConfig>(
  config: T,
  options?: { runtimeMode?: "fast" | "full" },
): T {
  return markReplyConfigRuntimeMode(config, options?.runtimeMode ?? "fast");
}

export function withFastReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markCompleteReplyConfig(config);
}

export function emptyAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}
