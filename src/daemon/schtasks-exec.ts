/** Executes Windows Task Scheduler commands with daemon-friendly timeouts. */
import type { SpawnResult } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const SCHTASKS_TIMEOUT_MS = 15_000;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 30_000;

/** Runs Windows schtasks with bounded timeouts and normalized process results. */
export async function execSchtasks(
  args: string[],
  timeoutMs = SCHTASKS_TIMEOUT_MS,
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  interruption?: {
    termination: Exclude<SpawnResult["termination"], "exit">;
    detail: string;
  };
}> {
  assertGatewayServiceUpdateCurrent();
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    baseEnv: resolveServiceManagerEnv(),
    timeoutMs,
    noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS,
  });
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks timed out after ${timeoutMs}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms`
        : result.termination !== "exit"
          ? "schtasks command terminated before confirmed completion"
          : "";
  // schtasks can hang without output on some Windows hosts; convert both timeout
  // modes into ordinary process-like failures for service fallback logic.
  return {
    stdout: result.stdout,
    stderr: result.stderr || timeoutDetail,
    code: result.termination === "exit" ? (result.code ?? 1) : result.code || 124,
    ...(result.termination !== "exit"
      ? { interruption: { termination: result.termination, detail: timeoutDetail } }
      : {}),
  };
}
