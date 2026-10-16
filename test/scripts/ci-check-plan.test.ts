import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiCheckPlan, type CiCheckPlanInput } from "../../scripts/ci-check-plan.mts";
import { resolveCiExtensionLintSelection } from "../../scripts/lib/ci-extension-lint-plan.mts";
import {
  createExtensionOxlintShards,
  selectExtensionOxlintStripe,
} from "../../scripts/run-oxlint-shards.mts";
import { createChangedCiTypeCheckPlan } from "../../scripts/run-tsgo-core-test-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const typeSelection = vi.hoisted(() => ({
  graphs: null as { name: string; config: string }[] | null,
}));

vi.mock("../../scripts/run-tsgo-core-test-shards.mts", () => ({
  createChangedCiTypeCheckPlan: vi.fn(async () => ({
    mode: "targeted",
    graphs: typeSelection.graphs ?? [
      {
        name: "core-test-agents-root",
        config: "test/tsconfig/tsconfig.core.test.agents-root.json",
      },
      { name: "scripts", config: "tsconfig.scripts.json" },
    ],
  })),
}));
vi.mock("../../scripts/lib/ci-extension-lint-plan.mts", () => ({
  resolveCiExtensionLintSelection: vi.fn(),
}));

const stripeMatrix = (count: number) => ({
  include: Array.from({ length: count }, (_, i) => ({ stripe: i + 1 })),
});
const checks = (...tasks: string[]) => ({
  include: tasks.map((task) => ({ check_name: `check-${task}`, task, runner: "unused" })),
});
function selectLint(mode: "affected" | "none" | "full" = "none") {
  const roots = mode === "affected" ? ["extensions/discord"] : [];
  vi.mocked(resolveCiExtensionLintSelection).mockResolvedValue({
    mode: mode === "full" ? "full" : "selected",
    extensionRoots: roots,
    reasons: Object.fromEntries(roots.map((root) => [root, ["changed owner"]])),
    fullReasons: mode === "full" ? ["OPENCLAW_CI_EXTENSION_LINT_FULL"] : [],
  });
  return roots;
}
function planInput(overrides: Partial<CiCheckPlanInput>): CiCheckPlanInput {
  return {
    typeGraphBoundaryOwner: "check-plan",
    changedPaths: ["src/shared.ts"],
    changedCoreTestPaths: null,
    runnerProfile: "hybrid",
    checkMatrix: checks("test-types"),
    coreTypeMatrix: stripeMatrix(5),
    lintCoreMatrix: stripeMatrix(0),
    lintExtensionMatrix: stripeMatrix(0),
    ...overrides,
  };
}
const createPlan = (overrides: Partial<CiCheckPlanInput>) =>
  createCiCheckPlan(planInput(overrides));

function materializePlan(runnerProfile: string, rows: number, changedBaseRef?: string) {
  const input = planInput({
    ...(changedBaseRef !== undefined ? { changedBaseRef } : {}),
    typeGraphBoundaryOwner: "",
    changedPaths: ["docs/ci.md"],
    runnerProfile,
    checkMatrix: {
      include: Array.from({ length: rows }, (_, index) => ({
        check_name: `check-guards-${index}`,
        task: "guards",
        runner: "blacksmith-4vcpu-ubuntu-2404",
      })),
    },
    coreTypeMatrix: stripeMatrix(0),
    // A null lint plan retains templates even when their runner profile disables them.
    lintCoreMatrix: stripeMatrix(rows ? 2 : 0),
    lintExtensionMatrix: stripeMatrix(rows ? 3 : 0),
  });
  const output = join(tempDirs.make("ci-check-plan-"), "output");
  const workflow = readCiWorkflow();
  const planner = workflow.jobs["check-plan"];
  const step = planner.steps.find((candidate: WorkflowStep) => candidate.id === "plan");
  const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
    eventName: "pull_request",
    repository: "openclaw/openclaw",
    runAttempt: 1,
    preflightOutputs: { check_plan_input_json: JSON.stringify(input) },
  };
  const run = runWorkflowShellScript(step.run, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      OPENCLAW_CI_CHECK_PLAN_INPUT_JSON: evaluateWorkflowExpression(
        step.env.OPENCLAW_CI_CHECK_PLAN_INPUT_JSON,
        context,
      ),
    },
  });
  return { run, outputs: existsSync(output) ? readWorkflowOutputs(output) : {} };
}

describe("CI check-plan selection", () => {
  it.each(["hybrid", "github", "blacksmith"])(
    "selects complete extension roots without narrowing full check owners (%s)",
    async (runnerProfile) => {
      for (const mode of ["affected", "none", "full"] as const) {
        const roots = selectLint(mode);
        vi.mocked(createChangedCiTypeCheckPlan).mockClear();
        const checkMatrix = checks("lint", "prod-types", "test-types", "guards");
        const coreTypeMatrix = stripeMatrix(5);
        const plan = await createPlan({
          changedBaseRef: "a".repeat(40),
          extensionLintMode: mode === "full" ? "full" : "affected",
          preserveFullChecks: true,
          typeGraphBoundaryOwner: "additional-checks",
          changedPaths: ["package.json"],
          runnerProfile,
          checkMatrix,
          coreTypeMatrix,
          lintCoreMatrix: stripeMatrix(runnerProfile === "hybrid" ? 2 : 5),
          lintExtensionMatrix: stripeMatrix(6),
        });
        expect(plan.check_matrix.include).toEqual(
          runnerProfile === "hybrid"
            ? checkMatrix.include.filter(({ task }) => task !== "lint")
            : checkMatrix.include,
        );
        expect(resolveCiExtensionLintSelection).toHaveBeenLastCalledWith(
          ["package.json"],
          process.cwd(),
          { forceFull: mode === "full", baseRef: "a".repeat(40) },
        );
        expect(plan.core_type_matrix.include).toEqual(
          runnerProfile === "blacksmith" ? [] : coreTypeMatrix.include,
        );
        expect(createChangedCiTypeCheckPlan).not.toHaveBeenCalled();
        const encoded = [
          plan.central_lint_selection_json,
          ...plan.lint_core_matrix.include.map((row) => row.lint_selection_json),
          ...plan.lint_extension_matrix.include.map((row) => row.lint_selection_json),
        ];
        const payloads = encoded
          .filter((value): value is string => Boolean(value))
          .map((value) => JSON.parse(value));
        const central = JSON.parse(plan.central_lint_selection_json);
        expect(central.fullGroups).toEqual(
          runnerProfile === "blacksmith" ? ["core", "scripts"] : ["scripts"],
        );
        if (runnerProfile === "hybrid") {
          expect(plan.lint_core_matrix.include).toEqual([
            { stripe: 1, shared_central_lint_selection_json: plan.central_lint_selection_json },
            { stripe: 2 },
          ]);
          expect(plan.run_lint_extensions).toBe(mode !== "none");
        } else if (runnerProfile === "github") {
          expect(payloads.flatMap((payload) => payload.fullCoreStripes ?? [])).toEqual([
            1, 2, 3, 4, 5,
          ]);
        }
        const extensionPayloads = payloads.filter(
          (payload) => payload.extensionRoots || payload.fullExtensionStripes,
        );
        if (mode === "none") {
          expect(extensionPayloads).toEqual([]);
          expect(plan.lint_extension_matrix.include).toEqual([]);
        } else {
          expect(extensionPayloads.length).toBeGreaterThan(0);
          for (const payload of extensionPayloads) {
            expect(payload.extensionStripeCount).toBe(
              runnerProfile === "hybrid" ? 3 : runnerProfile === "github" ? 6 : 1,
            );
            if (mode === "affected") {
              expect(payload.extensionRoots).toEqual(roots);
              expect(payload.extensionStripes.length).toBeGreaterThan(0);
              expect(payload.fullExtensionStripes).toBeUndefined();
            } else {
              expect(payload.extensionRoots).toBeUndefined();
              expect(payload.fullExtensionStripes.length).toBeGreaterThan(0);
            }
          }
        }
      }
    },
  );
  it.each([
    { paths: ["src/config/sessions/session-input-actor.ts"], share: true },
    { paths: ["ui/src/styles/base.css"], share: false },
    { paths: ["test/scripts/ci-check-plan.test.ts"], share: false },
    { paths: ["scripts/ci-check-plan.mts"], share: true },
  ])(
    "retains separate central owners beyond formatting and scripts: $paths",
    async ({ paths, share }) => {
      selectLint();
      const plan = await createPlan({
        preserveFullChecks: true,
        extensionLintMode: "affected",
        changedPaths: paths,
        checkMatrix: checks("lint", "guards"),
        lintCoreMatrix: stripeMatrix(2),
      });
      expect(plan.check_matrix.include.map(({ task }) => task)).toEqual(
        share ? ["guards"] : ["lint", "guards"],
      );
      expect(plan.lint_core_matrix.include[0]?.shared_central_lint_selection_json).toBe(
        share ? plan.central_lint_selection_json : undefined,
      );
    },
  );

  it("keeps the last check row required by the gate", async () => {
    selectLint();
    const plan = await createPlan({
      preserveFullChecks: true,
      extensionLintMode: "affected",
      changedPaths: ["package.json"],
      checkMatrix: checks("lint"),
      lintCoreMatrix: stripeMatrix(2),
    });
    expect(plan.check_matrix.include.map(({ task }) => task)).toEqual(["lint"]);
    expect(plan.lint_core_matrix.include).toEqual([{ stripe: 1 }, { stripe: 2 }]);
  });

  it.each([0, 7])("executes shared central lint and propagates its result (%s)", (exitCode) => {
    const cwd = tempDirs.make("ci-shared-lint-");
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts/tsx.mjs"), "");
    writeFileSync(
      join(cwd, "scripts/changed-lanes.mts"),
      "export const detectChangedLanes = paths => ({ paths });\n",
    );
    writeFileSync(
      join(cwd, "scripts/check-changed.mts"),
      `
      import assert from 'node:assert/strict';
      export async function runChangedCheck(result, options) {
        assert.deepEqual(result.paths, ['src/example.ts']);
        assert.deepEqual(options, { lintOnly: true, lintSelection: { central: true, fullGroups: ['scripts'] }, lintThreads: 1 });
        return ${exitCode};
      }
    `,
    );
    const workflow = readCiWorkflow();
    const step = workflow.jobs["check-lint-hosted-core-shard"].steps.find(
      (candidate: WorkflowStep) => candidate.name === "Run shared central lint",
    );
    const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      failed: true,
      matrix: { shared_central_lint_selection_json: '{"central":true,"fullGroups":["scripts"]}' },
      preflightOutputs: { narrow_check_paths_json: '["src/example.ts"]', runner_profile: "hybrid" },
    };
    expect(Boolean(evaluateWorkflowExpression(step.if, context))).toBe(true);
    const run = runWorkflowShellScript(step.run, {
      cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(step.env).map(([name, value]) => [
            name,
            typeof value === "string" && value.includes("${{")
              ? String(evaluateWorkflowExpression(value, context))
              : String(value),
          ]),
        ),
      },
    });
    expect(run.status, run.stderr).toBe(exitCode);
  });
  it.each(["check-plan", "additional-checks"] as const)(
    "passes only an admitted parallel boundary owner without adding compiler rows (%s)",
    async (typeGraphBoundaryOwner) => {
      typeSelection.graphs = [
        { name: "extensions", config: "tsconfig.extensions.json" },
        { name: "extensions-test", config: "test/tsconfig/tsconfig.extensions.test.json" },
        { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
      ];
      vi.mocked(createChangedCiTypeCheckPlan).mockClear();
      try {
        const paths = ["extensions/example/value.ts"];
        const plan = await createPlan({
          typeGraphBoundaryOwner,
          changedPaths: paths,
          checkMatrix: checks("prod-types", "test-types"),
        });
        expect(createChangedCiTypeCheckPlan).toHaveBeenCalledExactlyOnceWith(paths, {
          cwd: process.cwd(),
          coreBoundaryOwner:
            typeGraphBoundaryOwner === "additional-checks" ? "additional-checks" : undefined,
        });
        expect(plan.core_type_matrix.include).toEqual([]);
        expect(
          plan.check_matrix.include.map((row) => JSON.parse(row.type_graph_names_json!)),
        ).toEqual([["extensions"], ["extensions-test", "test-root"]]);
      } finally {
        typeSelection.graphs = null;
      }
    },
  );

  it.each([
    ["hybrid", [1, 2, 4, 5]],
    ["hybrid", [1, 2, 5]],
    ["blacksmith", [1, 2, 3, 4, 5]],
  ] as const)(
    "assigns root partitions without adding %s rows (%j)",
    async (runnerProfile, stripes) => {
      const core = [
        "agents-root",
        "agents-other",
        "agents-tools",
        "gateway-root",
        "gateway-server",
      ];
      typeSelection.graphs = [
        ...stripes.map((stripe) => ({
          name: `core-test-${core[stripe - 1]}`,
          config: `test/tsconfig/tsconfig.core.test.${core[stripe - 1]}.json`,
        })),
        { name: "scripts", config: "tsconfig.scripts.json" },
        { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
      ];
      try {
        const plan = await createPlan({ runnerProfile });
        const hosted = runnerProfile !== "blacksmith";
        const moved = hosted && stripes.length >= 4;
        expect(plan.core_type_matrix.include.map((row) => row.stripe)).toEqual(
          hosted ? stripes : [],
        );
        expect(plan.core_type_matrix.include.flatMap((row) => row.root_type_stripe ?? [])).toEqual(
          moved ? ["1/4", "2/4", "3/4", "4/4"] : [],
        );
        expect(JSON.parse(plan.check_matrix.include[0]!.type_graph_names_json!)).toEqual(
          moved ? ["scripts"] : hosted ? ["scripts", "test-root"] : ["test-root", "scripts"],
        );
      } finally {
        typeSelection.graphs = null;
      }
    },
  );

  it.each(["hybrid", "github", "blacksmith"])(
    "preserves complete fallback chunks while reducing only hybrid rows (%s)",
    async (runnerProfile) => {
      const cwd = tempDirs.make("ci-full-extension-lint-");
      for (let index = 0; index < 49; index++) {
        mkdirSync(join(cwd, "extensions", `plugin-${String(index).padStart(2, "0")}`), {
          recursive: true,
        });
      }
      writeFileSync(join(cwd, "extensions/root.ts"), "export {};\n");
      const shards = createExtensionOxlintShards({ cwd, platform: "linux", chunkSize: 8 });
      const plan = await createPlan({
        typeGraphBoundaryOwner: "",
        changedPaths: ["package.json"],
        runnerProfile,
        checkMatrix: checks("lint"),
        coreTypeMatrix: stripeMatrix(0),
        lintExtensionMatrix: stripeMatrix(6),
      });
      const rows = plan.lint_extension_matrix.include;
      expect(rows).toHaveLength(runnerProfile === "hybrid" ? 3 : 6);
      const selected = rows.flatMap((row) =>
        selectExtensionOxlintStripe(shards, {
          index: row.stripe,
          total: row.stripe_count ?? 6,
        }),
      );
      expect(selected.map(({ name, args }) => JSON.stringify({ name, args })).toSorted()).toEqual(
        shards.map(({ name, args }) => JSON.stringify({ name, args })).toSorted(),
      );
      expect(plan.central_lint_selection_json).toBe("");
    },
  );

  it.each([
    { runner: "blacksmith", rows: 401, base: undefined, error: "400-job" },
    { runner: "hybrid", rows: 0, base: "main", error: "40-hex changed base commit" },
  ])("rejects an inadmissible workflow plan: $error", ({ runner, rows, base, error }) => {
    const { run, outputs } = materializePlan(runner, rows, base);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(error);
    expect(outputs).toEqual({});
  });
});
