import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { unsetConfiguredMcpServer } from "../../agents/mcp-config-mutation.js";
import { captureClawCommandOutput } from "../../claws/command-runtime.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import {
  clawMonitorDrainSchema,
  clawMonitorInventorySchema,
} from "../../claws/monitor-cleanup-contract.js";
import { clawPackageRemovalResultSchema } from "../../claws/package-remove-contract.js";
import { executeClawRemoveCommand } from "../../claws/remove-command.js";
import { createClawGatewayCommandServices } from "./claws-command-runtime.js";
import type { GatewayRequestHandlers } from "./types.js";

const requestSchema = z
  .object({
    expectedOwnerId: z.string().min(1),
    target: z.string().min(1),
    options: z
      .object({
        dryRun: z.boolean().optional(),
        yes: z.boolean().optional(),
        planIntegrity: z.string().optional(),
        json: z.boolean().optional(),
        removeUnused: z.boolean().optional(),
        removeReferenced: z.array(z.string()).optional(),
        forceReferenced: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const clawsRemoveHandlers = {
  "claws.remove": async (options) => {
    const parsed = requestSchema.safeParse(options.params);
    if (!parsed.success) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw removal parameters."),
      );
      return;
    }
    try {
      const { target, options: commandOptions, expectedOwnerId } = parsed.data;
      const services = createClawGatewayCommandServices(options, expectedOwnerId);
      const binding = () => resolveClawMonitorCleanupBinding(options.context.cronStorePath);
      const application = services.createConfigApplication();
      const reply = await captureClawCommandOutput((runtime) =>
        executeClawRemoveCommand(target, commandOptions, runtime, {
          ...services,
          unsetMcpServer: async (params) => {
            const mcpApplication = services.createConfigApplication();
            return unsetConfiguredMcpServer({
              ...params,
              configWriteOptions: mcpApplication.writeOptions,
              onConfigCommitted: mcpApplication.confirm,
            });
          },
          configWriteOptions: application.writeOptions,
          onConfigCommitted: (agentId) =>
            application.confirm(
              () =>
                options.context.isConfigReloadSettled() &&
                !Object.hasOwn(options.context.getRuntimeConfig().agents?.entries ?? {}, agentId),
            ),
          monitorGateway: {
            inspect: async (agentId) =>
              clawMonitorInventorySchema.parse(
                await services.call("claws.monitors", {
                  phase: "inspect",
                  agentId,
                  binding: binding(),
                }),
              ).monitors,
            quiesce: async (agentId, operationId, monitors) => {
              clawMonitorDrainSchema.parse(
                await services.call("claws.monitors", {
                  phase: "quiesce",
                  agentId,
                  operationId,
                  monitors,
                  binding: binding(),
                }),
              );
            },
            drain: async (agentId, operationId) => {
              clawMonitorDrainSchema.parse(
                await services.call("claws.monitors", {
                  phase: "drain",
                  agentId,
                  operationId,
                  binding: binding(),
                }),
              );
            },
          },
          packageGateway: async (request) =>
            clawPackageRemovalResultSchema.parse(
              await services.call("claws.packages.remove", {
                ...request,
                binding: binding(),
              }),
            ),
        }),
      );
      options.respond(true, reply);
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)),
      );
    }
  },
} satisfies GatewayRequestHandlers;
