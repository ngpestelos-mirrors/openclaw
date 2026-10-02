import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createAgentFixture } from "./git-backup.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves NUL-bearing TEXT, storage classes, and source key order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-text-"));
  const sourcePath = path.join(root, "source.sqlite");
  const outputPath = path.join(root, "dump");
  const targetPath = path.join(root, "restored.sqlite");
  const keys = ["\0leading", "\nline", " space", "shared\0left", "shared\0right", "雪🦀\0尾"];
  const values = ["text\0suffix", "", null, 9_007_199_254_740_993n, Buffer.from([0, 255]), 1.25];
  const byteQuery =
    'SELECT hex("key") AS key, typeof(value) AS type, hex(value) AS bytes FROM text_values ORDER BY "key"';
  try {
    const source = openOpenClawStateDatabase({ path: sourcePath });
    source.db.exec('CREATE TABLE text_values ("key" TEXT PRIMARY KEY, value ANY) STRICT');
    const insert = source.db.prepare('INSERT INTO text_values ("key", value) VALUES (?, ?)');
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      insert.run(keys[index]!, values[index]!);
    }
    const expectedBytes = source.db.prepare(byteQuery).all();
    closeOpenClawStateDatabaseForTest();

    await dumpGitBackupDatabase({
      snapshotPath: sourcePath,
      outputPath,
      identity: { role: "global" },
    });
    const content = await fs.readFile(path.join(outputPath, "tables/text_values.jsonl"), "utf8");
    expect(
      content
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { key: keys[0], value: "text\0suffix" },
      { key: keys[1], value: "" },
      { key: keys[2], value: null },
      { key: keys[3], value: { $int: "9007199254740993" } },
      { key: keys[4], value: { $hex: "00ff" } },
      { key: keys[5], value: 1.25 },
    ]);
    const restored = await restoreGitBackupDirectory({
      sourcePath: outputPath,
      targetPath,
      expectedIdentity: { role: "global" },
    });
    expect(restored.tables.every((table) => table.ok)).toBe(true);
    const database = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(database.prepare(byteQuery).all()).toEqual(expectedBytes);
    } finally {
      database.close();
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "redacts catalog credentials only for secret-excluded backups (exclude=%s)",
  async (excludeSecrets) => {
    const root = tempDirs.make("git-backup-catalog-");
    const source = path.join(root, "source.sqlite");
    const dump = path.join(root, "dump");
    createAgentFixture(source, "main");
    const catalog = {
      generatedBy: "openclaw-plugin-model-catalog-v1",
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "provider-secret",
          headers: { Authorization: "Bearer header-secret" },
          models: [{ id: "model", apiKey: "model-secret", headers: { "X-Key": "model-key" } }],
        },
      },
    };
    const malformedHeaders = {
      generatedBy: "openclaw-plugin-model-catalog-v1",
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: { value: "provider-secret" },
          headers: ["provider-header-secret"],
          models: [
            { id: "array-header", headers: { Authorization: ["model-header-secret"] } },
            { id: "object-header", headers: { Authorization: { token: "model-secret" } } },
            { id: "string-headers", headers: "model-secret" },
          ],
        },
      },
    };
    const unusableCatalogs = [
      '{"apiKey":"malformed-secret"',
      JSON.stringify({ ...catalog, providers: { fixture: ["provider-secret"] } }),
      JSON.stringify({
        ...catalog,
        providers: { fixture: { models: { Authorization: "model-secret" } } },
      }),
      JSON.stringify({ ...catalog, providers: { fixture: { models: ["model-secret"] } } }),
    ];
    const scopes = ["plugin-model-catalog-v1", "plugin-model-catalog-migration-v1"];
    const database = new DatabaseSync(source);
    try {
      database.exec("CREATE TABLE cache_entries (scope TEXT, key TEXT, value_json TEXT)");
      const insert = database.prepare("INSERT INTO cache_entries VALUES (?, ?, ?)");
      for (const scope of scopes) {
        insert.run(scope, "fixture", JSON.stringify(catalog));
        insert.run(scope, "malformed-headers", JSON.stringify(malformedHeaders));
        for (const [index, contents] of unusableCatalogs.entries()) {
          insert.run(scope, `broken-${index}`, contents);
        }
      }
      insert.run("unrelated-cache", "keep", '{"value":"retained"}');
    } finally {
      database.close();
    }
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "agent", agentId: "main" },
      excludeSecrets,
    });
    const rows = (await fs.readFile(path.join(dump, "tables", "cache_entries.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const scope of scopes) {
      const fixtureRow = rows.find((entry) => entry.scope === scope && entry.key === "fixture");
      expect(fixtureRow).toBeDefined();
      expect(JSON.parse(fixtureRow.value_json)).toEqual(
        excludeSecrets
          ? {
              ...catalog,
              providers: {
                fixture: {
                  api: "openai-completions",
                  models: [{ id: "model" }],
                },
              },
            }
          : catalog,
      );
      const malformedRow = rows.find(
        (entry) => entry.scope === scope && entry.key === "malformed-headers",
      );
      expect(malformedRow).toBeDefined();
      expect(JSON.parse(malformedRow.value_json)).toEqual(
        excludeSecrets
          ? {
              generatedBy: "openclaw-plugin-model-catalog-v1",
              providers: {
                fixture: {
                  api: "openai-completions",
                  models: [
                    { id: "array-header" },
                    { id: "object-header" },
                    { id: "string-headers" },
                  ],
                },
              },
            }
          : malformedHeaders,
      );
      for (const [index, contents] of unusableCatalogs.entries()) {
        expect(
          rows.find((entry) => entry.scope === scope && entry.key === `broken-${index}`),
        ).toEqual(
          excludeSecrets ? undefined : { scope, key: `broken-${index}`, value_json: contents },
        );
      }
    }
    expect(rows).toContainEqual({
      scope: "unrelated-cache",
      key: "keep",
      value_json: '{"value":"retained"}',
    });
    expect(manifest.userVersion).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(manifest.tables.cache_entries).toMatchObject({
      rows: excludeSecrets ? 5 : 5 + scopes.length * unusableCatalogs.length,
    });
  },
);
