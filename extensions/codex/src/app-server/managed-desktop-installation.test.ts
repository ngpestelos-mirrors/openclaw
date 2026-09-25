import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  resolveMacOSDesktopCodexAppPathCandidateForBundle,
  resolveMacOSDesktopCodexAppPathCandidates,
} from "./desktop-app-paths.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  isCodexManagedDesktopAppPath,
  publishCodexManagedDesktopSelection,
  readCodexManagedDesktopSelection,
  resolveCodexManagedDesktopAppPath,
  resolveCodexManagedDesktopReceiptPath,
  type CodexManagedDesktopSelection,
} from "./managed-desktop-installation.js";

const first: CodexManagedDesktopSelection = {
  version: 1,
  appName: "ChatGPT.app",
  generation: "build-1",
};
const second: CodexManagedDesktopSelection = { ...first, generation: "build-2" };
const authority = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });

async function stage(root: string, selection: CodexManagedDesktopSelection): Promise<string> {
  const bundle = resolveCodexManagedDesktopAppPath(selection, root);
  const resources = path.join(bundle, "Contents", "Resources");
  await fs.mkdir(resources, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(resources, "codex"), selection.generation, { mode: 0o700 });
  return bundle;
}

function expectedReceipt(root: string) {
  const previous = readCodexManagedDesktopSelection(root);
  return previous
    ? { contents: previous.receiptContents, identity: previous.receiptIdentity }
    : undefined;
}

describe("immutable managed Codex desktop selection", () => {
  it("selects a new complete generation without changing resources retained by an old client", async () => {
    await withTempDir("codex-managed-desktop-", async (root) => {
      const oldBundle = await stage(root, first);
      await publishCodexManagedDesktopSelection({
        root,
        selection: first,
        expectedReceipt: undefined,
        ...authority(),
      });
      const previous = expectedReceipt(root);
      const oldClientCommand = path.join(oldBundle, "Contents", "Resources", "codex");
      const oldFingerprint = await readMacOSDesktopGenerationFingerprint([], root);
      const nextBundle = await stage(root, second);
      await publishCodexManagedDesktopSelection({
        root,
        selection: second,
        expectedReceipt: previous,
        ...authority(),
      });

      expect(resolveMacOSDesktopCodexAppPathCandidates("darwin", root)[0]?.appBundlePath).toBe(
        nextBundle,
      );
      expect(await fs.readFile(oldClientCommand, "utf8")).toBe("build-1");
      expect(isCodexManagedDesktopAppPath(oldBundle, root)).toBe(true);
      expect(
        resolveMacOSDesktopCodexAppPathCandidateForBundle(oldBundle, {
          platform: "darwin",
          managedRoot: root,
        })?.appServerCommandPath,
      ).toBe(oldClientCommand);
      expect(await readMacOSDesktopGenerationFingerprint([], root)).not.toBe(oldFingerprint);
      expect(resolveMacOSDesktopGenerationWatchPaths([], root)).toContain(root);
    });
  });

  it("rejects a stale writer even when another writer replaces the receipt with identical bytes", async () => {
    await withTempDir("codex-managed-stale-", async (root) => {
      await stage(root, first);
      await stage(root, second);
      await publishCodexManagedDesktopSelection({
        root,
        selection: first,
        expectedReceipt: undefined,
        ...authority(),
      });
      const before = expectedReceipt(root);
      const receipt = resolveCodexManagedDesktopReceiptPath(root);
      await fs.writeFile(`${receipt}.replacement`, before?.contents ?? "", { mode: 0o600 });
      await fs.rename(`${receipt}.replacement`, receipt);
      await expect(
        publishCodexManagedDesktopSelection({
          root,
          selection: second,
          expectedReceipt: before,
          ...authority(),
        }),
      ).rejects.toThrow("selection changed");
      expect(readCodexManagedDesktopSelection(root)?.selection).toEqual(first);
    });
  });

  it("does not publish after authority is revoked at the atomic commit boundary", async () => {
    await withTempDir("codex-managed-revoked-", async (root) => {
      await stage(root, first);
      let checks = 0;
      await expect(
        publishCodexManagedDesktopSelection({
          root,
          selection: first,
          expectedReceipt: undefined,
          signal: new AbortController().signal,
          assertCurrent: () => {
            checks += 1;
            if (checks >= 4) {
              throw new Error("maintenance authority revoked");
            }
          },
        }),
      ).rejects.toThrow("maintenance authority revoked");
      expect(readCodexManagedDesktopSelection(root)).toBeUndefined();
    });
  });

  it.each(["../outside", "nested/path", "..", ""])(
    "refuses invalid generation %j",
    (generation) => {
      expect(() => resolveCodexManagedDesktopAppPath({ ...first, generation })).toThrow("Invalid");
    },
  );

  it("ignores a receipt with an unowned path, an unknown app, or a symlinked generation", async () => {
    await withTempDir("codex-managed-invalid-", async (root) => {
      const bundle = await stage(root, first);
      const receipt = resolveCodexManagedDesktopReceiptPath(root);
      for (const value of [
        { ...first, generation: "../../escape" },
        { ...first, appName: "Other.app" },
        { ...first, appBundlePath: "/tmp/arbitrary.app" },
      ]) {
        await fs.writeFile(receipt, JSON.stringify(value), { mode: 0o600 });
        expect(() => readCodexManagedDesktopSelection(root)).toThrow();
        expect(resolveMacOSDesktopCodexAppPathCandidates("darwin", root)[0]?.appBundlePath).toBe(
          "/Applications/ChatGPT.app",
        );
      }
      const generation = path.dirname(bundle);
      await fs.rename(generation, `${generation}.retained`);
      await fs.symlink(`${generation}.retained`, generation);
      await fs.writeFile(receipt, JSON.stringify(first), { mode: 0o600 });
      expect(() => readCodexManagedDesktopSelection(root)).toThrow();
      expect(isCodexManagedDesktopAppPath(bundle, root)).toBe(false);
      expect(resolveMacOSDesktopCodexAppPathCandidates("darwin", root)[0]?.appBundlePath).toBe(
        "/Applications/ChatGPT.app",
      );
    });
  });

  it("ignores a symlinked receipt and watches the existing ancestor before first installation", async () => {
    await withTempDir("codex-managed-first-", async (root) => {
      const futureRoot = path.join(root, "future", "Codex");
      expect(resolveMacOSDesktopGenerationWatchPaths([], futureRoot)).toContain(root);
      const source = path.join(root, "untrusted.json");
      await fs.writeFile(source, JSON.stringify(first), { mode: 0o600 });
      await fs.symlink(source, resolveCodexManagedDesktopReceiptPath(root));
      expect(() => readCodexManagedDesktopSelection(root)).toThrow("regular file");
      expect(resolveMacOSDesktopCodexAppPathCandidates("darwin", root)[0]?.appBundlePath).toBe(
        "/Applications/ChatGPT.app",
      );
      await expect(readMacOSDesktopGenerationFingerprint([], root)).resolves.toBeTypeOf("string");
    });
  });
});
