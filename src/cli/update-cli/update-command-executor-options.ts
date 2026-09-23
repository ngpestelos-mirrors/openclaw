import path from "node:path";
import type { UpdateInitialStoreTransport } from "../../infra/update-initial-store-transport.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { LegacyUpdateExecutorParent } from "./update-command-executor-legacy.js";
import type { ManagedUpdateLeaseAuthority } from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export type UpdateCommandExecutorOptions = { initialStores?: UpdateInitialStoreTransport } & (
  | {
      /** Location only: direct admission must still acquire its own live owner. */
      directOriginal: { databasePath: string };
      existingAuthority?: never;
      legacyManagedParent?: never;
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      directOriginal?: never;
      existingAuthority: Omit<ManagedUpdateLeaseAuthority, "owner">;
      legacyManagedParent?: never;
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      directOriginal?: never;
      existingAuthority?: never;
      legacyManagedParent: { runId: string; handoffId: string; root: string };
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      directOriginal?: never;
      existingAuthority?: never;
      legacyManagedParent?: never;
      legacyPackageParent: Extract<LegacyUpdateExecutorParent, { kind: "package" }>["identity"];
      legacyPackageHandoff?: { handoffId: string; root: string };
    }
);

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; activationTimeoutMs?: number; serviceRoot?: string },
  ): Promise<UpdateRecoveryFence>;
};

export function captureUpdateCommandDirectLocation(options?: UpdateCommandExecutorOptions) {
  // Snapshot the explicit location before asynchronous work; invalid input never defaults.
  const directDatabasePath = options?.directOriginal?.databasePath;
  if (
    options?.directOriginal !== undefined &&
    (typeof directDatabasePath !== "string" ||
      !path.isAbsolute(directDatabasePath) ||
      options.existingAuthority !== undefined ||
      options.legacyManagedParent !== undefined ||
      options.legacyPackageParent !== undefined ||
      options.legacyPackageHandoff !== undefined)
  ) {
    throw new UpdateCommandRecoveryPendingError("Invalid direct original custody location.");
  }
  return directDatabasePath;
}
