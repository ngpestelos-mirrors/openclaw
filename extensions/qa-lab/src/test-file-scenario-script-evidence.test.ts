import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { buildQaOccurrenceEvidenceSummary, type QaEvidenceOccurrence } from "./evidence-summary.js";
import {
  buildScriptProducerEvidence,
  makeTestFileScenario,
  QA_TEST_RUNNER_DEFAULTS,
  runQaTestFileScenariosWithCommand as runQaTestFileScenarios,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";
import { readScriptProducerEvidence } from "./test-file-scenario-script-evidence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function fixture(prefix: string, dirname = "output", id = "owned-scenario") {
  const repoRoot = tempDirs.make(prefix);
  const outputDir = path.join(repoRoot, dirname);
  const scenario = { id };
  const evidenceDir = path.join(outputDir, id);
  return {
    repoRoot,
    outputDir,
    scenario,
    evidenceDir,
    read: (from = outputDir) =>
      readScriptProducerEvidence({
        repoRoot,
        outputDir: from,
        scenario,
        requireCurrentRunEvidence: true,
      }),
    write: (name: string, value: unknown) =>
      fs.writeFile(path.join(evidenceDir, name), JSON.stringify(value)),
  };
}

describe("script evidence reader", () => {
  it("rebases receipt artifacts without changing full source evidence", async () => {
    const { evidenceDir, read } = fixture("qa-script-receipt-");
    await fs.mkdir(evidenceDir, { recursive: true });
    const content = "observed synthetic target\n";
    const digest = createHash("sha256").update(content).digest("hex");
    await fs.writeFile(path.join(evidenceDir, "target.log"), content);
    const source = buildScriptProducerEvidence({
      status: "pass",
      artifacts: [{ kind: "log", path: "target.log", source: "synthetic-target" }],
    });
    const occurrence: QaEvidenceOccurrence = {
      id: "observation",
      parentCell: null,
      scenario: null,
      retryOf: null,
      terminalStatus: "pass",
      assertions: null,
      launch: {
        source: { ref: null, integrity: null },
        runtime: { id: null, version: null },
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      },
      receipts: [],
    };
    occurrence.receipts.push({
      id: "target",
      phase: "runtime",
      identity: structuredClone(occurrence.launch),
      artifact: { kind: "log", path: "target.log", source: "synthetic-target", sha256: digest },
    });
    const evidence = buildQaOccurrenceEvidenceSummary({
      generatedAt: source.generatedAt,
      evidenceMode: "full",
      occurrences: [occurrence],
      entries: source.entries.map((entry) =>
        Object.assign({}, entry, {
          effective: true,
          binding: { occurrenceId: occurrence.id, assertionId: null, receiptId: "target" },
        }),
      ),
    });
    const evidencePath = path.join(evidenceDir, "qa-evidence.json");
    const raw = JSON.stringify(evidence);
    await fs.writeFile(evidencePath, raw);
    const { producerEvidence: imported } = await read();
    expect(imported?.schemaVersion).toBe(3);
    if (imported?.schemaVersion !== 3) {
      throw new Error("expected occurrence evidence");
    }
    expect(imported.occurrences[0]!.receipts[0]!.artifact).toEqual({
      kind: "log",
      path: "<repo-root>/output/owned-scenario/target.log",
      source: "synthetic-target",
      sha256: digest,
    });
    expect(imported.entries[0]!.binding).toEqual(evidence.entries[0]!.binding);
    expect(imported.entries[0]!.execution?.artifacts[0]?.path).toBe(
      "<repo-root>/output/owned-scenario/target.log",
    );
    expect(await fs.readFile(evidencePath, "utf8")).toBe(raw);
  });

  it("retains actual nested native slim files and receipt hashes across repeated imports", async () => {
    const { repoRoot, scenario, evidenceDir, read } = fixture(
      "qa-native-receipt-base-",
      "outer",
      "native-child",
    );
    const result = await runQaTestFileScenarios({
      ...QA_TEST_RUNNER_DEFAULTS,
      repoRoot,
      outputDir: evidenceDir,
      evidenceMode: "slim",
      scenarios: [makeTestFileScenario("vitest", "owned.test.ts")],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, { passed: 1 });
        return { exitCode: 0, stdout: "actual captured fixture command output\n", stderr: "" };
      },
    });
    expect(result.results[0]!.status).toBe("pass");
    const original = await fs.readFile(result.evidencePath);
    const first = await read();
    expect(first.producerEvidence).toEqual(result.evidence);
    if (first.producerEvidence?.schemaVersion !== 3) {
      throw new Error("expected native v3");
    }
    const receipt = first.producerEvidence.occurrences.flatMap((item) => item.receipts)[0]!;
    expect(receipt.artifact.path).toMatch(/^<repo-root>\/outer\/native-child\/occurrences\//u);
    const logPath = resolveQaArtifactPath(repoRoot, evidenceDir, receipt.artifact.path);
    expect(logPath).toBe(result.results[0]!.logPath);
    const logBytes = await fs.readFile(logPath);
    expect(createHash("sha256").update(logBytes).digest("hex")).toBe(receipt.artifact.sha256);
    expect(logBytes.toString()).toContain("actual captured fixture command output");
    const nextDir = path.join(repoRoot, "next", scenario.id);
    await fs.mkdir(nextDir, { recursive: true });
    const nextPath = path.join(nextDir, "qa-evidence.json");
    await fs.writeFile(nextPath, JSON.stringify(first.producerEvidence));
    const second = await read(path.dirname(nextDir));
    expect(second.producerEvidence).toEqual(first.producerEvidence);
    expect(await fs.readFile(result.evidencePath)).toEqual(original);
    expect(first.producerEvidence.entries[0]!.execution).toBeUndefined();
  });

  it("rejects an existing null bundle instead of using another bundle", async () => {
    const { evidenceDir, read, write } = fixture("qa-script-malformed-");
    await fs.mkdir(evidenceDir, { recursive: true });
    await write("latest-run.json", { qaEvidence: "bad.json" });
    await write("bad.json", null);
    await write("qa-evidence.json", buildScriptProducerEvidence({ status: "pass" }));
    await expect(read()).rejects.toThrow();
  });
});
