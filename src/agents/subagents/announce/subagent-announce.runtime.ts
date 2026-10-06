import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { callGateway as GatewayCaller } from "../../../gateway/call.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
export { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
export { getRuntimeConfig } from "../../../config/config.js";
export { resolveSessionStorePathCore } from "../../../config/sessions.js";

export function readSubagentSessionEntry(storePath: string, sessionKey: string, agentId?: string) {
  return loadSessionEntry({ storePath, sessionKey, agentId });
}
export const callSubagentLifecycleGateway: typeof GatewayCaller = (request) =>
  bindGatewayLifecycleRequest()(request);
export { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
export {
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../embedded-agent-runner/runs.js";
