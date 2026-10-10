import path from "node:path";
import { captureClawCommandOutput, type ClawCommandServices } from "../claws/command-runtime.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { ClawsAddOptions, ClawsUpdateOptions, ClawsRemoveOptions } from "./claws-cli.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

export async function runClawCommandWithOwner(
  method: "claws.add" | "claws.update" | "claws.remove",
  input: {
    source?: string;
    target?: string;
    options: ClawsAddOptions & ClawsUpdateOptions & ClawsRemoveOptions;
  },
  runtime: RuntimeEnv,
  runLocal: (services: ClawCommandServices, output: RuntimeEnv) => Promise<void>,
): Promise<void> {
  const request = {
    ...input,
    ...(input.source ? { source: path.resolve(resolveUserPath(input.source)) } : {}),
    options: {
      ...input.options,
      ...(input.options.workspace
        ? { workspace: path.resolve(resolveUserPath(input.options.workspace)) }
        : {}),
      ...(input.options.from ? { from: path.resolve(resolveUserPath(input.options.from)) } : {}),
    },
  };
  const reply = await runWithLocalStateOwner({
    method,
    params: request,
    target: input.target ?? input.source ?? "Claw",
    recoveryCommand: "openclaw claws status",
    runLocal: ({ assertCurrent, assertSettlementCurrent, runSettlement, signal, env }) =>
      captureClawCommandOutput((output) =>
        runLocal({ assertCurrent, assertSettlementCurrent, runSettlement, signal, env }, output),
      ),
  });
  for (const item of reply.output) {
    if (item.kind === "json") {
      writeRuntimeJson(runtime, item.value, item.space);
    } else {
      runtime[item.kind](item.text);
    }
  }
  if (reply.exitCode !== 0) {
    runtime.exit(reply.exitCode);
  }
}
