import {
  ErrorCodes,
  errorShape,
  validateUsersLinkChannelIdentityParams,
  validateUsersListChannelIdentitiesParams,
  validateUsersUnlinkChannelIdentityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  linkUserChannelIdentity,
  listUserChannelIdentities,
  unlinkUserChannelIdentity,
  UserChannelIdentityConflictError,
} from "../../state/user-channel-identities.js";
import {
  UserProfileNotFoundError,
  UserProfileOwnerError,
} from "../../state/user-profiles-schema.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function identityError(error: unknown) {
  return errorShape(
    error instanceof UserChannelIdentityConflictError ||
      error instanceof UserProfileNotFoundError ||
      error instanceof UserProfileOwnerError
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

export const usersChannelIdentityHandlers: GatewayRequestHandlers = {
  "users.linkChannelIdentity": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateUsersLinkChannelIdentityParams,
        "users.linkChannelIdentity",
        respond,
      )
    ) {
      return;
    }
    try {
      respond(true, linkUserChannelIdentity(params.profileId, params.identity));
    } catch (error) {
      respond(false, undefined, identityError(error));
    }
  },
  "users.unlinkChannelIdentity": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateUsersUnlinkChannelIdentityParams,
        "users.unlinkChannelIdentity",
        respond,
      )
    ) {
      return;
    }
    try {
      respond(true, { removed: unlinkUserChannelIdentity(params.profileId, params.identity) });
    } catch (error) {
      respond(false, undefined, identityError(error));
    }
  },
  "users.listChannelIdentities": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateUsersListChannelIdentitiesParams,
        "users.listChannelIdentities",
        respond,
      )
    ) {
      return;
    }
    try {
      respond(true, { links: listUserChannelIdentities(params.profileId) });
    } catch (error) {
      respond(false, undefined, identityError(error));
    }
  },
};
