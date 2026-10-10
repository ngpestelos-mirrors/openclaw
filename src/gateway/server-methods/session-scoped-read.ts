import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import {
  hasSessionReadAccessChanged,
  hiddenSessionNotFound,
  sharingIdentity,
} from "../session-sharing-policy.js";
import {
  createSessionListEntryFilter,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Person-owned reads retain visibility, row generation and the physical store through I/O. */
export function retainSessionScopedRead(
  options: GatewayRequestHandlerOptions,
  sessionKey: string,
  agentId: string,
  readOptions: { requireMaterialized?: boolean; allowMetadataChanges?: boolean } = {},
) {
  const authority = readGatewayRequestMutationAuthority(options);
  const actor = resolveGatewayOperatorRoleActor(options.client);
  const profileId = sharingIdentity(options.client, actor)?.id;
  const operatorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const narrow = authority.sessionScope === "operator.sessions.read";
  // Canonical solo owner, admin and system exemptions keep their existing workspace access.
  const initialVisibility = createSessionListEntryFilter({
    client: options.client,
    cfg: (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
  });
  if (!narrow && !initialVisibility) {
    return undefined;
  }
  const binding = captureIncognitoSessionSource({ sessionKey, agentId });
  const read = binding
    ? (() => {
        let released = false;
        const claim =
          "kind" in binding ? undefined : binding.actor.sessions.captureCurrent(sessionKey);
        const entry =
          "kind" in binding ? undefined : binding.actor.sessions.readSharing(sessionKey)?.entry;
        return {
          entry,
          canonicalKey: sessionKey,
          legacyKey: undefined,
          isCurrentAtResponse() {
            if (released) {
              return false;
            }
            binding.admissionSignal?.throwIfAborted();
            if ("kind" in binding) {
              binding.assertCurrent();
              return true;
            }
            binding.actor.assertReadable();
            claim?.assertCurrent();
            const current = binding.actor.sessions.readSharing(sessionKey)?.entry;
            return entry && current
              ? !hasSessionReadAccessChanged(entry, current)
              : entry === current;
          },
          release() {
            released = true;
          },
        };
      })()
    : retainGatewaySessionEntryReadOnly(
        sessionKey,
        agentId,
        readOptions.allowMetadataChanges
          ? (previous, current) => !hasSessionReadAccessChanged(previous, current)
          : undefined,
      );
  const assertCurrent = () => {
    authority.assertCurrent();
    const currentActor = resolveGatewayOperatorRoleActor(options.client);
    const visible = createSessionListEntryFilter({
      client: options.client,
      cfg: (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
    });
    if (
      (narrow &&
        (!operatorProfileId ||
          currentActor?.kind !== "operator" ||
          currentActor.profileId !== operatorProfileId)) ||
      (narrow &&
        !operatorScopeSatisfied("operator.sessions.read", options.client?.connect.scopes ?? [])) ||
      sharingIdentity(options.client, currentActor)?.id !== profileId ||
      (readOptions.requireMaterialized && !read.entry?.sessionId) ||
      !read.isCurrentAtResponse() ||
      (read.entry && visible?.(read.legacyKey ?? read.canonicalKey, read.entry) === false)
    ) {
      throw new SessionMutationAuthorizationChangedError(hiddenSessionNotFound(sessionKey));
    }
  };
  try {
    assertCurrent();
    return { assertCurrent, release: read.release };
  } catch (error) {
    read.release();
    throw error;
  }
}
