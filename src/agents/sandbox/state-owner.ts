import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

class SandboxStateOwnerRequiredError extends Error {
  readonly code = "GATEWAY_STATE_OWNER_REQUIRED";

  constructor(cause?: unknown) {
    super(
      "Sandbox workspace preparation requires the current Gateway or retained offline embedded owner " +
        "of the selected state root. Run this SDK call inside the owning Gateway plugin/runtime, " +
        "or stop the Gateway through its service owner and run inside an offline embedded " +
        "lifetime (openclaw agent --local). Keep that owner until workspace use and cleanup finish. " +
        "Inspect openclaw gateway status; this call does not acquire ownership or route remotely.",
      { cause },
    );
    this.name = "SandboxStateOwnerRequiredError";
  }
}

/** Workspace capabilities outlive preparation; their host must already retain root custody. */
export function captureSandboxStateOwner(): () => void {
  const resolveTarget = () =>
    resolveIdentityPathViaExistingAncestorSync(resolveOpenClawStateSqlitePath());
  try {
    const databasePath = resolveTarget();
    const owner = captureGatewayStateOwner(databasePath);
    if (!owner || (owner.role !== "gateway" && owner.role !== "agent-embedded")) {
      throw new SandboxStateOwnerRequiredError();
    }
    return () => {
      try {
        if (resolveTarget() !== databasePath) {
          throw new SandboxStateOwnerRequiredError();
        }
        owner.assertCurrent();
      } catch (error) {
        if (error instanceof SandboxStateOwnerRequiredError) {
          throw error;
        }
        throw new SandboxStateOwnerRequiredError(error);
      }
    };
  } catch (error) {
    if (error instanceof SandboxStateOwnerRequiredError) {
      throw error;
    }
    throw new SandboxStateOwnerRequiredError(error);
  }
}
