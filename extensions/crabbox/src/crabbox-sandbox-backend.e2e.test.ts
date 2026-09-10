// Live proof against a real Crabbox provider. Opt in with:
//   OPENCLAW_E2E_CRABBOX=1 OPENCLAW_E2E_CRABBOX_PROVIDER=daytona OPENCLAW_E2E_CRABBOX_CLASS=small \
//   OPENCLAW_E2E_CRABBOX_BINARY=/path/to/crabbox node scripts/run-vitest.mjs extensions/crabbox/src/crabbox-sandbox-backend.e2e.test.ts
// The provider must support fixed lease IDs and be authenticated for the test process.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
} from "./crabbox-sandbox-backend.js";
import { CRABBOX_SANDBOX_LEASE_ID_PATTERN } from "./crabbox-sandbox-lease.js";

const LIVE = process.env.OPENCLAW_E2E_CRABBOX === "1";
const LIVE_TIMEOUT_MS = 15 * 60_000;

describe.skipIf(!LIVE)("crabbox sandbox backend (live)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.toReversed()) {
      await cleanup();
    }
  });

  it(
    "leases a box, executes and bridges files through it, adopts the lease on replay, and stops it",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crabbox-e2e-"));
      cleanups.push(() => fs.rm(workspaceDir, { recursive: true, force: true }));
      await fs.writeFile(path.join(workspaceDir, "marker.txt"), "crabbox-sandbox-e2e\n");
      const scopeKey = `e2e:${path.basename(workspaceDir)}`;
      const pluginConfig = {
        ...(process.env.OPENCLAW_E2E_CRABBOX_PROVIDER
          ? { provider: process.env.OPENCLAW_E2E_CRABBOX_PROVIDER }
          : {}),
        ...(process.env.OPENCLAW_E2E_CRABBOX_CLASS
          ? { class: process.env.OPENCLAW_E2E_CRABBOX_CLASS }
          : {}),
        ...(process.env.OPENCLAW_E2E_CRABBOX_BINARY
          ? { binary: process.env.OPENCLAW_E2E_CRABBOX_BINARY }
          : {}),
        ttl: "30m",
        idleTimeout: "15m",
      };
      const dependencies = { openclawRoot: process.cwd(), pluginConfig };
      const factory = createCrabboxSandboxBackendFactory(dependencies);
      const manager = createCrabboxSandboxBackendManager(dependencies);
      const params: CreateSandboxBackendParams = {
        sessionKey: scopeKey,
        scopeKey,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: {
          mode: "all",
          backend: "crabbox",
          scope: "session",
          workspaceAccess: "rw",
          workspaceRoot: "/workspace",
          dockerTmpfsSource: "default",
          docker: {
            image: "unused",
            binds: [],
          } as unknown as CreateSandboxBackendParams["cfg"]["docker"],
          ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
          browser: createSandboxBrowserConfig(),
          tools: { allow: [], deny: [] } as CreateSandboxBackendParams["cfg"]["tools"],
          prune: createSandboxPruneConfig(),
        },
      };
      const handle: SandboxBackendHandle = await factory(params);
      expect(handle.id).toBe("crabbox");
      const leaseId = handle.runtimeId;
      expect(leaseId).toMatch(CRABBOX_SANDBOX_LEASE_ID_PATTERN);
      const entry = {
        containerName: leaseId,
        backendId: "crabbox",
        sessionKey: scopeKey,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        image: "e2e",
      };
      const config = {} as Parameters<typeof manager.describeRuntime>[0]["config"];
      cleanups.push(async () => {
        await manager.removeRuntime({ entry, config }).catch(() => undefined);
      });

      // Exec runs on the box; the seeded workspace carries the marker file.
      const exec = await handle.runShellCommand({
        script: `cd ${handle.workdir} && cat marker.txt && uname -s && id -un`,
      });
      const output = exec.stdout.toString("utf8");
      expect(exec.code).toBe(0);
      expect(output).toContain("crabbox-sandbox-e2e");
      expect(output).toContain("Linux");

      // File tools go through the remote bridge; the write must not touch the host copy.
      const bridge = handle.createFsBridge?.({
        sandbox: {
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          containerName: leaseId,
          containerWorkdir: handle.workdir,
          docker: {},
          backend: handle,
        },
      });
      expect(bridge).toBeDefined();
      await bridge!.writeFile({
        filePath: "bridge.txt",
        cwd: handle.workdir,
        data: "written-through-bridge\n",
      });
      const readBack = await bridge!.readFile({ filePath: "bridge.txt", cwd: handle.workdir });
      expect(readBack.toString("utf8")).toBe("written-through-bridge\n");
      await expect(fs.access(path.join(workspaceDir, "bridge.txt"))).rejects.toThrow();

      // A later factory call with the registered runtime adopts the same lease.
      const again = await factory({ ...params, registeredRuntimeIds: [leaseId] });
      expect(again.runtimeId).toBe(leaseId);
      await expect(manager.describeRuntime({ entry, config })).resolves.toMatchObject({
        running: true,
      });

      await manager.removeRuntime({ entry, config });
      await expect(manager.describeRuntime({ entry, config })).resolves.toMatchObject({
        running: false,
      });

      // Recreate: the stopped id is terminal in Crabbox, so a fresh lease is minted.
      const recreated = await factory({ ...params, registeredRuntimeIds: [leaseId] });
      expect(recreated.runtimeId).toMatch(CRABBOX_SANDBOX_LEASE_ID_PATTERN);
      expect(recreated.runtimeId).not.toBe(leaseId);
      const recreatedEntry = { ...entry, containerName: recreated.runtimeId };
      cleanups.push(async () => {
        await manager.removeRuntime({ entry: recreatedEntry, config }).catch(() => undefined);
      });
      const recreatedExec = await recreated.runShellCommand({ script: "echo recreated-ok" });
      expect(recreatedExec.stdout.toString("utf8")).toContain("recreated-ok");
      await manager.removeRuntime({ entry: recreatedEntry, config });
    },
    LIVE_TIMEOUT_MS,
  );
});
