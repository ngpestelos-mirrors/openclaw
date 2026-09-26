import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { resolveMergeHeadDiffBase } from "./merge-head-diff-base.mjs";
import { createNativeTypeScriptParser } from "./native-typescript.mts";
import { walkTypeScriptTokens } from "./ts-guard-utils.mts";

type SourceChange = { path: string; before: string; after: string };
const TYPESCRIPT_PATH = /\.(?:ts|tsx|mts|cts)$/u;

/** Returns a syntax signature, or undefined when trivia could carry compiler semantics. */
function syntaxSignature(sourceFile: ts.SourceFile) {
  const source = sourceFile.getFullText();
  // Each token keeps its preceding gap: "" adjacent, " " same-line trivia, "\n" line terminator.
  const tokens: Array<[string, string]> = [];
  // Tagged JSDoc can reference symbols (`{@link Foo}`, `@see Foo`), so it stays pinned in place.
  const docs: Array<[number, string]> = [];
  let gap = "";
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
      // TypeScript matches pragma names case-insensitively.
      if (/@ts-|@jsx/iu.test(text) || text.startsWith("///")) {
        valid = false;
      } else if (text.startsWith("/**") && text.includes("@")) {
        docs.push([tokens.length, text]);
      }
    } else if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) {
      if (kind <= ts.SyntaxKind.NonTextFileMarkerTrivia) {
        valid = false;
      }
      tokens.push([gap, text]);
      gap = "";
      return;
    }
    // Adjacency matters too: the parser rescans `>` together with an adjacent `=` or `>`.
    gap = gap === "\n" || /[\r\n\u2028\u2029]/u.test(text) ? "\n" : " ";
  });
  return valid && end === source.length ? JSON.stringify([tokens, docs]) : undefined;
}

/** Compare syntax in one native snapshot, preserving literal bytes, adjacency, and ASI boundaries. */
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
      const before = syntaxSignature(parsed[offset]!);
      return before !== undefined && before === syntaxSignature(parsed[offset + 1]!)
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
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  // Lossy decoding would map different invalid bytes to the same replacement text.
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    const resolvedBase = resolveMergeHeadDiffBase({ base, head: "HEAD", cwd });
    const mergeBase = git(["merge-base", resolvedBase, "HEAD"]).toString().trim();
    const changes: SourceChange[] = [];
    for (const file of paths.filter((candidate) => TYPESCRIPT_PATH.test(candidate))) {
      try {
        if (!lstatSync(path.resolve(cwd, file)).isFile()) {
          continue;
        }
        const entry = git(["ls-tree", "-z", mergeBase, "--", `:(literal)${file}`]).toString();
        if (!/^100(?:644|755) blob [0-9a-f]+\t/u.test(entry)) {
          continue;
        }
        changes.push({
          path: file,
          before: utf8.decode(git(["show", `${mergeBase}:${file}`])),
          after: utf8.decode(readFileSync(path.resolve(cwd, file))),
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
