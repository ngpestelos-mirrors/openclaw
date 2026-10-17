import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordMemoryArtifactWriteProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import type { MemoryPluginRuntime } from "../plugins/memory-state.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../plugins/memory-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";

// Load the real public plugin API without pulling bundled implementation into core type graphs.
const { createMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>("../../extensions/memory-core/runtime-api.js");

afterEach(() => {
  clearMemoryPluginState();
  resetPluginStateStoreForTests();
});

const refuseSearch = async () => {
  throw new Error("Bootstrap must not open search");
};
const noSearchRuntime = (): MemoryPluginRuntime => ({
  getMemorySearchManager: refuseSearch,
  resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
});

async function expectClassifications(
  workspaceDir: string,
  expected: Record<string, "agent" | "untrusted">,
  readSources?: Parameters<typeof classifyActiveMemoryWorkspacePaths>[0]["readSources"],
  legacyClassifier = false,
) {
  const registry = createEmptyPluginRegistry();
  const runtime = noSearchRuntime();
  if (legacyClassifier) {
    runtime.classifyWorkspaceMemoryPaths = async () => {
      throw new Error("Legacy classifiers cannot consume remote read identities");
    };
  }
  registry.memoryCapabilities.push({
    pluginId: "memory-fixture",
    memorySlotSelected: true,
    capability: { runtime },
  });
  await expect(
    withPluginRuntimeRegistryScope(registry, () =>
      classifyActiveMemoryWorkspacePaths({
        cfg: {},
        agentId: "main",
        workspaceDir,
        relativePaths: Object.keys(expected),
        readSources,
      }),
    ),
  ).resolves.toEqual({
    status: "classified",
    classifications: Object.entries(expected).map(([relativePath, originClass]) => ({
      relativePath,
      originClass,
    })),
  });
}

async function recordUntrusted(workspaceDir: string, relativePath: string) {
  await recordMemoryArtifactWriteProvenance({
    workspaceDir,
    relativePath,
    contentBefore: "",
    contentAfter: "Untrusted fixture",
    originClass: "untrusted",
    observedAt: 1,
  });
}

describe("workspace bootstrap with memory plugins", () => {
  it.each(["memory-core", "third-party"])(
    "loads personal files and quarantines an untrusted tool write with %s",
    async (pluginId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        registerMemoryCapability(pluginId, {
          runtime:
            pluginId === "memory-core"
              ? createMemoryRuntime({ runInBackgroundContext: (run) => run() })
              : noSearchRuntime(),
        });
        const workspaceDir = state.statePath("workspace");
        const profile = ensureProfileForEmail("person@example.test");
        ensureProfileForEmail("other@example.test");
        const personalDir = path.join(workspaceDir, "users", profile.id);
        const personalFile = path.join(personalDir, "USER.md");
        await fs.mkdir(personalDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared preferences");
        await fs.writeFile(personalFile, "Personal preferences");
        const warnings: string[] = [];
        const load = async () =>
          (
            await resolveBootstrapContextForRun({
              workspaceDir,
              config: {},
              agentId: "main",
              sessionKey: "agent:main:person",
              bootstrapUserProfileId: profile.id,
              warn: (message) => warnings.push(message),
            })
          ).contextFiles
            .filter((file) => file.path.endsWith("USER.md"))
            .map((file) => file.content);
        const initial = await load();
        expect(warnings).toEqual([]);
        expect(initial).toEqual(["Shared preferences", "Personal preferences"]);
        const operations = withMemoryWriteProvenance(
          {
            readFile: (file: string) => fs.readFile(file),
            writeFile: (file: string, content: string) => fs.writeFile(file, content),
          },
          createMemoryWriteProvenanceObserver({
            mutationRoot: workspaceDir,
            workspaceDir,
            resolveOriginClass: () => "untrusted",
          }),
        );
        await operations.writeFile(personalFile, "Untrusted preferences");
        expect(await load()).toEqual(["Shared preferences"]);
      });
    },
  );
  it("uses canonical local targets and rejects missing files or escaping symlinks", async () => {
    await withStateDirEnv("bootstrap-memory-paths-", async ({ tempRoot }) => {
      const workspaceDir = path.join(tempRoot, "workspace");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "tainted.md"), "Untrusted fixture");
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Trusted memory");
      await fs.writeFile(path.join(tempRoot, "USER.md"), "Outside profile");
      await fs.symlink(
        path.join(workspaceDir, "memory", "tainted.md"),
        path.join(workspaceDir, "USER.md"),
      );
      await fs.symlink(
        path.join(tempRoot, "USER.md"),
        path.join(workspaceDir, "memory", "escape.md"),
      );
      await recordUntrusted(workspaceDir, "memory/tainted.md");
      await expectClassifications(workspaceDir, {
        "USER.md": "untrusted",
        "MEMORY.md": "agent",
        "memory/escape.md": "untrusted",
        "memory/missing.md": "untrusted",
      });
    });
  });

  it.each([false, true])(
    "uses pinned remote identities, never local decoys (legacy classifier=%s)",
    async (legacyClassifier) => {
      await withStateDirEnv("bootstrap-remote-memory-plugin-", async ({ tempRoot }) => {
        const workspaceDir = path.join(tempRoot, "gateway-decoy");
        await fs.mkdir(workspaceDir);
        await fs.writeFile(path.join(workspaceDir, "USER.md"), "Local decoy");
        await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Local decoy");
        await recordUntrusted(workspaceDir, "memory/tainted.md");
        const invalid = [
          "../USER.md",
          "/USER.md",
          "memory/../USER.md",
          "C:\\USER.md",
          "memory/./note.md",
          "memory/bad\0.md",
          "memory/dreaming/note.md",
          "notes/USER.md",
        ];
        await expectClassifications(
          workspaceDir,
          {
            "USER.md": "agent",
            "MEMORY.md": "untrusted",
            "alias/MEMORY.md": "untrusted",
            "missing/MEMORY.md": "untrusted",
            ...Object.fromEntries(invalid.map((file) => [file, "untrusted" as const])),
          },
          [
            { relativePath: "USER.md", canonicalRelativePath: "USER.md" },
            { relativePath: "MEMORY.md" },
            { relativePath: "alias/MEMORY.md", canonicalRelativePath: "memory/tainted.md" },
            ...invalid.map((relativePath) => ({
              relativePath,
              canonicalRelativePath: relativePath,
            })),
          ],
          legacyClassifier,
        );
      });
    },
  );
});
