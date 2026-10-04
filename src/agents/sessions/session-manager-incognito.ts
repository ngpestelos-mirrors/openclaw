import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { toIncognitoManagerCommand } from "../../config/sessions/session-incognito-manager-contract.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import type { SessionTranscriptMaintenanceRead } from "../../config/sessions/session-transcript-hydration.types.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import { captureSessionManagerIncognitoActor } from "./session-manager-incognito-scope.js";

/** SessionManager planning uses the same actor as its subsequent metadata command. */
export function prepareSessionManagerHydration(
  source: SessionTranscriptRuntimeTarget,
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
) {
  const target = captureSessionTranscriptTargetBinding(source);
  const actor = captureSessionManagerIncognitoActor(target);
  if (!actor) {
    return prepareSessionTranscriptHydration(target, limits, signal);
  }
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const lifecycleRevision = actor.sessions.readSharing(target.sessionKey)?.entry?.lifecycleRevision;
  const authority = {
    assertCurrent(this: void) {
      actor.assertCurrent();
      claim.assertCurrent();
      assertOwned();
      signal?.throwIfAborted();
    },
  };
  const { env: _env, ...scope } = withOwnedSessionTranscriptWriterFence(target);
  const admission = resolveSessionTranscriptReadFence(target);
  return {
    target,
    assertCurrent: authority.assertCurrent,
    read: () =>
      actor.sessions.history(
        authority,
        {
          type: "session.history.hydrate",
          input: {
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            lifecycleRevision,
            admission,
            limits,
          },
        },
        signal,
      ),
    readMaintenance: async (request: SessionTranscriptMaintenanceRead) => {
      const reply = await actor.sessions.transcript(
        authority,
        toIncognitoManagerCommand({
          type: "session.metadata.maintenance",
          input: { scope: { ...scope, storePath: actor.path }, request },
        }),
        signal,
      );
      if (!reply.ok) {
        throw new SessionTranscriptWriterClaimReboundError(reply.refusal);
      }
      // SAFETY: this fixed read command returns the maintenance facts in the paired metadata contract.
      return reply.value as import("../../config/sessions/session-transcript-hydration.types.js").SessionTranscriptMaintenanceFacts;
    },
  };
}
