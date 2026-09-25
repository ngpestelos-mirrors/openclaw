import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  acquireGatewayStateOwner,
  tryAcquireGatewayStateOwner,
} from "../infra/gateway-state-owner.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";

it("respects another migration owner even when the state database is already open", async () => {
  await withOpenClawTestState({ label: "workshop-migration-owner" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const otherOwner = acquireGatewayStateOwner({ databasePath: database.path });
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
      ).rejects.toThrow("OpenClaw state database is busy at");
    } finally {
      otherOwner?.release();
    }
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });
});

it("preserves Doctor's outer ownership after migration failure until cleanup finishes", async () => {
  await withOpenClawTestState({ label: "workshop-migration-release" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const outer = acquireGatewayStateOwner({ databasePath: database.path });
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: outer.assertCurrent,
      assertDatabaseAccess: outer.assertDatabaseAccess,
    });
    const backupRoot = path.join(state.stateDir, "skill-workshop", "collection-backups");
    await fs.mkdir(backupRoot, { recursive: true });
    const readDirectory = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(new Error("backup directory unavailable"));
    try {
      await expect(
        maintenance.run(() => migrateLegacySkillWorkshopProposals({ config: {}, env: state.env })),
      ).rejects.toThrow("backup directory unavailable");
      expect(tryAcquireGatewayStateOwner(database.path)).toBeNull();
    } finally {
      readDirectory.mockRestore();
      await maintenance.close();
      outer.release();
    }
    const nextOwner = tryAcquireGatewayStateOwner(database.path);
    expect(nextOwner).not.toBeNull();
    nextOwner?.release();
  });
});
