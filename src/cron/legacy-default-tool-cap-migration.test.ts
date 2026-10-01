import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateLegacyDefaultCronToolCaps } from "./legacy-default-tool-cap-migration.js";
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

function legacyDefaultJob(id: string, opts: { scheduledPolicy: boolean }) {
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
  job.runtimeAuthority = {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: { apps: [{ id: "calendar" }] },
  };
  return job;
}

describe("migrateLegacyDefaultCronToolCaps", () => {
  it("lets default caps inherit while keeping explicit caps, pins, and app authority", async () => {
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
        scripted,
        explicit,
      ],
    };
    await saveCronStore(storePath, store);
    const beforeAuthority = (await loadCronStore(storePath)).jobs.find(
      (job) => job.id === "inherits",
    )?.runtimeAuthority;
    expect(beforeAuthority).toBeDefined();

    const { migrated, backupPath } = await migrateLegacyDefaultCronToolCaps({ storePath });

    expect(migrated.map(({ jobId }) => jobId)).toEqual(["inherits"]);
    const after = new Map((await loadCronStore(storePath)).jobs.map((job) => [job.id, job]));
    const inherits = after.get("inherits");
    expect(inherits?.payload).toEqual({ kind: "agentTurn", message: "split", toolsAllow: ["*"] });
    expect(inherits?.runtimeAuthority).toEqual(beforeAuthority);
    expect(inherits?.runtimeAuthorityRecoveryRequired).toBeUndefined();
    expect(inherits?.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });
    for (const id of ["legacy", "scripted"]) {
      expect(after.get(id)?.payload).toEqual({
        kind: "agentTurn",
        message: "split",
        toolsAllow: ["message", "read", "exec"],
        toolsAllowIsDefault: true,
      });
      expect(after.get(id)?.runtimeAuthority).toEqual(beforeAuthority);
    }
    expect(after.get("explicit")?.payload).toEqual(explicit.payload);

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
});
