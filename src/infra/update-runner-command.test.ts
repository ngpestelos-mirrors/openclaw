import { describe, expect, it, vi } from "vitest";
import { runStep } from "./update-runner-command.js";

describe("update command failure facts", () => {
  it("captures the first npm error before log tail truncation and step completion", async () => {
    const onStepComplete = vi.fn();
    const result = await runStep({
      name: "global install stage",
      argv: ["npm", "install"],
      cwd: "/fixture",
      timeoutMs: 1000,
      stepIndex: 0,
      totalSteps: 1,
      progress: { onStepComplete },
      runCommand: async () => ({
        code: 1,
        stdout: "",
        stderr: `npm error code EACCES\n${"cleanup output\n".repeat(1000)}`,
      }),
    });
    expect(result.stderrTail).not.toContain("EACCES");
    const expected = {
      failureFacts: [
        { check: "package-install", code: "EACCES", message: "npm error code EACCES" },
      ],
    };
    expect(result).toMatchObject(expected);
    expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(expected));
  });
});
