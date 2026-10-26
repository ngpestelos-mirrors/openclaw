import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  encodeLocalWorkspaceTreeNodes,
  localWorkspaceDigestBytes,
  prepareLocalWorkspaceSourcePathSet,
} from "./local-workspace-cas.js";
import {
  beginLocalWorkspaceSweepInDatabase,
  deleteLocalWorkspaceSweepBatchInDatabase,
  prepareLocalWorkspaceContentInDatabase,
  readLocalWorkspaceSourcePaths,
  readLocalWorkspaceSweepCandidates,
  readLocalWorkspaceTree,
} from "./local-workspace-cas.kernel.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
} from "./local-workspace-manifest-tree.js";
import { mutateLocalWorkspaceProjection } from "./local-workspace-store.kernel.js";
import { localWorkspaceProjectionFixture } from "./local-workspace-store.test-support.js";

function tree(character: string) {
  return createLocalWorkspaceManifestTree([
    { path: "entry.txt", type: "file", mode: 0o644, size: 1, sha256: character.repeat(64) },
  ]);
}

it("accepts a prepared tree with only the projection root flip inside the writer transaction", () => {
  using cleanup = new DisposableStack();
  const db = new DatabaseSync(":memory:");
  cleanup.defer(() => db.close());
  const id = randomUUID();
  mutateLocalWorkspaceProjection(db, id, {
    kind: "create",
    row: localWorkspaceProjectionFixture(id, "/synthetic"),
  });
  const records = tree("a");
  prepareLocalWorkspaceContentInDatabase(db, { nodes: encodeLocalWorkspaceTreeNodes(records) });
  const counters = trackSqliteStatementExecutions(db, ["nodeWrites", "rootFlip"], (sql) => {
    if (
      /^(?:insert|update|delete)\b/i.test(sql) &&
      /local_workspace_(?:tree_nodes|manifest_nodes)/i.test(sql)
    ) {
      return "nodeWrites";
    }
    if (/^update\b/i.test(sql) && /local_workspace_projections/i.test(sql)) {
      return "rootFlip";
    }
    return null;
  });
  cleanup.defer(counters.restore);
  prepareLocalWorkspaceContentInDatabase(db, { nodes: encodeLocalWorkspaceTreeNodes(records) });
  expect(counters.counts.nodeWrites).toBe(0);
  mutateLocalWorkspaceProjection(db, id, {
    kind: "update",
    revision: 0,
    patch: { checkpoint_json: null },
    manifest: {
      previousRoot: null,
      resultingRoot: localWorkspaceManifestRootReference(records, "a".repeat(40)),
      treeRoot: records.get("")!.treeRef,
      records: [],
      removed: [],
      replace: true,
    },
  });
  expect(counters.counts).toEqual({ nodeWrites: 0, rootFlip: 1 });
  expect(readLocalWorkspaceTree(db, localWorkspaceDigestBytes(records.get("")!.treeRef))).toEqual(
    records,
  );
});

it("sweeps unreachable content while retaining baseline, previous and pending roots and newly reused content", () => {
  using cleanup = new DisposableStack();
  const db = new DatabaseSync(":memory:");
  cleanup.defer(() => db.close());
  db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
  const id = randomUUID();
  const baseline = tree("a");
  const previous = tree("b");
  const pending = tree("c");
  const abandoned = tree("d");
  const reused = tree("e");
  mutateLocalWorkspaceProjection(db, id, {
    kind: "create",
    row: localWorkspaceProjectionFixture(id, "/synthetic"),
  });
  for (const records of [baseline, previous, pending, abandoned, reused]) {
    prepareLocalWorkspaceContentInDatabase(db, { nodes: encodeLocalWorkspaceTreeNodes(records) });
  }
  const livePaths = prepareLocalWorkspaceSourcePathSet('["entry.txt"]');
  const orphanPaths = prepareLocalWorkspaceSourcePathSet('["abandoned.txt"]');
  const reusedPaths = prepareLocalWorkspaceSourcePathSet('["reused.txt"]');
  for (const paths of [livePaths, orphanPaths, reusedPaths]) {
    prepareLocalWorkspaceContentInDatabase(db, { paths });
  }
  const root = (records: ReturnType<typeof tree>) => records.get("")!.treeRef;
  const reference = (records: ReturnType<typeof tree>) =>
    localWorkspaceManifestRootReference(records, "a".repeat(40));
  // The pending checkpoint owns both sides even when neither is the current baseline.
  const checkpoint = {
    version: 1,
    kind: "scan",
    previousRoot: reference(previous),
    resultingRoot: reference(pending),
    previousTreeRoot: root(previous),
    treeRoot: root(pending),
    records: [],
    removed: [],
    baseManifestRaw: "",
    baseManifestRef: "",
    currentManifestRaw: "",
    currentManifestRef: "",
    buildCacheInputs: [],
  };
  mutateLocalWorkspaceProjection(db, id, {
    kind: "update",
    revision: 0,
    patch: {
      tree_root_digest: localWorkspaceDigestBytes(root(baseline)),
      source_paths_digest: localWorkspaceDigestBytes(livePaths.digest),
      baseline_ref: reference(baseline),
      pending_ref: "refs/openclaw/results/synthetic",
      pending_target: "canonical",
      checkpoint_json: JSON.stringify(checkpoint),
    },
  });
  expect(beginLocalWorkspaceSweepInDatabase(db)).toBe(1);
  const epoch = beginLocalWorkspaceSweepInDatabase(db);
  expect(epoch).toBe(2);
  const candidates = readLocalWorkspaceSweepCandidates(db, epoch);
  expect(candidates.nodes).toHaveLength(abandoned.size + reused.size);
  expect(candidates.paths).toHaveLength(2);
  // A writer reusing content after the snapshot protects it with the current epoch.
  prepareLocalWorkspaceContentInDatabase(db, {
    nodes: encodeLocalWorkspaceTreeNodes(reused),
    paths: reusedPaths,
  });
  deleteLocalWorkspaceSweepBatchInDatabase(db, epoch, candidates);
  for (const records of [baseline, previous, pending, reused]) {
    expect(readLocalWorkspaceTree(db, localWorkspaceDigestBytes(root(records)))).toEqual(records);
  }
  expect(() => readLocalWorkspaceTree(db, localWorkspaceDigestBytes(root(abandoned)))).toThrow(
    "baseline nodes are missing",
  );
  expect(readLocalWorkspaceSourcePaths(db, localWorkspaceDigestBytes(livePaths.digest))).toBe(
    '["entry.txt"]',
  );
  expect(readLocalWorkspaceSourcePaths(db, localWorkspaceDigestBytes(reusedPaths.digest))).toBe(
    '["reused.txt"]',
  );
  expect(() =>
    readLocalWorkspaceSourcePaths(db, localWorkspaceDigestBytes(orphanPaths.digest)),
  ).toThrow("source path set is missing");
});
