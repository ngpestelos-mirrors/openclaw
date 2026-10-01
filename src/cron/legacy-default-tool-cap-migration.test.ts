import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { migrateLegacyDefaultCronToolCaps } from "./legacy-default-tool-cap-migration.js";
import { mergeCronPayload } from "./service/payload-merge.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { makeStore } from "./store.test-support.js";
import type { CronStoreFile } from "./types.js";

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-default-caps-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

const ownerSessionKey = "agent:main:telegram:group:ops";

function legacyDefaultJob(id: string, opts: { scheduledPolicy: boolean; codexApps?: boolean }) {
  const job = makeStore(id, true).jobs[0];
  job.sessionTarget = "isolated";
  job.owner = { agentId: "main", sessionKey: ownerSessionKey, accountId: "work" };
  // Older writers froze the creator's surface and marked it as a default.
  job.payload = Object.assign(
    { kind: "agentTurn" as const, message: "split", toolsAllow: ["message", "read", "exec"] },
    { toolsAllowIsDefault: true },
  );
  if (opts.scheduledPolicy) {
    job.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey,
      ownerAccountId: "work",
    };
  }
  job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
  job.toolsAllowExecTargetRequirement = {
    version: 1,
    target: { version: 1, host: "gateway", ask: "always" },
    grantIndex: 2,
  };
  if (opts.codexApps) {
    job.runtimeAuthority = {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
  }
  return job;
}

describe("migrateLegacyDefaultCronToolCaps", () => {
  it("lets default caps inherit while leaving explicit, script, policy-less, and Codex-app rows untouched", async () => {
    const storePath = path.join(fixtureRoot, `case-${caseId++}`, "cron", "jobs.json");
    const explicit = makeStore("explicit", true).jobs[0];
    explicit.sessionTarget = "isolated";
    explicit.payload = { kind: "agentTurn", message: "restricted", toolsAllow: ["read"] };
    const scripted = legacyDefaultJob("scripted", { scheduledPolicy: true });
    scripted.trigger = { script: "return { fire: true }" };
    const store: CronStoreFile = {
      version: 1,
      jobs: [
        legacyDefaultJob("inherits", { scheduledPolicy: true }),
        legacyDefaultJob("legacy", { scheduledPolicy: false }),
        legacyDefaultJob("codex-app", { scheduledPolicy: true, codexApps: true }),
        scripted,
        explicit,
      ],
    };
    await saveCronStore(storePath, store);
    const readRawRows = () => {
      const db = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
      try {
        return db
          .prepare(
            "SELECT job_id, job_json FROM cron_jobs WHERE job_id != 'inherits' ORDER BY job_id",
          )
          .all();
      } finally {
        db.close();
      }
    };
    const untouchedBefore = readRawRows();
    const codexAuthority = (await loadCronStore(storePath)).jobs.find(
      (job) => job.id === "codex-app",
    )?.runtimeAuthority;
    expect(codexAuthority).toBeDefined();

    const { migrated, backupPath } = await migrateLegacyDefaultCronToolCaps({ storePath });

    expect(migrated.map(({ jobId }) => jobId)).toEqual(["inherits"]);
    expect(readRawRows()).toEqual(untouchedBefore);
    const after = new Map((await loadCronStore(storePath)).jobs.map((job) => [job.id, job]));
    expect(after.get("inherits")?.payload).toEqual({
      kind: "agentTurn",
      message: "split",
      toolsAllow: ["*"],
    });
    expect(after.get("inherits")?.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });
    expect(after.get("codex-app")?.runtimeAuthority).toEqual(codexAuthority);
    expect(after.get("codex-app")?.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const backup = new DatabaseSync(String(backupPath), { readOnly: true });
    try {
      const rows = backup
        .prepare("SELECT job_id, job_json FROM cron_jobs WHERE job_id = 'inherits'")
        .all() as Array<{ job_id: string; job_json: string }>;
      expect(rows.map((row) => JSON.parse(row.job_json).payload.toolsAllowIsDefault)).toEqual([
        true,
      ]);
    } finally {
      backup.close();
    }

    await expect(migrateLegacyDefaultCronToolCaps({ storePath })).resolves.toEqual({
      migrated: [],
    });
  });

  it("never widens a saved list that was explicitly edited before the migration ran", async () => {
    const storePath = path.join(fixtureRoot, `case-${caseId++}`, "cron", "jobs.json");
    const job = legacyDefaultJob("edited", { scheduledPolicy: true });
    delete job.toolsAllowExecTarget;
    delete job.toolsAllowExecTargetRequirement;
    job.payload = mergeCronPayload(job.payload, { kind: "agentTurn", toolsAllow: ["read"] });
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    await expect(migrateLegacyDefaultCronToolCaps({ storePath })).resolves.toEqual({
      migrated: [],
    });
    expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
      kind: "agentTurn",
      message: "split",
      toolsAllow: ["read"],
    });
  });
});
