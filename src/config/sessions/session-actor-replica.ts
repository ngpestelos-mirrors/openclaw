import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { sessionChangeAffectsStoredRow } from "../../sessions/session-row-facts.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "../../state/openclaw-agent-execution-contract.js";
import type {
  SessionActorCommandContext,
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorTarget,
  SessionActorVersion,
} from "./session-actor-contract.js";

type FileTarget = SessionActorTarget & { database: AgentDatabaseExecutionFileIdentity };
type EphemeralTarget = SessionActorTarget & { database: AgentDatabaseIncognitoIdentity };

function sameVersion(left: SessionActorVersion, right: SessionActorVersion): boolean {
  return left.epoch === right.epoch && left.sequence === right.sequence;
}

/**
 * A replica retains one actor's complete committed postimage. The host owns its
 * residency and closes it when releasing the actor; it never becomes a writer.
 */
export function createSessionActorReplica(
  params: { lifetime: SessionActorLifetime } & (
    | { target: FileTarget; currentWriteToken?: never }
    | { target: EphemeralTarget; currentWriteToken: () => string | undefined }
  ),
) {
  const target = freezeJsonSnapshot(structuredClone(params.target));
  let snapshot: SessionActorHotState | undefined;
  let reservation = 0;
  let closed = false;

  const invalidate = () => {
    reservation += 1;
    snapshot = undefined;
  };
  const currentToken = (): string | undefined => {
    const database = target.database;
    if (database.kind === "ephemeral") {
      return params.currentWriteToken?.();
    }
    try {
      const identity = readDatabasePathIdentitySync(database.nativeLocation);
      if (
        identity.key !== `file:${database.physicalIdentity}` ||
        (database.birthtime !== undefined && identity.birthtime !== database.birthtime)
      ) {
        return undefined;
      }
      return readSqliteDatabaseWriteTokenForPath(database.nativeLocation);
    } catch {
      return undefined;
    }
  };
  const accepts = (state: SessionActorHotState): boolean => {
    const database = state.target.database;
    const sameDatabase =
      database.kind === "file" && target.database.kind === "file"
        ? database.physicalIdentity === target.database.physicalIdentity &&
          database.birthtime === target.database.birthtime
        : database.kind === "ephemeral" &&
          target.database.kind === "ephemeral" &&
          database.handle === target.database.handle &&
          database.incarnation === target.database.incarnation;
    return (
      sameDatabase &&
      state.target.sessionKey === target.sessionKey &&
      state.version.epoch.length > 0 &&
      Number.isSafeInteger(state.version.sequence) &&
      state.version.sequence >= 0 &&
      state.writeToken.length > 0 &&
      state.writeToken === currentToken()
    );
  };
  const install = (state: SessionActorHotState): boolean => {
    if (!accepts(state)) {
      snapshot = undefined;
      return false;
    }
    const detached = freezeJsonSnapshot(structuredClone(state));
    if (!accepts(detached)) {
      snapshot = undefined;
      return false;
    }
    snapshot = detached;
    return true;
  };
  const begin = () => {
    params.lifetime.assertCurrent();
    if (closed) {
      throw new Error("Session actor replica is closed");
    }
    invalidate();
    const selected = reservation;
    let settled = false;
    return () => {
      if (settled) {
        return false;
      }
      settled = true;
      return selected === reservation;
    };
  };
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      target.database.kind === "file" &&
      sessionChangeAffectsStoredRow(change, {
        sessionKeys: [target.sessionKey],
        storePaths: new Set([target.database.nativeLocation]),
        databaseIdentities: new Set([target.database.physicalIdentity]),
      })
    ) {
      if (change.factsInvalidated) {
        invalidate();
      } else {
        // The command's own partial publications precede its full receipt. Drop
        // retained rows without cancelling that receipt; its native token still
        // rejects a postimage superseded by another writer.
        snapshot = undefined;
      }
    }
  });

  return {
    /** The host joins the physical writer FIFO before consuming retained facts. */
    read(): SessionActorHotState | undefined {
      params.lifetime.assertReadable();
      if (closed || !snapshot) {
        return undefined;
      }
      if (!accepts(snapshot)) {
        invalidate();
        return undefined;
      }
      return structuredClone(snapshot);
    },
    /** Reserve before dispatch; only that read may install a new owner epoch. */
    beginRead() {
      const settle = begin();
      return {
        install(state: SessionActorHotState): boolean {
          return settle() && install(state);
        },
        cancel(): void {
          settle();
        },
      };
    },
    /** Native commit evidence settles independently of the ordinary command reply. */
    beginCommand(
      command: Pick<SessionActorCommandContext, "commandId" | "phaseId" | "expected"> & {
        phase: SessionActorPhase;
      },
    ) {
      const previous = snapshot;
      const captured = structuredClone(command);
      const settle = begin();
      return {
        settle<Value>(outcome: SessionActorOutcome<Value>): boolean {
          if (!settle()) {
            return false;
          }
          if (outcome.kind === "rolled-back") {
            return previous !== undefined && install(previous);
          }
          if (outcome.kind === "unknown") {
            snapshot = undefined;
            return false;
          }
          const { receipt } = outcome;
          const version = receipt.postimage.version;
          if (
            receipt.commandId !== captured.commandId ||
            receipt.phaseId !== captured.phaseId ||
            receipt.phase !== captured.phase ||
            !sameVersion(receipt.beforeVersion, captured.expected) ||
            !sameVersion(receipt.afterVersion, version) ||
            version.epoch !== captured.expected.epoch ||
            version.sequence !== captured.expected.sequence + 1
          ) {
            snapshot = undefined;
            return false;
          }
          // Closing revokes disclosure, not custody of a previously accepted commit.
          return install(receipt.postimage);
        },
      };
    },
    invalidate,
    close(): void {
      closed = true;
      snapshot = undefined;
      unsubscribe();
    },
  };
}
