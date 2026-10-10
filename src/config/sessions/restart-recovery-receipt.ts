import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasActiveRestartRecoveryDeliveryClaim,
  hasExactRestartRecoveryDeliveryClaim,
  projectRestartRecoveryDeliverySettlement,
  resolveRestartRecoveryTerminalDeliveryDisposition,
} from "./restart-recovery-receipt-state.js";
import { normalizeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import { updateSessionEntry } from "./session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionBinding,
} from "./session-incognito-binding.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryScope = {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
  toolCallId: string;
};

/** Keep steering eligibility aligned with terminal-send ownership, using the exact active source. */
export function resolveRestartRecoverySteeringBlockReason(
  entry: SessionEntry | null | undefined,
  sessionId: string,
  sourceTurnId: string,
):
  | "terminal-pending"
  | "delivered-terminal"
  | "unresolved-terminal-tool"
  | "unknown-source-with-terminal-history"
  | "already-delivered"
  | "delivery-ambiguous"
  | "stale-claim"
  | undefined {
  if (!entry) {
    return undefined;
  }
  if (entry.restartRecoveryDeliveryReceiptState) {
    return entry.restartRecoveryDeliveryReceiptState;
  }
  if (entry.restartRecoveryDeliveryToolCallId) {
    return "unresolved-terminal-tool";
  }
  const normalizedSourceTurnId = normalizeOptionalString(sourceTurnId) ?? "";
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(entry, {
    sessionId,
    sourceTurnId: normalizedSourceTurnId,
  });
  if (disposition === "not-applicable") {
    // Without a known active source, any retained tombstone could belong to it.
    if (
      normalizedSourceTurnId === "" &&
      (normalizeRestartRecoveryTerminalRunIds(entry.restartRecoveryTerminalRunIds)?.length ?? 0) > 0
    ) {
      return "unknown-source-with-terminal-history";
    }
    return undefined;
  }
  return disposition === "already-delivered" || disposition === "delivery-ambiguous"
    ? disposition
    : disposition === "stale"
      ? "stale-claim"
      : undefined;
}

function captureCurrent(input: RestartRecoveryTerminalDeliveryScope) {
  const source = captureIncognitoSessionSource(input);
  const ownerPath = source && ("kind" in source ? source.path : source.actor.path);
  const scope = {
    ...input,
    storePath: ownerPath ?? path.resolve(input.storePath),
    env: captureSessionTranscriptStorageEnvironment(
      ownerPath ? { OPENCLAW_STATE_DIR: path.resolve(ownerPath, "../../../..") } : process.env,
    ),
  };
  return {
    scope,
    absent: source && "kind" in source,
    read() {
      const read = () => readSessionEntryReadOnlyInWorker({ ...scope, readConsistency: "latest" });
      return source && !("kind" in source) ? withIncognitoSessionBinding(source, read) : read();
    },
  };
}

/** Persists ambiguity before a terminal external send is allowed to start. */
export async function beginRestartRecoveryTerminalDelivery(
  input: RestartRecoveryTerminalDeliveryScope,
): Promise<"started" | "already-delivered" | "delivery-ambiguous" | "stale" | "not-applicable"> {
  const current = captureCurrent(input);
  const scope = current.scope;
  if (current.absent) {
    return "stale";
  }
  let started = false;
  const updated = await updateSessionEntry(
    current.scope,
    (entry) => {
      if (resolveRestartRecoveryTerminalDeliveryDisposition(entry, scope) !== "startable") {
        return null;
      }
      started = true;
      return {
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: scope.toolCallId,
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    started &&
    updated !== null &&
    hasExactRestartRecoveryDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "terminal-pending"
  ) {
    return "started";
  }
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(
    await current.read(),
    scope,
  );
  if (disposition === "startable") {
    throw new Error("failed to persist terminal delivery intent");
  }
  return disposition;
}

function updatePendingTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope & { env?: NodeJS.ProcessEnv },
  outcome: "confirmed" | "not-sent",
) {
  return updateSessionEntry(
    scope,
    (entry) => projectRestartRecoveryDeliverySettlement(entry, scope, outcome, Date.now()),
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}

/** Resolves a pre-send ambiguity only after the provider confirms delivery. */
export async function completeRestartRecoveryTerminalDelivery(
  input: RestartRecoveryTerminalDeliveryScope,
): Promise<"recorded" | "stale"> {
  const source = captureCurrent(input);
  const scope = source.scope;
  if (source.absent) {
    return "stale";
  }
  const updated = await updatePendingTerminalDelivery(source.scope, "confirmed");
  if (
    updated !== null &&
    hasExactRestartRecoveryDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  const current = await source.read();
  if (!current || !hasActiveRestartRecoveryDeliveryClaim(current, scope)) {
    return "stale";
  }
  if (
    hasExactRestartRecoveryDeliveryClaim(current, scope) &&
    current.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  throw new Error("failed to persist terminal delivery completion");
}

/** Clears the pre-send intent only when the provider proves no delivery occurred. */
export async function cancelRestartRecoveryTerminalDelivery(
  input: RestartRecoveryTerminalDeliveryScope,
): Promise<"cleared" | "stale"> {
  const source = captureCurrent(input);
  const scope = source.scope;
  if (source.absent) {
    return "stale";
  }
  const updated = await updatePendingTerminalDelivery(source.scope, "not-sent");
  if (
    updated !== null &&
    hasActiveRestartRecoveryDeliveryClaim(updated, scope) &&
    !updated.restartRecoveryDeliveryReceiptState &&
    !updated.restartRecoveryDeliveryToolCallId
  ) {
    return "cleared";
  }
  const current = await source.read();
  if (!current || !hasActiveRestartRecoveryDeliveryClaim(current, scope)) {
    return "stale";
  }
  if (!current.restartRecoveryDeliveryReceiptState && !current.restartRecoveryDeliveryToolCallId) {
    return "cleared";
  }
  if (
    hasExactRestartRecoveryDeliveryClaim(current, scope) &&
    current.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "stale";
  }
  throw new Error("failed to clear terminal delivery intent");
}
