import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export type QaChannelSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  botUserId?: string;
  botDisplayName?: string;
};

export function applyQaSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: QaChannelSetupInput;
}): OpenClawConfig {
  const nextCfg = structuredClone(params.cfg) as CoreConfig;
  const section = nextCfg.channels?.["qa-channel"] ?? {};
  const accounts = { ...section.accounts };
  const target =
    params.accountId === DEFAULT_ACCOUNT_ID ? { ...section } : { ...accounts[params.accountId] };
  for (const field of ["baseUrl", "botUserId", "botDisplayName"] as const) {
    if (typeof params.input[field] === "string") {
      target[field] = params.input[field];
    }
  }
  nextCfg.channels ??= {};
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    nextCfg.channels["qa-channel"] = target;
  } else {
    accounts[params.accountId] = target;
    nextCfg.channels["qa-channel"] = {
      ...section,
      accounts,
    };
  }
  return nextCfg as OpenClawConfig;
}
