import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  resolveUserChannelIdentity,
  type UserChannelIdentity,
} from "../state/user-channel-identities.js";
import { resolveIdentityOperatorScopes } from "./operator-identity-scopes.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

/** A channel link proves identity, never an independent administrative grant. */
export function resolveChannelOperatorAdmin(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
): string | undefined {
  if (!cfg.gateway?.auth?.identityScopes) {
    return undefined;
  }
  const linked = resolveUserChannelIdentity(identity, stateOptions);
  if (!linked) {
    return undefined;
  }
  const policy = resolveOperatorRolePolicyForAssignment(linked.profileId, linked.role, cfg);
  const authorized =
    (!policy || policy.scopes.includes("operator.admin")) &&
    linked.loginIdentities.some((login) =>
      resolveIdentityOperatorScopes(login, cfg.gateway?.auth?.identityScopes).includes(
        "operator.admin",
      ),
    );
  return authorized ? linked.profileId : undefined;
}
