import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { readValidatedQaMaturityScoreSources } from "./scorecard-taxonomy.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true });
  }
});

describe("maturity score rollups", () => {
  it("exclude Planned roadmap surfaces", () => {
    const scores = YAML.parse(fs.readFileSync("qa/maturity-scores.yaml", "utf8")) as {
      surfaces: Array<{
        id: string;
        scores: Record<"quality" | "completeness", { score: number; label: string }>;
        categories: Array<Record<"quality" | "completeness", { score: number; label: string }>>;
      }>;
    };
    const planned = scores.surfaces.find((surface) => surface.id === "windows-app");
    expect(planned).toBeDefined();
    for (const dimension of ["quality", "completeness"] as const) {
      planned!.scores[dimension] = { score: 100, label: "Clawesome" };
      for (const category of planned!.categories) {
        category[dimension] = { score: 100, label: "Clawesome" };
      }
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-maturity-rollups-"));
    tempDirs.push(dir);
    const scoresPath = path.join(dir, "maturity-scores.yaml");
    fs.writeFileSync(scoresPath, YAML.stringify(scores));

    expect(() => readValidatedQaMaturityScoreSources({ scoresPath })).not.toThrow();
  });
});
