import type {
  loadExecApprovals,
  readExecApprovalsSnapshot,
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsSnapshotAsync,
  ExecApprovalsFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { expectTypeOf, it } from "vitest";

it("retains the released exec policy readers and synchronous node and approval guards", () => {
  type NodeContext = NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;
  type ReleasedNodePreparation = (source: "human-approved" | "session-full") => () => void;
  expectTypeOf<
    NonNullable<NodeContext["prepareExecAuthorization"]>
  >().toEqualTypeOf<ReleasedNodePreparation>();
  expectTypeOf<
    NonNullable<GatewayRequestHandlerOptions["sessionMutationCommitGuard"]>
  >().toEqualTypeOf<() => void>();
  expectTypeOf<ReturnType<typeof loadExecApprovals>>().toEqualTypeOf<ExecApprovalsFile>();
  expectTypeOf<
    ReturnType<typeof readExecApprovalsSnapshot>["file"]
  >().toEqualTypeOf<ExecApprovalsFile>();
  expectTypeOf<ReturnType<typeof loadExecApprovalsReadOnlyAsync>>().toEqualTypeOf<
    Promise<ExecApprovalsFile>
  >();
  expectTypeOf<ReturnType<typeof readExecApprovalsSnapshotAsync>>().toEqualTypeOf<
    Promise<ReturnType<typeof readExecApprovalsSnapshot>>
  >();
  expectTypeOf<
    ReturnType<NonNullable<NodeContext["prepareExecAuthorizationAsync"]>>
  >().toEqualTypeOf<Promise<() => void>>();
});
