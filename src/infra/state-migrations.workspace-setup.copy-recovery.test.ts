import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as durability from "./directory-durability.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

describe("legacy workspace private copy recovery", () => {
  const { detect, migrate, setup } = useWorkspaceMigrationTestFixture();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("warns about an unbound workspace copy without adopting or deleting it", async () => {
    const context = setup();
    const directory = path.join(context.workspaceDir, ".doctor-source-copy-unrecognized");
    await fsp.mkdir(directory, { mode: 0o700 });
    await fsp.writeFile(path.join(directory, "payload"), "unknown workspace material");
    const detected = await detect(context);
    expect(detected.hasLegacy).toBe(true);
    expect(detected.unboundCopyPaths).toContain(directory);

    const result = await migrateLegacyWorkspaceState({
      detected,
      stateDir: context.stateDir,
      env: context.env,
    });
    expect(result.warnings.join("\n")).toContain("Preserved unbound workspace private copy");
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe(
      "unknown workspace material",
    );
  });

  it("counts an outside-root copy-only stage as read-only rehearsal inventory", async () => {
    const context = setup();
    const sourcePath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const directory = path.join(
      context.workspaceDir,
      ".doctor-source-copy-11111111-1111-4111-8111-111111111111-" +
        Buffer.from(path.basename(sourcePath)).toString("base64url"),
    );
    await fsp.mkdir(directory, { mode: 0o700 });
    await fsp.writeFile(path.join(directory, "payload"), "private workspace data");
    const env = {
      ...context.env,
      ...buildUpdateRehearsalPathEnv(context.stateDir),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    };
    const detected = await detectLegacyWorkspaceState({
      cfg: context.cfg,
      stateDir: context.stateDir,
      env,
      homedir: () => context.stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);
    expect(detected.rehearsalInventoryPaths).toContain(directory);
    expect(detected.sources).not.toContainEqual(expect.objectContaining({ sourcePath }));
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("private workspace data");
  });

  it.each(["setup", "attestation"] as const)(
    "recovers a private %s copy against its receipt, archive and canonical workspace state",
    async (kind) => {
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "off");
      const context = setup();
      const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
      const sourcePath =
        kind === "setup"
          ? path.join(context.workspaceDir, "openclaw-workspace-state.json")
          : path.join(
              context.stateDir,
              "workspace-attestations",
              identity.workspaceKey + ".attested",
            );
      await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
      const bytes =
        kind === "setup"
          ? JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T10:01:00.000Z" })
          : "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n";
      await fsp.writeFile(sourcePath, bytes);
      if (kind === "attestation") {
        const at = new Date("2026-07-15T11:00:00.000Z");
        await fsp.utimes(sourcePath, at, at);
      }
      const link = vi
        .spyOn(fsp, "link")
        .mockRejectedValue(
          Object.assign(new Error("link denied"), { code: "EPERM", syscall: "link" }),
        );
      const requireSync = durability.requireDirectorySync;
      const failedSync = vi
        .spyOn(durability, "requireDirectorySync")
        .mockImplementation((outcome, label) => {
          if (label === "Legacy migration source directory" && !fs.existsSync(sourcePath)) {
            throw new Error("post-delete parent sync failed");
          }
          requireSync(outcome, label);
        });

      const first = await migrate(context);
      expect(first.warnings.join("\n")).toContain("post-delete parent sync failed");
      const copies = fs
        .readdirSync(path.dirname(sourcePath))
        .filter((name) => name.startsWith(".doctor-source-copy-"));
      expect(copies).toHaveLength(1);
      const directory = path.join(path.dirname(sourcePath), copies[0]!);
      const payload = path.join(directory, "payload");
      expect(fs.readFileSync(payload, "utf8")).toBe(bytes);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(
        (await detect(context)).sources.some((source) => source.sourcePath === sourcePath),
      ).toBe(true);
      const before = await readWorkspaceStateSnapshot(context.workspaceDir, { env: context.env });
      failedSync.mockRestore();
      link.mockRestore();

      await fsp.writeFile(payload, "changed recovery bytes");
      expect((await migrate(context)).warnings.join("\n")).toContain(
        "differs from its migration receipt",
      );
      expect(fs.existsSync(payload)).toBe(true);
      await fsp.writeFile(payload, bytes);
      const maxBytes = kind === "setup" ? 64 * 1024 : 2048;
      await fsp.writeFile(payload, Buffer.alloc(maxBytes + 1, 0x41));
      expect((await migrate(context)).warnings.join("\n")).toContain(
        "Preserved interrupted workspace copy",
      );
      expect(fs.statSync(payload).size).toBe(maxBytes + 1);
      await fsp.writeFile(payload, bytes);
      const db = openOpenClawStateDatabase({ env: context.env }).db;
      db.prepare("UPDATE migration_sources SET source_sha256 = ? WHERE source_path = ?").run(
        "0".repeat(64),
        sourcePath,
      );
      expect((await migrate(context)).warnings.join("\n")).toContain(
        "differs from its migration receipt",
      );
      expect(fs.existsSync(payload)).toBe(true);
      db.prepare("UPDATE migration_sources SET source_sha256 = ? WHERE source_path = ?").run(
        createHash("sha256").update(bytes).digest("hex"),
        sourcePath,
      );
      if (kind === "setup") {
        db.prepare(
          "UPDATE workspace_setup_state SET setup_completed_at = ? WHERE workspace_key = ?",
        ).run("2026-07-16T10:01:00.000Z", identity.workspaceKey);
      } else {
        db.prepare(
          "UPDATE workspace_setup_state SET attested_at_ms = attested_at_ms + 1 WHERE workspace_key = ?",
        ).run(identity.workspaceKey);
      }
      expect((await migrate(context)).warnings.join("\n")).toContain(
        "canonical workspace state no longer covers",
      );
      expect(fs.existsSync(payload)).toBe(true);
      if (kind === "setup") {
        db.prepare(
          "UPDATE workspace_setup_state SET setup_completed_at = ? WHERE workspace_key = ?",
        ).run("2026-07-15T10:01:00.000Z", identity.workspaceKey);
      } else {
        db.prepare(
          "UPDATE workspace_setup_state SET attested_at_ms = attested_at_ms - 1 WHERE workspace_key = ?",
        ).run(identity.workspaceKey);
      }
      const retry = await migrate(context);
      expect(retry.warnings).toEqual([]);
      expect(retry.changes).toContain(
        "Removed interrupted private workspace copies covered by their SQLite receipt.",
      );
      expect(fs.existsSync(directory)).toBe(false);
      expect(await readWorkspaceStateSnapshot(context.workspaceDir, { env: context.env })).toEqual(
        before,
      );
      expect((await migrate(context)).changes).toEqual([]);
    },
  );
});
