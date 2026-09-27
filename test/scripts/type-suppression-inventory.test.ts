// Type Suppression Inventory tests cover AST detection and the repository suppression ratchet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTypeSuppressionReport } from "../../scripts/type-suppression-inventory.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-type-suppressions-"));
  temporaryDirectories.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("type suppression inventory", () => {
  it.each(["\n", "\r\n"])("reports comment markers once with %j line endings", (newline) => {
    const fixtureRoot = createFixture({
      "src/comments.ts": [
        'const text = "\u{1f680} @ts-expect-error string";',
        "const template = `@ts-expect-error template`;",
        "function example() {",
        "  /* @ts-expect-error first",
        "   * @ts-expect-error second",
        "   */",
        "} // @ts-expect-error trailing",
        'consume("\u96ea"); /* @ts-expect-error left */ /* @ts-expect-error right */',
        "consume(",
        "  1",
        "  // @ts-expect-error closing token",
        ");",
        "// @ts-expect-error eof",
      ].join(newline),
    });

    const report = collectTypeSuppressionReport({
      files: ["src/comments.ts"],
      repoRoot: fixtureRoot,
    });

    expect(report.findings).toEqual(
      [
        { excerpt: "@ts-expect-error first", line: 4 },
        { excerpt: "@ts-expect-error second", line: 5 },
        { excerpt: "@ts-expect-error trailing", line: 7 },
        { excerpt: "@ts-expect-error left */", line: 8 },
        { excerpt: "@ts-expect-error right */", line: 8 },
        { excerpt: "@ts-expect-error closing token", line: 11 },
        { excerpt: "@ts-expect-error eof", line: 13 },
      ].map(({ excerpt, line }) => ({
        excerpt,
        line,
        file: "src/comments.ts",
        kind: "expect-error",
      })),
    );
  });

  it("detects syntax suppressions without counting prose", () => {
    const fixtureRoot = createFixture({
      "src/example.ts": `
        const prose = "as any and @ts-expect-error";
        const interpolated = \`value: \${value}\`;
        const first = value as any;
        const second = <any>value;
        const third = value as /* preserved trivia */ any;
        const fourth = </* preserved trivia */ any>value;
        const fifth = value as // preserved line trivia
          any;
        const typeOnly: any = value;
        // @ts-expect-error invalid contract fixture
        consume({ invalid: true });
      `,
      "src/plain.ts": "export const value = 1;",
    });

    const report = collectTypeSuppressionReport({
      files: ["src/example.ts", "src/plain.ts"],
      repoRoot: fixtureRoot,
    });

    expect(report.summary).toMatchObject({
      findingCount: 6,
      kindCounts: {
        "as-any": 3,
        "expect-error": 1,
        "type-assertion-any": 2,
      },
      scannedFileCount: 2,
      touchedFileCount: 1,
    });
    expect(report.findings.map(({ kind, line }) => ({ kind, line }))).toEqual([
      { kind: "as-any", line: 4 },
      { kind: "type-assertion-any", line: 5 },
      { kind: "as-any", line: 6 },
      { kind: "type-assertion-any", line: 7 },
      { kind: "as-any", line: 8 },
      { kind: "expect-error", line: 11 },
    ]);
  });

  it("keeps unchecked any casts at zero and negative type assertions explicit", () => {
    const report = collectTypeSuppressionReport({ repoRoot });

    expect(report.summary.kindCounts["as-any"]).toBe(0);
    expect(report.summary.kindCounts["type-assertion-any"]).toBe(0);
    const whatsappFixture = "extensions/whatsapp/src/approval-reactions.test.ts";
    const invalidKindAssertion = report.findings.find(
      (finding) => finding.file === whatsappFixture && finding.kind === "expect-error",
    );
    if (!invalidKindAssertion) {
      throw new Error("Missing WhatsApp invalid approval-kind fixture assertion");
    }
    // Bind this synthetic allowance to its invalid inputs, not just reusable marker text.
    expect(
      fs
        .readFileSync(path.join(repoRoot, whatsappFixture), "utf8")
        .split(/\r?\n/)
        .slice(invalidKindAssertion.line - 10, invalidKindAssertion.line + 6)
        .join("\n"),
    ).toBe(`  it.each([undefined, "invalid"] as const)(
    "rejects reaction targets without a valid explicit approval kind: %s",
    async (approvalKind) => {
      expect(
        await registerWhatsAppApprovalReactionTarget({
          accountId: "default",
          remoteJid: "15551230000@s.whatsapp.net",
          messageId: "msg-invalid-kind",
          approvalId: "exec-invalid-kind",
          // @ts-expect-error Runtime callers must not register missing or unsupported kinds.
          approvalKind,
          allowedDecisions: ["allow-once"],
        }),
      ).toBeNull();
    },
  );`);
    // Track intentional suppressions without coupling the ratchet to unrelated line shifts.
    expect(
      report.findings
        .filter((finding) => finding.kind === "expect-error")
        .map((finding) => `${finding.file}:${finding.excerpt}`)
        .toSorted(),
    ).toEqual(
      [
        "extensions/openai/realtime-quicksilver-session-lifecycle.test.ts:@ts-expect-error JavaScript callers must still fail before reserving a native session.",
        "extensions/whatsapp/src/approval-reactions.test.ts:@ts-expect-error Runtime callers must not register missing or unsupported kinds.",
        "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks selected column string literals.",
        "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks table string literals.",
        "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks where-reference string literals.",
        "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks grouped column string literals.",
        "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks order references and selected aliases.",
        "src/infra/net/fetch-guard.socks.test.ts:@ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.",
        "src/infra/net/fetch-guard.socks.test.ts:@ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.",
        "src/infra/net/fetch-guard.socks.test.ts:@ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.",
        "test/type-contracts/plugin-entry-hook-options.ts:@ts-expect-error Trigger eligibility is only supported for before_agent_reply.",
        "test/type-contracts/plugin-entry-hook-options.ts:@ts-expect-error An empty trigger list cannot prove that a hook is inactive.",
        "test/type-contracts/plugin-entry-hook-options.ts:@ts-expect-error Tool authority is only supported for before_prompt_build.",
        "src/plugins/registry.diagnostics.test.ts:@ts-expect-error JavaScript plugins may omit the required supplement builder.",
        "src/plugins/registry.diagnostics.test.ts:@ts-expect-error JavaScript plugins may omit the required hosted-media resolver.",
        "src/plugins/registry.diagnostics.test.ts:@ts-expect-error Unknown JavaScript hook names must produce a diagnostic.",
        "src/plugins/registry.diagnostics.test.ts:@ts-expect-error Untyped hook input reaches the existing rejection/coercion path.",
        "src/plugins/registry.diagnostics.test.ts:@ts-expect-error Closed registration must stop before coercing untyped hook input.",
      ].toSorted(),
    );
  });
});
