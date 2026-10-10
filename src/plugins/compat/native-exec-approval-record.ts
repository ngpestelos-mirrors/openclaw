import type { PluginCompatRecord } from "./types.js";

export const NATIVE_EXEC_APPROVAL_COMPAT_RECORD = {
  code: "native-approval-and-node-exec-preparation",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-09-04",
  deprecated: "2026-10-09",
  warningStarts: "2026-10-09",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await OpenClawPluginNodeHostCommandContext.prepareExecAuthorizationAsync and host-bound api.runtime.gateway.request approval methods. Use loadExecApprovalsReadOnlyAsync/readExecApprovalsSnapshotAsync for policy preparation. Opaque approval commit guards retain native transaction visibility during compatibility. Final effect-time authority checks remain synchronous and current.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-native-exec-and-approval-preparation",
  surfaces: [
    "OpenClawPluginNodeHostCommandContext.prepareExecAuthorization",
    "exec-approvals-runtime.loadExecApprovals",
    "exec-approvals-runtime.readExecApprovalsSnapshot",
    "GatewayRequestHandlerOptions.sessionMutationCommitGuard for approval methods",
  ],
  diagnostics: ["Shared per-plugin capability-family warning on the selected legacy adapter"],
  tests: [
    "src/node-host/plugin-exec-policy.test.ts",
    "src/plugin-sdk/exec-approval-compat.test.ts",
    "src/gateway/server-plugin-in-process-dispatch.commit-guards.test.ts",
  ],
  releaseNote:
    "Native node execution and bundled approval requests prepare policy and expire approval rows in workers, while released synchronous callback adapters keep their completion and final-authority semantics.",
} as const satisfies PluginCompatRecord;
