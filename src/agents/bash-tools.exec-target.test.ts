import { describe, expect, it } from "vitest";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { createExecHostResolver } from "./bash-tools.exec-support.js";
import { createExecTool } from "./bash-tools.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";

type TargetOptions = Parameters<typeof resolveExecTarget>[0];
type ExecTool = ReturnType<typeof createExecTool>;
function budget(
  tool: Pick<ExecTool, "getExecutionTimeoutMs">,
  args: Parameters<NonNullable<ExecTool["getExecutionTimeoutMs"]>>[0],
) {
  return tool.getExecutionTimeoutMs?.(args);
}
function target(overrides: Partial<TargetOptions>) {
  return resolveExecTarget({
    configuredTarget: "auto",
    elevatedRequested: false,
    sandboxAvailable: true,
    ...overrides,
  });
}

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("Expected an Error");
}

const sandbox = {
  containerName: "test-sandbox",
  workspaceDir: "/workspace",
  containerWorkdir: "/workspace",
};

describe("exec target policy", () => {
  it("authenticates the sandbox escape rejection once, not copies or invalid syntax", () => {
    const denied = thrown(() => target({ requestedTarget: "gateway" }));
    expect(denied.message).toBe(
      "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway to allow this override).",
    );
    const serialized = JSON.stringify(denied);
    for (const copy of [
      new Error(denied.message),
      Object.assign(new Error(denied.message), denied),
      structuredClone(denied),
      JSON.parse(serialized),
    ]) {
      expect(consumeTrustedToolNoStartError(copy)).toBe(false);
    }
    expect(Object.keys(denied)).toEqual([]);
    expect(consumeTrustedToolNoStartError(denied)).toBe(true);
    expect(consumeTrustedToolNoStartError(denied)).toBe(false);
    expect(
      consumeTrustedToolNoStartError(thrown(() => requireValidExecTarget("invalid-host"))),
    ).toBe(false);
  });

  it.each([
    ["auto", undefined, false, false, "auto", "gateway"],
    ["auto", "node", false, true, "node", "node"],
    ["node", "node", true, false, "node", "node"],
    ["auto", "sandbox", true, true, "gateway", "gateway"],
    ["node", "auto", false, true, "node", "node"],
  ] as const)(
    "resolves configured=%s requested=%s sandbox=%s elevated=%s to selected=%s host=%s",
    (
      configuredTarget,
      requestedTarget,
      sandboxAvailable,
      elevatedRequested,
      selectedTarget,
      effectiveHost,
    ) => {
      expect(
        resolveExecTarget({
          configuredTarget,
          requestedTarget,
          elevatedRequested,
          sandboxAvailable,
        }),
      ).toEqual({
        configuredTarget,
        requestedTarget: requestedTarget === "auto" ? null : (requestedTarget ?? null),
        selectedTarget,
        effectiveHost,
      });
    },
  );

  it.each<{ name: string; options: Partial<TargetOptions>; error: string | RegExp }>([
    {
      name: "node override from auto with an available sandbox",
      options: { requestedTarget: "node" },
      error:
        "exec host not allowed (requested node; configured host is auto; set tools.exec.host=node to allow this override).",
    },
    {
      name: "gateway override from configured node even with elevation",
      options: {
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: true,
        sandboxAvailable: false,
      },
      error:
        "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    },
    {
      name: "explicit matching node when the session requires a sandbox",
      options: { configuredTarget: "node", requestedTarget: "node", sandboxRequired: true },
      error: /sandbox|required|not allowed/i,
    },
    {
      name: "elevation when the session requires a sandbox",
      options: { elevatedRequested: true, sandboxRequired: true },
      error: /sandbox|required|elevated/i,
    },
    {
      name: "an unavailable required sandbox",
      options: { sandboxAvailable: false, sandboxRequired: true },
      error: /sandbox|required|unavailable/i,
    },
  ])("rejects $name", ({ options, error }) => {
    expect(() => target(options)).toThrow(error);
  });

  it("keeps per-call auto sandboxed despite configured node", () => {
    expect(
      target({ configuredTarget: "node", requestedTarget: "auto", sandboxRequired: true }),
    ).toMatchObject({ configuredTarget: "auto", effectiveHost: "sandbox" });
  });

  it("rejects a stale timeout argument before command execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    await expect(
      tool.execute("legacy-timeout", { command: "exit 99", timeout: 5 } as never),
    ).rejects.toThrow('exec parameter "timeout" is unsupported; use "timeoutSeconds" instead');
  });

  it.each([
    { host: "gateway" as const },
    { sandbox },
    { host: "node" as const, sandbox, sandboxRequired: true },
  ])("keeps node-only calls within configured policy %j", (defaults) => {
    expect(() => createExecHostResolver(defaults)({ command: "echo ok", node: "node-1" })).toThrow(
      /exec host not allowed.*node/,
    );
  });

  it.each([
    { timeoutSec: undefined, timeoutSeconds: undefined, expectedMs: 1_810_000 },
    { timeoutSec: 120, timeoutSeconds: 0, expectedMs: 130_000 },
  ])(
    "keeps prepared and pinned budgets for $timeoutSec/$timeoutSeconds seconds",
    ({ timeoutSec, timeoutSeconds, expectedMs }) => {
      for (const createTool of [createExecTool, createLazyExecTool]) {
        const tool = createTool({ host: "node", timeoutSec });
        const args = { command: "echo ready", timeoutSeconds };
        expect(budget(tool, args)).toBe(expectedMs);
        expect(budget(createTool({ timeoutSec }), { ...args, node: "node-1" })).toBe(expectedMs);
        expect(
          budget(pinExecToolTarget(tool, { host: "node" }), { ...args, host: "gateway" }),
        ).toBe(expectedMs);
        expect(
          budget(pinExecToolTarget(tool, { host: "gateway" }), { ...args, host: "node" }),
        ).toBeUndefined();
      }
    },
  );
});
