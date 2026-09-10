import { randomBytes } from "node:crypto";

export const CRABBOX_SANDBOX_LEASE_ID_PATTERN = /^cbx_[a-f0-9]{12}$/u;

/**
 * Fixed Crabbox lease IDs are single-use: a stopped lease leaves a terminal
 * tombstone that refuses replay. Each sandbox runtime generation therefore
 * mints its own ID, and the sandbox registry (`registeredRuntimeIds`) carries
 * it across Gateway restarts so warmup replays adopt the live lease.
 */
export function mintCrabboxSandboxLeaseId(): string {
  return `cbx_${randomBytes(6).toString("hex")}`;
}

/** Newest registered runtime first, so the current generation wins. */
export function candidateCrabboxSandboxLeaseIds(
  registeredRuntimeIds: readonly string[] | undefined,
): string[] {
  return (registeredRuntimeIds ?? []).filter((id) => CRABBOX_SANDBOX_LEASE_ID_PATTERN.test(id));
}
