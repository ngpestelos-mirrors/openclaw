import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import noForcedProcessExit from "../../scripts/lib/no-forced-process-exit.mjs";

const FIXTURES = "test/fixtures/oxlint-boundary-guards";
function fixture(rule: string, file: string, violations: number, lines?: number[]) {
  return {
    rule: `openclaw-boundaries/${rule}`,
    violation: `${FIXTURES}/${file}`,
    violations,
    lines,
  };
}
const cases = [
  fixture(
    "no-forced-process-exit",
    "forced-process-exit-violation.ts",
    25,
    [2, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 23, 24, 24, 25, 26, 27, 28, 30, 32],
  ),
  fixture("no-forced-process-exit", "forced-process-exit-violation.cjs", 6, [3, 4, 5, 6, 7, 9]),
  fixture("no-forced-process-exit", "forced-process-exit-violation.mjs", 2, [2, 4]),
  {
    rule: "openclaw-boundaries/no-forced-process-exit",
    violation: "test/fixtures/forced-process-exit.test-support.cjs",
    violations: 0,
    lines: undefined,
  },
  fixture("no-register-http-handler-call", "register-http-handler-violation.ts", 3),
  fixture("no-raw-window-open-call", "raw-window-open-violation.ts", 5),
  fixture("no-raw-window-open-call", "boundary-calls.tsx", 2, [3, 4]),
  fixture("no-register-http-handler-call", "boundary-calls.tsx", 1, [5]),
  fixture("no-raw-window-open-call", "boundary-calls.test-harness.tsx", 0),
  fixture("no-register-http-handler-call", "boundary-calls.test-harness.tsx", 0),
  fixture("no-widen-then-assert", "widen-then-assert-violation.test.ts", 3, [3, 7, 13]),
  fixture("no-chained-type-assertions", "chained-type-assertions-violation.ts", 3),
];

describe("forced process exit runtime scope", () => {
  it.each([
    ["src/runtime.ts", true],
    ["src/cli/new-entry.mts", true],
    ["extensions/example/src/worker.ts", true],
    ["extensions/example/runtime-api.ts", true],
    ["extensions/example/src/harness-runtime.ts", true],
    ["extensions/example/src/tools/run.ts", true],
    ["packages/example/src/cli.ts", true],
    ["packages/example/index.ts", true],
    ["ui/src/app.ts", true],
    ["openclaw.mjs", true],
    ["node-host-launcher.mjs", true],
    ["docker-entrypoint.mjs", true],
    ["scripts/openclaw-immutable-launcher.mjs", true],
    ["scripts/freebsd-service-inspect.mjs", true],
    ["scripts/build.mts", false],
    ["extensions/example/scripts/build.mjs", false],
    ["extensions/example/vitest.config.ts", false],
    ["packages/example/scripts/build.mts", false],
    ["src/child.test-support.cjs", false],
    ["src/workflow.suite.ts", false],
    ["extensions/example/src/fixtures/child.fixture.mjs", false],
    ["packages/example/tests/child.ts", false],
    ["extensions/example/dist/worker.js", false],
  ])("reports forced termination in %s: %s", (file, expected) => {
    let reported = false;
    const listeners = noForcedProcessExit.create({
      cwd: process.cwd(),
      physicalFilename: `${process.cwd()}/${file}`,
      report() {
        reported = true;
      },
    });
    // Scope admission is independent of parsing; the batch below verifies the
    // real Oxlint AST and bindings. This is the standard unbound process.exit AST.
    listeners.MemberExpression?.({
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "process", start: 0 },
      property: { type: "Identifier", name: "exit" },
    });
    expect(reported).toBe(expected);
  });
});

describe("oxlint boundary guards", () => {
  let diagnostics: Array<{
    filename: string;
    code: string;
    severity: string;
    message: string;
    labels: Array<{ span: { line: number } }>;
  }>;

  beforeAll(() => {
    const violation = spawnSync(
      process.execPath,
      [
        "scripts/run-oxlint.mjs",
        "--openclaw-focused-config",
        "--config",
        "config/oxlint/boundary-guards.json",
        "--format",
        "json",
        ...new Set(cases.map((testCase) => testCase.violation)),
      ],
      { encoding: "utf8" },
    );
    expect(violation.error).toBeUndefined();
    expect(violation.status, violation.stderr).toBe(1);
    const report = JSON.parse(violation.stdout) as {
      diagnostics: typeof diagnostics;
      number_of_files: number;
    };
    expect(report.number_of_files).toBe(new Set(cases.map((testCase) => testCase.violation)).size);
    diagnostics = report.diagnostics;
  });

  it.each(cases)("reports expected violations for $rule", (testCase) => {
    // A fixture can trigger sibling rules; match both its file and its owning rule.
    const matching = diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename.replaceAll("\\", "/") === testCase.violation &&
        diagnostic.code === `${testCase.rule.replace("/", "(")})`,
    );
    expect(matching.map((diagnostic) => diagnostic.severity)).toEqual(
      Array(testCase.violations).fill("error"),
    );
    if (testCase.lines) {
      expect(
        matching
          .map((diagnostic) => diagnostic.labels[0]?.span.line)
          .toSorted((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual(testCase.lines);
    }
    if (testCase.rule === "openclaw-boundaries/no-forced-process-exit") {
      for (const diagnostic of matching) {
        expect(diagnostic.message).toContain("https://github.com/nodejs/node/issues/64274");
        expect(diagnostic.message).toContain(
          "Await owned cleanup, set process.exitCode, and return",
        );
      }
    }
  });
});
