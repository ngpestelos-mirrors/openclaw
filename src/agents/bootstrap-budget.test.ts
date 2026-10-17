/** Tests bootstrap context truncation accounting and user-facing warning metadata. */
import { describe, expect, it } from "vitest";
import { buildBootstrapPromptWarning } from "./bootstrap-budget-warning.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapBudgetState,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
  resolveBootstrapWarningSignaturesSeen,
} from "./bootstrap-budget.js";
import type { BootstrapInjectionStat } from "./bootstrap-budget.types.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function stat(name: string, rawChars: number, injectedChars: number): BootstrapInjectionStat {
  return {
    name,
    path: `/tmp/${name}`,
    missing: false,
    rawChars,
    injectedChars,
    truncated: injectedChars < rawChars,
  };
}

function bootstrapFile(
  name: WorkspaceBootstrapFile["name"],
  content: string,
  path = `/tmp/${name}`,
): WorkspaceBootstrapFile {
  return { name, path, content, missing: false };
}

function truncatedAnalysis() {
  return analyze([stat("AGENTS.md", 150, 100)], 120, 200);
}

function analyze(
  files: BootstrapInjectionStat[],
  bootstrapMaxChars = 20_000,
  bootstrapTotalMaxChars = 60_000,
) {
  return analyzeBootstrapBudget({ files, bootstrapMaxChars, bootstrapTotalMaxChars });
}

function seenSignatures(
  bootstrapTruncation: NonNullable<
    Parameters<typeof resolveBootstrapWarningSignaturesSeen>[0]
  >["bootstrapTruncation"],
) {
  return resolveBootstrapWarningSignaturesSeen({ bootstrapTruncation });
}

describe("buildBootstrapBudgetState", () => {
  it("composes configured limits, ordered injection stats, and warning state", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      bootstrapFile("AGENTS.md", "a".repeat(8)),
      bootstrapFile("SOUL.md", "b".repeat(8)),
    ];

    const state = buildBootstrapBudgetState({
      config: {
        agents: { defaults: { bootstrapMaxChars: 10, bootstrapTotalMaxChars: 12 } },
      },
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: [
          { path: "/tmp/AGENTS.md", content: "a".repeat(8) },
          { path: "/tmp/SOUL.md", content: "b".repeat(4) },
        ],
      }),
    });

    expect(state).toMatchObject({
      bootstrapMaxChars: 10,
      bootstrapTotalMaxChars: 12,
      bootstrapPromptWarningMode: "always",
      bootstrapAnalysis: { totalNearLimit: true },
      bootstrapPromptWarning: { warningShown: true },
    });
    expect(state.bootstrapAnalysis.truncatedFiles[0]?.causes).toEqual(["total-limit"]);
  });
});

describe("buildBootstrapInjectionStats", () => {
  it("gives a budget-dropped file zero injected chars when a sibling shares its basename", () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      bootstrapFile("AGENTS.md", "a".repeat(1_000), "/tmp/workspace/AGENTS.md"),
      bootstrapFile("AGENTS.md", "b".repeat(500), "/tmp/workspace/packages/core/AGENTS.md"),
    ];

    const stats = buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    const analysis = analyze(stats, 20_000, 1_000);

    expect(stats[1]).toMatchObject({
      path: "/tmp/workspace/packages/core/AGENTS.md",
      rawChars: 500,
      injectedChars: 0,
      truncated: true,
    });
    expect(analysis.totals.injectedChars).toBe(1_000);
    expect(analysis.truncatedFiles.map((file) => file.path)).toEqual([
      "/tmp/workspace/packages/core/AGENTS.md",
    ]);
    expect(analysis.truncatedFiles[0]?.causes).toEqual(["total-limit"]);
  });

  it("derives names for path-only files supplied by bootstrap hooks", () => {
    const pathOnlyFile = {
      path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
      content: "remember",
      missing: false,
    } as unknown as WorkspaceBootstrapFile;
    const stats = buildBootstrapInjectionStats({
      bootstrapFiles: [pathOnlyFile],
      injectedFiles: [pathOnlyFile],
    });
    const analysis = analyze(stats);

    expect(analysis.files).toEqual([
      expect.objectContaining({
        name: "SELF_IMPROVEMENT_REMINDER.md",
        path: "/tmp/SELF_IMPROVEMENT_REMINDER.md",
        injectedChars: 8,
        truncated: false,
      }),
    ]);
  });
});

describe("analyzeBootstrapBudget", () => {
  it("reports causes while excluding missing-file markers from file totals", () => {
    const analysis = analyze(
      [
        stat("AGENTS.md", 150, 120),
        {
          name: "IDENTITY.md",
          path: "/tmp/IDENTITY.md",
          missing: true,
          rawChars: 0,
          injectedChars: 40,
          truncated: false,
        },
        stat("SOUL.md", 50, 40),
      ],
      120,
      200,
    );
    expect(analysis.hasTruncation).toBe(true);
    expect(analysis.totalNearLimit).toBe(false);
    expect(analysis.truncatedFiles).toHaveLength(2);
    expect(analysis.totals).toMatchObject({ rawChars: 200, injectedChars: 160 });
    expect(analysis.files[1]).toMatchObject({ nearLimit: false, causes: [] });
    expect(analysis.truncatedFiles[0]?.causes).toEqual(["per-file-limit"]);
    expect(analysis.truncatedFiles[1]?.causes).toContain("total-limit");
  });

  it("distinguishes lower per-file and exhausted total limits for USER.md", () => {
    const lowerPerFile = analyze([stat("USER.md", 3_000, 2_000)], 2_000);
    expect(lowerPerFile.truncatedFiles[0]?.effectiveFileLimit).toBe(2_000);
    expect(lowerPerFile.truncatedFiles[0]?.causes).toEqual(["per-file-limit"]);

    const exhaustedTotal = analyze(
      [stat("AGENTS.md", 2_000, 2_000), stat("USER.md", 5_000, 0)],
      20_000,
      2_040,
    );
    expect(exhaustedTotal.truncatedFiles[0]?.causes).toContain("total-limit");

    const laterExhaustion = analyze(
      [stat("USER.md", 5_000, 4_000), stat("SOUL.md", 100, 0)],
      20_000,
      4_040,
    );
    const user = laterExhaustion.truncatedFiles.find((file) => file.name === "USER.md");
    const soul = laterExhaustion.truncatedFiles.find((file) => file.name === "SOUL.md");
    expect(user?.causes).toStrictEqual(["per-file-limit"]);
    expect(soul?.causes).toContain("total-limit");
  });
});

describe("bootstrap prompt warnings", () => {
  it("builds a concise agent notice without raw truncation diagnostics", () => {
    const notice = buildBootstrapPromptWarningNotice([
      "AGENTS.md: 200 raw -> 0 injected",
      "If unintentional, raise agents.defaults.bootstrapMaxChars.",
    ]);

    expect(notice).toContain("[Bootstrap truncation warning]");
    expect(notice).toContain("Treat Project Context as partial");
    expect(notice).not.toContain("raw ->");
    expect(notice).not.toContain("bootstrapMaxChars");
  });

  it("resolves seen signatures from report history or legacy single signature", () => {
    expect(
      seenSignatures({
        warningSignaturesSeen: ["sig-a", " ", "sig-b", "sig-a"],
        promptWarningSignature: "legacy-ignored",
      }),
    ).toEqual(["sig-a", "sig-b"]);

    expect(seenSignatures({ promptWarningSignature: "legacy-only" })).toEqual(["legacy-only"]);

    expect(resolveBootstrapWarningSignaturesSeen(undefined)).toStrictEqual([]);
  });

  it("ignores single-signature fallback when warning mode is off", () => {
    expect(
      seenSignatures({ warningMode: "off", promptWarningSignature: "off-mode-signature" }),
    ).toStrictEqual([]);

    expect(
      seenSignatures({
        warningMode: "off",
        warningSignaturesSeen: ["prior-once-signature"],
        promptWarningSignature: "off-mode-signature",
      }),
    ).toEqual(["prior-once-signature"]);
  });

  it("respects off/always warning modes", () => {
    const analysis = truncatedAnalysis();
    const seen = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const off = buildBootstrapPromptWarning({
      analysis,
      mode: "off",
      seenSignatures: seen.warningSignaturesSeen,
      previousSignature: seen.signature,
    });
    expect(off.warningShown).toBe(false);
    expect(off.lines).toStrictEqual([]);

    const always = buildBootstrapPromptWarning({
      analysis,
      mode: "always",
      seenSignatures: seen.warningSignaturesSeen,
      previousSignature: seen.signature,
    });
    expect(always.warningShown).toBe(true);
    expect(always.lines).toStrictEqual([
      [
        "[Bootstrap truncation warning]",
        "Some workspace bootstrap files were truncated before Project Context injection.",
        "Treat Project Context as partial and read the relevant files directly if details seem missing.",
      ].join("\n"),
    ]);
  });

  it("builds truncation report metadata from analysis + warning decision", () => {
    const analysis = truncatedAnalysis();
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const meta = buildBootstrapTruncationReportMeta({
      analysis,
      warningMode: "once",
      warning,
    });
    expect(meta).toMatchObject({
      warningMode: "once",
      warningShown: true,
      truncatedFiles: 1,
      nearLimitFiles: 1,
      promptWarningSignature: warning.signature,
      warningSignaturesSeen: [warning.signature],
    });
  });
});
