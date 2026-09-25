import { isDeepStrictEqual } from "node:util";
import { prepareUpdateRecoveryGeneration } from "../../infra/update-recovery-preparation.js";
import type { UpdateCommandOptions } from "./shared.js";

/** Prepare T only under the original live run/executor/B/C owner. Publication remains separate. */
export async function prepareFailedUpdateRecovery(opts: UpdateCommandOptions) {
  const run = opts.run;
  const executor = run?.executorFence;
  const input = run?.recoveryPreparation;
  if (!run || !executor || !input) {
    return undefined;
  }
  const baseline = structuredClone(input.baseline);
  const candidate = structuredClone(input.candidate);
  const originalAssert = input.assertOwned.bind(input);
  const assertOwned = () => {
    executor.assertCurrent();
    originalAssert();
    if (
      opts.run !== run ||
      run.executorFence !== executor ||
      run.recoveryPreparation !== input ||
      !isDeepStrictEqual(input.baseline, baseline) ||
      !isDeepStrictEqual(input.candidate, candidate)
    ) {
      throw new Error("Recovery preparation changed its original run or B/C binding.");
    }
  };
  assertOwned();
  const prepared = await prepareUpdateRecoveryGeneration(baseline, candidate, {
    assertOwned,
    env: run.env,
  });
  assertOwned();
  return Object.freeze({ ...prepared });
}
