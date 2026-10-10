import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { executeClawAddCommand } from "../../claws/add-command.js";
import { captureClawCommandOutput } from "../../claws/command-runtime.js";
import { executeClawUpdateCommand } from "../../claws/update-command.js";
import { createClawGatewayCommandServices } from "./claws-command-runtime.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

const text = z.string().min(1).max(4096);
const commandOptions = {
  dryRun: z.boolean().optional(),
  yes: z.boolean().optional(),
  planIntegrity: text.optional(),
  json: z.boolean().optional(),
};
const addSchema = z
  .object({
    expectedOwnerId: text,
    source: text,
    options: z
      .object({ ...commandOptions, agentId: text.optional(), workspace: text.optional() })
      .strict(),
  })
  .strict();
const updateSchema = z
  .object({
    expectedOwnerId: text,
    target: text,
    options: z.object({ ...commandOptions, from: text.optional() }).strict(),
  })
  .strict();

function commandHandler<T extends { expectedOwnerId: string }>(
  schema: z.ZodType<T>,
  run: (
    input: T,
    services: ReturnType<typeof createClawGatewayCommandServices>,
    runtime: Parameters<typeof executeClawAddCommand>[2],
  ) => Promise<void>,
): GatewayRequestHandler {
  return async (options) => {
    const parsed = schema.safeParse(options.params);
    if (!parsed.success) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw command parameters.", {
          details: { mutationAccepted: false },
        }),
      );
      return;
    }
    let entered = false;
    try {
      const services = createClawGatewayCommandServices(options, parsed.data.expectedOwnerId);
      entered = true;
      const result = await captureClawCommandOutput((runtime) =>
        run(parsed.data, services, runtime),
      );
      options.respond(true, result, undefined);
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error), {
          details: { mutationAccepted: entered },
        }),
      );
    }
  };
}

export const clawsCommandHandlers = {
  "claws.add": commandHandler(addSchema, (input, services, runtime) =>
    executeClawAddCommand(input.source, input.options, runtime, services),
  ),
  "claws.update": commandHandler(updateSchema, (input, services, runtime) =>
    executeClawUpdateCommand(input.target, input.options, runtime, services),
  ),
} satisfies GatewayRequestHandlers;
