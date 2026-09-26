import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { resolveMergeHeadDiffBase } from "./merge-head-diff-base.mjs";
import { createNativeTypeScriptParser } from "./native-typescript.mts";
import { walkTypeScriptTokens } from "./ts-guard-utils.mts";

type SourceChange = { path: string; before: string; after: string };
const TYPESCRIPT_PATH = /\.(?:ts|tsx|mts|cts)$/u;

function significantTokens(sourceFile: ts.SourceFile) {
  const source = sourceFile.getFullText();
  const tokens: Array<{ text: string; lineBreak: boolean }> = [];
  let lineBreak = false;
  let end = 0;
  let valid = true;
  walkTypeScriptTokens(sourceFile, (kind, pos, tokenEnd) => {
    // The scanner may skip unsupported trivia (for example a hashbang).
    if (pos !== end || tokenEnd < pos) {
      valid = false;
    }
    end = tokenEnd;
    const text = source.slice(pos, end);
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      if (/@ts-|@jsx/u.test(text) || text.startsWith("///")) {
        valid = false;
      }
    } else if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) {
      if (kind <= ts.SyntaxKind.NonTextFileMarkerTrivia) {
        valid = false;
      }
      tokens.push({ text, lineBreak });
      lineBreak = false;
      return;
    }
    lineBreak ||= /[\r\n\u2028\u2029]/u.test(text);
  });
  return valid && end === source.length ? tokens : undefined;
}

/** Compare syntax in one native snapshot, preserving literal bytes and ASI boundaries. */
export function findTypecheckInertSources(changes: readonly SourceChange[]): string[] {
  const candidates = changes.filter((change) => TYPESCRIPT_PATH.test(change.path));
  try {
    using parser = createNativeTypeScriptParser();
    const sources = candidates.flatMap((change, index) =>
      [change.before, change.after].map((text, version) => ({
        fileName: `.typecheck-inert/${index}/${version}/${path.basename(change.path)}`,
        text,
      })),
    );
    const parsed = parser.parseSourceFiles(sources);
    return candidates.flatMap((change, index) => {
      const offset = index * 2;
      if (
        parser.getSyntacticDiagnostics(sources[offset]!.fileName).length ||
        parser.getSyntacticDiagnostics(sources[offset + 1]!.fileName).length
      ) {
        return [];
      }
      const before = significantTokens(parsed[offset]!);
      const after = significantTokens(parsed[offset + 1]!);
      return before &&
        after &&
        before.length === after.length &&
        before.every(
          (token, i) => token.text === after[i]!.text && token.lineBreak === after[i]!.lineBreak,
        )
        ? [change.path]
        : [];
    });
  } catch {
    return [];
  }
}

/** Only existing regular files with a regular merge-base blob can be omitted. */
export function findTypecheckInertPaths({
  paths,
  base,
  cwd = process.cwd(),
}: {
  paths: readonly string[];
  base: string;
  cwd?: string;
}): string[] {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    const resolvedBase = resolveMergeHeadDiffBase({ base, head: "HEAD", cwd });
    const mergeBase = git(["merge-base", resolvedBase, "HEAD"]).trim();
    const changes: SourceChange[] = [];
    for (const file of paths.filter((candidate) => TYPESCRIPT_PATH.test(candidate))) {
      try {
        if (!lstatSync(path.resolve(cwd, file)).isFile()) {
          continue;
        }
        const entry = git(["ls-tree", "-z", mergeBase, "--", `:(literal)${file}`]);
        if (!/^100(?:644|755) blob [0-9a-f]+\t/u.test(entry)) {
          continue;
        }
        changes.push({
          path: file,
          before: git(["show", `${mergeBase}:${file}`]),
          after: readFileSync(path.resolve(cwd, file), "utf8"),
        });
      } catch {
        // Missing/deleted paths and unreadable blobs retain their normal lanes.
      }
    }
    return findTypecheckInertSources(changes);
  } catch {
    return [];
  }
}
