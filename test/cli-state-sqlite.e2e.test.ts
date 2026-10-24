import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";

function runDoctorCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.resolve("openclaw.mjs"), "doctor", ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function cliEnv(tempHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(tempHome, ".openclaw"),
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.OPENCLAW_HOME;
  delete env.VITEST;
  return env;
}

function withCliHome(
  prefix: string,
  exercise: (tempHome: string, stateDir: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  return withTempHome(
    (tempHome) => exercise(tempHome, path.join(tempHome, ".openclaw"), cliEnv(tempHome)),
    { prefix },
  );
}

function expectRejected(result: ReturnType<typeof runDoctorCli>, reason: string) {
  expect(result.status).not.toBe(0);
  expect(`${result.stderr}\n${result.stdout}`).toContain(reason);
}

it("compacts after full CLI startup without retaining a config-health database handle", async () => {
  await withCliHome("openclaw-state-sqlite-cli-", async (_tempHome, stateDir, env) => {
    try {
      const database = openOpenClawStateDatabase({ env });
      database.db.exec(`
          CREATE TABLE compact_cli_payload (payload BLOB NOT NULL);
          INSERT INTO compact_cli_payload VALUES (zeroblob(16384));
          DELETE FROM compact_cli_payload;
          PRAGMA wal_checkpoint(TRUNCATE);
        `);
    } finally {
      closeOpenClawStateDatabase();
    }

    const result = runDoctorCli(["--state-sqlite", "compact", "--json"], env);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as { before: { freelistPages: number } };
    expect(report).toMatchObject({
      after: { autoVacuum: 2, freelistPages: 0 },
      integrityCheck: "ok",
      skipped: false,
    });
    expect(report.before.freelistPages).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
  });
}, 90_000);

describe.each(["shared-state", "configured-session"] as const)("%s sidecar ownership", (owner) => {
  it.skipIf(owner === "shared-state" && process.platform === "win32")(
    "rejects hard-linked WALs before destructive maintenance",
    async () => {
      await withCliHome("openclaw-sidecar-cli-", async (tempHome, stateDir, baseEnv) => {
        const shared = owner === "shared-state";
        const storePath = path.join(tempHome, "external-sessions", "sessions.json");
        const sqlitePath = path.join(path.dirname(storePath), "openclaw-agent.sqlite");
        const configPath = path.join(stateDir, "openclaw.json");
        if (!shared) {
          fs.mkdirSync(path.dirname(storePath), { recursive: true });
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(storePath, "{}\n", "utf8");
          fs.writeFileSync(configPath, JSON.stringify({ session: { store: storePath } }), "utf8");
        }
        const env = shared ? baseEnv : { ...baseEnv, OPENCLAW_CONFIG_PATH: configPath };
        const database = shared
          ? openOpenClawStateDatabase({ env })
          : openOpenClawAgentDatabase({ agentId: "main", env, path: sqlitePath });
        const externalWalPath = path.join(tempHome, "external-wal-alias");
        try {
          database.db.exec(`
              PRAGMA wal_autocheckpoint = 0;
              CREATE TABLE compact_sidecar_payload (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
              PRAGMA wal_checkpoint(TRUNCATE);
              INSERT INTO compact_sidecar_payload (payload) VALUES ('committed wal frame');
            `);
          fs.linkSync(`${database.path}-wal`, externalWalPath);
          const before = fs.readFileSync(externalWalPath);
          expect(before.byteLength).toBeGreaterThan(0);
          expectRejected(
            runDoctorCli(
              [shared ? "--state-sqlite" : "--session-sqlite", "compact", "--json"],
              env,
            ),
            "hard-linked path",
          );
          expect(fs.readFileSync(externalWalPath)).toEqual(before);
        } finally {
          if (shared) {
            closeOpenClawStateDatabase();
          } else {
            closeOpenClawAgentDatabaseByPath(sqlitePath);
          }
        }
      });
    },
    90_000,
  );
});
