import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { digestClawValue } from "./digest.js";
export function digestClawMcpServer(server: Record<string, unknown>): string {
  return digestClawValue(canonicalizeConfiguredMcpServer(server));
}
