import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { ClawsUpdateOptions } from "./claws-cli.js";
import { runClawCommandWithOwner } from "./claws-command-owner.js";

export async function runClawsUpdateCommand(
  target: string,
  opts: ClawsUpdateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const { executeClawUpdateCommand } = await import("../claws/update-command.js");
  await runClawCommandWithOwner(
    "claws.update",
    { target, options: opts },
    runtime,
    (services, output) => executeClawUpdateCommand(target, opts, output, services),
  );
}
