import { isDeepStrictEqual } from "node:util";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import {
  captureGatewayServiceDefinitionBackup,
  readGatewayServiceDefinitionPublication,
} from "./service-definition-backup.js";
import type { GatewayServiceDefinitionPublication } from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import { isUpdateOwnedGatewayServiceCommand } from "./service-update-authority.js";
import { resolveGatewayService } from "./service.js";

/** Call under the installer lock; current update parents retain their own rollback receipt. */
export async function reconcileGatewayServiceDefinition(params: {
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig | null;
  expectedCommand: Pick<GatewayServiceCommandConfig, "programArguments" | "workingDirectory">;
  automatic: boolean;
  assertCurrent: () => void;
  install: () => Promise<void>;
  warn: (message: string) => void;
}): Promise<GatewayServiceDefinitionPublication | undefined> {
  if (!params.automatic || !params.command) {
    params.assertCurrent();
    await params.install();
    params.assertCurrent();
    return undefined;
  }
  const parentOwnsBackup = isUpdateOwnedGatewayServiceCommand();
  const current = await resolveGatewayService().readCommand(params.env, {
    requireEffective: true,
  });
  params.assertCurrent();
  if (!isDeepStrictEqual(current, params.command)) {
    throw new Error(
      "SERVICE_DEFINITION_UNKNOWN: Gateway service changed after inspection; the newer definition was preserved. Rerun Doctor to inspect it.",
    );
  }
  const { issues } = await auditGatewayServiceConfig({
    env: params.env,
    command: params.command,
    expectedCommand: params.expectedCommand,
  });
  const blocked = issues.filter((issue) => issue.rewriteBlocked);
  if (blocked.length) {
    throw new Error(
      `SERVICE_DEFINITION_UNKNOWN: ${blocked.map((issue) => `${issue.definitionKey}: ${issue.message}`).join("; ")}`,
    );
  }
  const keys = issues.flatMap((issue) => (issue.definitionKey ? [issue.definitionKey] : []));
  const backup =
    keys.length && !parentOwnsBackup
      ? await captureGatewayServiceDefinitionBackup({ ...params, command: params.command }).catch(
          (error: unknown) => {
            params.assertCurrent();
            throw new Error(`SERVICE_DEFINITION_UNKNOWN: Service backup failed: ${String(error)}`, {
              cause: error,
            });
          },
        )
      : undefined;
  params.assertCurrent();
  await params.install();
  const publication = parentOwnsBackup
    ? await readGatewayServiceDefinitionPublication({
        env: params.env,
        command: params.command,
      }).catch((error: unknown) => {
        params.assertCurrent();
        params.warn(`Could not retain service publication facts for rollback: ${String(error)}`);
        return undefined;
      })
    : undefined;
  params.assertCurrent();
  if (!keys.length) {
    return publication;
  }
  const message = `Reconciled Gateway service definition: ${keys.join(", ")}.${backup ? ` Backup: ${backup.backupPaths.join(", ")}` : ""}`;
  params.warn(message);
  // Shipped parents can discard installer stdout; keep the finding in their existing ledger.
  const runId = process.env[UPDATE_RUN_ID_ENV];
  if (runId && !parentOwnsBackup) {
    try {
      params.assertCurrent();
      recordUpdateRunStep(
        runId,
        {
          step: "warning:managed-service-reconciliation",
          status: "completed",
          endedAtMs: Date.now(),
          detail: message,
        },
        { env: process.env },
      );
    } catch {
      params.warn(
        "Could not record service reconciliation in update history; the service backup remains available.",
      );
    }
  }
  return publication;
}
