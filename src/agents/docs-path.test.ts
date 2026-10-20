import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveOpenClawReferencePaths } from "./docs-path.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makePackageRoot(prefix: string): Promise<string> {
  const root = tempDirs.make(prefix);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
  return root;
}

async function writeDocsJson(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "docs.json"), "{}\n");
}

describe("resolveOpenClawReferencePaths", () => {
  it.each(["workspace", "nested", "incomplete", "npm", "git"])(
    "resolves local references for %s roots",
    async (scenario) => {
      const root = await makePackageRoot("openclaw-reference-");
      const hasDocs = ["workspace", "nested", "git"].includes(scenario);
      if (hasDocs) {
        await writeDocsJson(root);
      }
      if (scenario === "git") {
        await fs.mkdir(path.join(root, ".git"));
      }
      const cwd = scenario === "nested" ? path.join(root, "dist", "agents") : root;
      await fs.mkdir(cwd, { recursive: true });
      if (scenario === "incomplete") {
        await fs.mkdir(path.join(root, "docs", "reference", "templates"), { recursive: true });
      }
      const references = await resolveOpenClawReferencePaths(
        scenario === "workspace" ? { workspaceDir: root } : { cwd },
      );
      const expected = {
        docsPath: hasDocs ? path.join(root, "docs") : null,
        ...(scenario === "git" || scenario === "npm"
          ? { sourcePath: scenario === "git" ? root : null }
          : {}),
      };
      if (scenario === "git") {
        expect(references).toEqual(expected);
      } else {
        expect(references).toMatchObject(expected);
      }
    },
  );
  it.each([
    ["unmounted", null, null],
    ["workspace", "/workspace/docs", "/workspace"],
    ["remote", "/remote/workspace/docs", "/remote/workspace"],
    ["remote-alias", "/remote/workspace/docs", "/remote/workspace"],
    ["read-only", "/agent/docs", "/agent"],
    ["bind", "/reference", null],
    ["shadow", null, "/workspace"],
    ["symlink", null, null],
    ["no-bridge", null, null],
  ])("advertises only readable sandbox references: %s", async (scenario, docsPath, sourcePath) => {
    const root = await makePackageRoot("openclaw-reference-sandbox-");
    await writeDocsJson(root);
    await fs.mkdir(path.join(root, ".git"));
    const workspace = tempDirs.make("openclaw-reference-workspace-");
    if (scenario === "symlink") {
      await fs.symlink(path.join(root, "docs"), path.join(workspace, "docs"), "dir");
    }
    if (scenario === "bind") {
      await writeDocsJson(workspace);
    }
    const workspaceDir =
      scenario === "remote-alias"
        ? path.join(workspace, "checkout")
        : ["workspace", "remote", "shadow"].includes(scenario)
          ? root
          : workspace;
    if (scenario === "remote-alias") {
      await fs.symlink(root, workspaceDir, "dir");
    }
    const sandbox = createSandboxTestContext({
      overrides: {
        workspaceDir,
        agentWorkspaceDir: scenario === "read-only" ? root : workspaceDir,
        workspaceAccess: scenario === "read-only" ? "ro" : "rw",
      },
      dockerOverrides: {
        tmpfs: scenario === "bind" ? ["/workspace/docs"] : [],
        binds:
          scenario === "bind"
            ? [`${root}/docs:/reference:ro`]
            : scenario === "shadow"
              ? [`${workspace}:/workspace/docs:ro`]
              : [],
      },
    });
    if (scenario === "remote" || scenario === "remote-alias") {
      sandbox.fsBridge = createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: "/remote/workspace",
          remoteAgentWorkspaceDir: "/remote/agent",
          async runRemoteShellScript() {
            throw new Error("Reference discovery must not execute remote commands");
          },
        },
      });
    } else if (scenario !== "no-bridge") {
      sandbox.fsBridge = createSandboxFsBridge({
        sandbox: {
          ...sandbox,
          backend: {
            async runShellCommand() {
              throw new Error("Reference discovery must not execute sandbox commands");
            },
          },
        },
      });
    }
    const references = await resolveOpenClawReferencePaths({
      workspaceDir: sandbox.workspaceDir,
      cwd: scenario === "remote-alias" ? workspaceDir : root,
      sandbox,
    });
    expect(references).toEqual({ docsPath, sourcePath });
  });
});
