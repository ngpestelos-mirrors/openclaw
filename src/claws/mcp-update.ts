import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { setConfiguredMcpServer, unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  deleteClawMcpServerRef,
  digestClawMcpServer,
  planClawMcpServerRemovalAsync,
  readClawMcpServerRefsAsync,
  readClawMcpServerRefsByNameAsync,
  upsertClawMcpServerRef,
  type PersistedClawMcpServerRef,
  type ClawMcpConfigApplicationOptions,
} from "./mcp.js";
import type { ClawProvenanceWriteOptions } from "./provenance-write.js";
import type { ClawManifest } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";
import { rollbackClawUpdate, runClawSettlement } from "./update-rollback.js";

export type ClawMcpUpdateExecution = {
  rollback: () => Promise<void>;
};

export class ClawMcpUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawMcpUpdateError";
  }
}

export async function applyClawMcpUpdate(
  updatePlan: ClawUpdatePlan,
  targetManifest: ClawManifest,
  options: ClawProvenanceWriteOptions &
    ClawMcpConfigApplicationOptions & {
      config: OpenClawConfig;
      sourceMcpServers: Record<string, Record<string, unknown>>;
      nowMs?: number;
      setServer?: typeof setConfiguredMcpServer;
      unsetServer?: typeof unsetConfiguredMcpServer;
      readRefs?: typeof readClawMcpServerRefsAsync;
      readRefsByName?: typeof readClawMcpServerRefsByNameAsync;
      planRemoval?: (
        ref: PersistedClawMcpServerRef,
        options: OpenClawStateDatabaseOptions,
      ) => Promise<{ action: "remove" | "release" }>;
      upsertRef?: typeof upsertClawMcpServerRef;
      deleteRef?: typeof deleteClawMcpServerRef;
    },
): Promise<ClawMcpUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "mcpServer" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { rollback: async () => undefined };
  }
  const applicationOptions = (authority: ClawProvenanceWriteOptions) => {
    authority.assertCurrent?.();
    const application = options.createConfigApplication?.();
    return application
      ? { configWriteOptions: application.writeOptions, onConfigCommitted: application.confirm }
      : {};
  };
  const setServer = (params: Parameters<typeof setConfiguredMcpServer>[0], authority = options) =>
    (options.setServer ?? setConfiguredMcpServer)({ ...params, ...applicationOptions(authority) });
  const unsetServer = (
    params: Parameters<typeof unsetConfiguredMcpServer>[0],
    authority = options,
  ) =>
    (options.unsetServer ?? unsetConfiguredMcpServer)({
      ...params,
      ...applicationOptions(authority),
    });
  const readRefs = options.readRefs ?? readClawMcpServerRefsAsync;
  const readRefsByName = options.readRefsByName ?? readClawMcpServerRefsByNameAsync;
  const planRemoval = options.planRemoval ?? planClawMcpServerRemovalAsync;
  const upsertRef = options.upsertRef ?? upsertClawMcpServerRef;
  const deleteRef = options.deleteRef ?? deleteClawMcpServerRef;
  const currentServers = normalizeConfiguredMcpServers(options.sourceMcpServers);
  const undo: Array<() => Promise<void>> = [];
  const nowMs = options.nowMs ?? Date.now();
  let configMutationUncertain = false;

  const rollbackOptions = {
    ...options,
    signal: undefined,
    assertCurrent: options.assertSettlementCurrent ?? options.assertCurrent,
  };
  const rollback = () =>
    runClawSettlement(options, () => rollbackClawUpdate(undo, ClawMcpUpdateError));

  try {
    for (const action of actions) {
      await withClawMcpLifecycleLease(action.id, options, async (assertLive, ownedLease) => {
        const updateWriteOptions = {
          ...options,
          lease: ownedLease,
          assertCurrent: () => {
            assertLive();
            options.assertCurrent?.();
          },
        };
        const name = action.id;
        const previousRef = (await readRefs(updatePlan.agentId, options)).find(
          (candidate) => candidate.name === name,
        );
        const previousServer = currentServers[name];
        if (action.action === "add" && (previousServer || previousRef)) {
          throw new ClawMcpUpdateError(
            `MCP server ${JSON.stringify(name)} appeared after planning and was not claimed.`,
          );
        }
        if (previousServer && !previousRef) {
          throw new ClawMcpUpdateError(
            `MCP server ${JSON.stringify(name)} is not owned by this Claw.`,
          );
        }
        if (action.action === "release") {
          if (!previousRef) {
            throw new ClawMcpUpdateError(`MCP reference ${JSON.stringify(name)} disappeared.`);
          }
          const exactLiveConfig =
            previousServer !== undefined &&
            digestClawMcpServer(previousServer) === previousRef.configDigest;
          if (exactLiveConfig && (await planRemoval(previousRef, options)).action !== "release") {
            throw new ClawMcpUpdateError(
              `MCP server ${JSON.stringify(name)} is no longer safely releasable.`,
            );
          }
          await deleteRef(updatePlan.agentId, name, updateWriteOptions);
          undo.push(
            async () =>
              await withClawMcpLifecycleLease(name, rollbackOptions, async (assertOwned, lease) => {
                const writeOptions = {
                  ...rollbackOptions,
                  lease,
                  assertCurrent: () => {
                    assertOwned();
                    rollbackOptions.assertCurrent?.();
                  },
                };
                await upsertRef(previousRef, writeOptions);
              }),
          );
          return;
        }
        if (action.action === "remove") {
          if (!previousServer || !previousRef) {
            throw new ClawMcpUpdateError(`MCP server ${JSON.stringify(name)} disappeared.`);
          }
          if ((await planRemoval(previousRef, options)).action !== "remove") {
            throw new ClawMcpUpdateError(
              `MCP server ${JSON.stringify(name)} gained another owner after planning.`,
            );
          }
          await upsertRef(
            { ...previousRef, status: "pending", updatedAtMs: nowMs },
            updateWriteOptions,
          );
          configMutationUncertain = true;
          const removed = await unsetServer({
            name,
            expectedServer: previousServer,
            recordIndependentOwner: false,
          });
          configMutationUncertain = false;
          if (!removed.ok) {
            configMutationUncertain = true;
            await upsertRef(previousRef, updateWriteOptions);
            configMutationUncertain = false;
            throw new Error(removed.error);
          }
          undo.push(
            async () =>
              await withClawMcpLifecycleLease(name, rollbackOptions, async (assertOwned, lease) => {
                const writeOptions = {
                  ...rollbackOptions,
                  lease,
                  assertCurrent: () => {
                    assertOwned();
                    rollbackOptions.assertCurrent?.();
                  },
                };
                const restored = await setServer(
                  {
                    name,
                    server: previousServer,
                    createOnly: true,
                    recordIndependentOwner: false,
                  },
                  rollbackOptions,
                );
                if (!restored.ok) {
                  throw new Error(restored.error);
                }
                await upsertRef(previousRef, writeOptions);
              }),
          );
          await deleteRef(updatePlan.agentId, name, updateWriteOptions);
          return;
        }

        const targetServer = targetManifest.mcpServers[name];
        if (!targetServer) {
          throw new ClawMcpUpdateError(
            `Target MCP declaration ${JSON.stringify(name)} is missing.`,
          );
        }
        const targetRef: PersistedClawMcpServerRef = {
          schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
          agentId: updatePlan.agentId,
          name,
          configDigest: digestClawMcpServer(targetServer),
          relationship: previousRef?.relationship ?? "managed",
          origin: previousRef?.origin ?? "claw-introduced",
          independentOwner: previousRef?.independentOwner ?? false,
          status: "pending",
          createdAtMs: previousRef?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        };
        await upsertRef(targetRef, updateWriteOptions);
        configMutationUncertain = true;
        const written = await setServer({
          name,
          server: targetServer,
          ...(previousServer ? { expectedServer: previousServer } : { createOnly: true }),
          recordIndependentOwner: false,
        });
        configMutationUncertain = false;
        if (!written.ok) {
          configMutationUncertain = true;
          if (previousRef) {
            await upsertRef(previousRef, updateWriteOptions);
          } else {
            await deleteRef(updatePlan.agentId, name, updateWriteOptions);
          }
          configMutationUncertain = false;
          throw new Error(written.error);
        }
        undo.push(
          async () =>
            await withClawMcpLifecycleLease(name, rollbackOptions, async (assertOwned, lease) => {
              const writeOptions = {
                ...rollbackOptions,
                lease,
                assertCurrent: () => {
                  assertOwned();
                  rollbackOptions.assertCurrent?.();
                },
              };
              const currentRefs = await readRefsByName(name, rollbackOptions);
              const currentOwnRef = currentRefs.find(
                (candidate) => candidate.agentId === updatePlan.agentId,
              );
              const otherOwners = currentRefs.filter(
                (candidate) => candidate.agentId !== updatePlan.agentId,
              );
              if (
                otherOwners.length > 0 ||
                (currentOwnRef?.independentOwner && !targetRef.independentOwner)
              ) {
                throw new Error(
                  `MCP server ${JSON.stringify(name)} gained another owner during rollback; current configuration was retained.`,
                );
              }
              if (previousServer && previousRef) {
                const restored = await setServer(
                  {
                    name,
                    server: previousServer,
                    expectedServer: targetServer,
                    recordIndependentOwner: false,
                  },
                  rollbackOptions,
                );
                if (!restored.ok) {
                  throw new Error(restored.error);
                }
                await upsertRef(previousRef, writeOptions);
              } else {
                const removed = await unsetServer(
                  {
                    name,
                    expectedServer: targetServer,
                    recordIndependentOwner: false,
                  },
                  rollbackOptions,
                );
                if (!removed.ok) {
                  throw new Error(removed.error);
                }
                await deleteRef(updatePlan.agentId, name, writeOptions);
              }
            }),
        );
        await upsertRef({ ...targetRef, status: "complete" }, updateWriteOptions);
      });
    }
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    try {
      await rollback();
    } catch (rollbackError) {
      if (hasSqliteWorkerOutcomeUnknown(rollbackError)) {
        throw rollbackError;
      }
      throw new ClawMcpUpdateError(
        `${coerceErrorMessage(error)}; rollback failed: ${coerceErrorMessage(rollbackError)}`,
        true,
      );
    }
    throw new ClawMcpUpdateError(
      coerceErrorMessage(error),
      configMutationUncertain || (error instanceof ClawMcpUpdateError && error.partial),
    );
  }
  return { rollback };
}
