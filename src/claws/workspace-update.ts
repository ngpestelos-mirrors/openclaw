import { resolve, sep } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { clawWorkspaceActionsById } from "./application-provenance.js";
import { digestClawBytes } from "./digest.js";
import type { ClawAddPlan } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";
import {
  rollbackClawUpdate,
  runClawSettlement,
  type ClawSettlementOptions,
} from "./update-rollback.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  deleteClawWorkspaceFileRecordAsync,
  readClawWorkspaceFilesAsync,
  readClawWorkspaceActionSource,
  upsertClawWorkspaceFileAsync,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

const MAX_UPDATE_FILE_BYTES = 1024 * 1024;

export type ClawWorkspaceUpdateExecution = {
  rollback: () => Promise<void>;
};

export class ClawWorkspaceUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawWorkspaceUpdateError";
  }
}

export async function applyClawWorkspaceUpdate(
  updatePlan: ClawUpdatePlan,
  targetAddPlan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & ClawSettlementOptions & { nowMs?: number } = {},
): Promise<ClawWorkspaceUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "workspaceFile" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { rollback: async () => undefined };
  }
  const workspaceRoot = resolve(targetAddPlan.agent.workspace);
  const packageRoot = resolve(targetAddPlan.claw.packageRoot);
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_UPDATE_FILE_BYTES,
    symlinks: "reject",
  });
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_UPDATE_FILE_BYTES,
    symlinks: "reject",
  });
  const currentRefs = new Map(
    (await readClawWorkspaceFilesAsync(updatePlan.agentId, options)).map((record) => [
      record.path,
      record,
    ]),
  );
  const targetActions = clawWorkspaceActionsById(targetAddPlan.actions);
  const undo: Array<() => Promise<void>> = [];

  const rollbackOptions = {
    ...options,
    assertCurrent: options.assertSettlementCurrent ?? options.assertCurrent,
  };
  const rollback = () =>
    runClawSettlement(options, () => rollbackClawUpdate(undo, ClawWorkspaceUpdateError, true));

  try {
    for (const action of actions) {
      const path = action.id;
      const previousRef = currentRefs.get(path);
      const existed = await workspace.exists(path);
      const previousContent = existed
        ? await workspace.readBytes(path, { maxBytes: MAX_UPDATE_FILE_BYTES })
        : undefined;
      if (action.currentPresent === true && !existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} disappeared after planning.`,
        );
      }
      if (action.currentPresent === false && existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} appeared after planning.`,
        );
      }
      if (
        previousContent &&
        action.currentDigest &&
        digestClawBytes(previousContent) !== action.currentDigest
      ) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} changed after planning.`,
        );
      }
      if (action.action === "add" && existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace destination ${JSON.stringify(path)} appeared after planning.`,
        );
      }

      if (action.action === "remove") {
        undo.push(async () => {
          if (await workspace.exists(path)) {
            throw new Error(`Workspace file ${JSON.stringify(path)} appeared before rollback.`);
          }
          if (previousContent) {
            await workspace.write(path, previousContent, {
              mkdir: true,
              overwrite: true,
              assertBeforeMutation: rollbackOptions.assertCurrent,
            });
          }
          if (previousRef) {
            await upsertClawWorkspaceFileAsync(previousRef, rollbackOptions);
          }
        });
        if (existed) {
          await workspace.remove(path, { assertBeforeMutation: options.assertCurrent });
        }
        await deleteClawWorkspaceFileRecordAsync(updatePlan.agentId, path, options);
        continue;
      }

      const target = targetActions.get(path);
      if (!target?.source || !target.digest) {
        throw new ClawWorkspaceUpdateError(
          `Target workspace action ${JSON.stringify(path)} lacks source provenance.`,
        );
      }
      const resolvedSource = await readClawWorkspaceActionSource({
        action: target,
        packageRoot,
        sourceRoot: source,
      });
      const content = resolvedSource.content;
      if (digestClawBytes(content) !== target.digest || target.digest !== action.desiredDigest) {
        throw new ClawWorkspaceUpdateError(
          `Workspace source for ${JSON.stringify(path)} changed after planning.`,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const record: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        workspace: workspace.rootReal,
        path,
        sourcePath: resolvedSource.sourceRelative.replaceAll(sep, "/"),
        contentDigest: target.digest,
        status: "complete",
        createdAtMs: previousRef?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      };
      undo.push(async () => {
        if (!(await workspace.exists(path))) {
          throw new Error(`Workspace file ${JSON.stringify(path)} disappeared before rollback.`);
        }
        const currentContent = await workspace.readBytes(path, {
          maxBytes: MAX_UPDATE_FILE_BYTES,
        });
        if (digestClawBytes(currentContent) !== target.digest) {
          throw new Error(`Workspace file ${JSON.stringify(path)} changed before rollback.`);
        }
        if (previousContent) {
          await workspace.write(path, previousContent, {
            mkdir: true,
            overwrite: true,
            assertBeforeMutation: rollbackOptions.assertCurrent,
          });
        } else if (await workspace.exists(path)) {
          await workspace.remove(path, { assertBeforeMutation: rollbackOptions.assertCurrent });
        }
        if (previousRef) {
          await upsertClawWorkspaceFileAsync(previousRef, rollbackOptions);
        } else {
          await deleteClawWorkspaceFileRecordAsync(updatePlan.agentId, path, rollbackOptions);
        }
      });
      await workspace.write(path, content, {
        mkdir: true,
        overwrite: existed,
        assertBeforeMutation: options.assertCurrent,
      });
      await upsertClawWorkspaceFileAsync(record, options);
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
      throw new ClawWorkspaceUpdateError(
        `${coerceErrorMessage(error)}; rollback failed: ${coerceErrorMessage(rollbackError)}`,
        true,
      );
    }
    throw error;
  }
  return { rollback };
}
