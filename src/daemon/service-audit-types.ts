import type { GatewayServiceCommandConfig } from "./service-types.js";

export type GatewayServiceCommand = GatewayServiceCommandConfig | null;

export type ServiceConfigIssue = {
  code: string;
  message: string;
  detail?: string;
  environmentKeys?: string[];
  definitionKey?: string;
  rewriteBlocked?: boolean;
  level?: "recommended" | "aggressive";
};
