import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";

export function createProcessFixtures(cleanupError: string, cleanupTimeoutMs?: number) {
  const directories = createTempDirTracker();
  const children = new Map<ChildProcess, Promise<unknown[]>>();
  async function cleanup() {
    for (const child of children.keys()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    // Close, not exit, joins both output streams before fixture directories disappear.
    const closing = Promise.allSettled(children.values());
    const results = await (cleanupTimeoutMs === undefined
      ? closing
      : withTestTimeout(
          closing,
          cleanupTimeoutMs,
          `${cleanupError}; retaining fixture directories`,
        ));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, cleanupError);
    }
    children.clear();
    directories.cleanup();
  }
  afterEach(cleanup);
  return {
    make: directories.make,
    cleanup,
    ownChild(child: ChildProcess) {
      const closed = once(child, "close");
      children.set(child, closed);
      void closed.catch(() => {});
      const output = { stdout: "", stderr: "" };
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output.stdout += chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output.stderr += chunk));
      return { child, closed, output };
    },
  };
}
