import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import {
  decodeLocalWorkspaceSourcePathSet,
  localWorkspaceDigestBytes,
  localWorkspaceDigestReference,
  LOCAL_WORKSPACE_NODE_BATCH,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import type {
  LocalWorkspaceManifestNode,
  LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";
import type { LocalWorkspaceManifestMutation } from "./local-workspace-store.types.js";

const nodes = "local_workspace_tree_nodes";
const pathSets = "local_workspace_source_path_sets";
const epochKey = "workspace.manifest.sweepEpoch";
const query = (db: EngineConnection) => getNodeSqliteKysely<DB>(db);

function currentEpoch(db: EngineConnection): number {
  if (!tableExists(db, "config_machine_state")) {
    return 0;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", epochKey),
  );
  return row ? Number(row.value_json) : 0;
}

/** One bounded worker transaction. Preparation does not change any projection authority. */
export function prepareLocalWorkspaceContentInDatabase(
  db: EngineConnection,
  preparation: LocalWorkspacePreparation,
): void {
  if (!tableExists(db, nodes)) {
    // sqlite-allow-raw -- Canonical first-use schema admission for the existing workspace feature.
    db.exec(getOpenClawStateFeatureSchemaSql("local_workspace_projections"));
  }
  const epoch = currentEpoch(db);
  if (preparation.nodes?.length) {
    if (preparation.nodes.length > LOCAL_WORKSPACE_NODE_BATCH) {
      throw new Error("Local workspace node preparation exceeds its batch limit");
    }
    const rows = preparation.nodes.map((record) => ({
      tree_digest: localWorkspaceDigestBytes(record.treeRef),
      entry_json: JSON.stringify(record.node),
      content_digest: localWorkspaceDigestBytes(record.contentRef),
      left_digest: record.left ? localWorkspaceDigestBytes(record.left) : null,
      right_digest: record.right ? localWorkspaceDigestBytes(record.right) : null,
      children_digest: record.children ? localWorkspaceDigestBytes(record.children) : null,
      sweep_epoch: epoch,
    }));
    const existing = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom(nodes)
        .select(["tree_digest", "sweep_epoch"])
        .where(
          "tree_digest",
          "in",
          rows.map((row) => row.tree_digest),
        ),
    ).rows;
    const known = new Set(existing.map((row) => localWorkspaceDigestReference(row.tree_digest)));
    const missing = rows.filter(
      (row) => !known.has(localWorkspaceDigestReference(row.tree_digest)),
    );
    if (missing.length) {
      executeSqliteQuerySync(
        db,
        query(db)
          .insertInto(nodes)
          .values(missing)
          .onConflict((conflict) =>
            conflict.column("tree_digest").doUpdateSet((eb) => ({
              sweep_epoch: eb
                .case()
                .when(`${nodes}.sweep_epoch`, "<", epoch)
                .then(epoch)
                .else(eb.ref(`${nodes}.sweep_epoch`))
                .end(),
            })),
          ),
      );
    }
    const reused = existing.filter((row) => row.sweep_epoch < epoch).map((row) => row.tree_digest);
    if (reused.length) {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable(nodes)
          .set({ sweep_epoch: epoch })
          .where("tree_digest", "in", reused)
          .where("sweep_epoch", "<", epoch),
      );
    }
  }
  if (preparation.paths) {
    const digest = localWorkspaceDigestBytes(preparation.paths.digest);
    executeSqliteQuerySync(
      db,
      query(db)
        .insertInto(pathSets)
        .values({
          path_digest: digest,
          paths_zstd: Buffer.from(preparation.paths.compressed),
          sweep_epoch: epoch,
        })
        .onConflict((conflict) =>
          conflict.column("path_digest").doUpdateSet((eb) => ({
            sweep_epoch: eb
              .case()
              .when(`${pathSets}.sweep_epoch`, "<", epoch)
              .then(epoch)
              .else(eb.ref(`${pathSets}.sweep_epoch`))
              .end(),
          })),
        ),
    );
  }
}

export function readLocalWorkspaceSourcePaths(db: EngineConnection, digest: Uint8Array): string {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom(pathSets)
      .select("paths_zstd")
      .where("path_digest", "=", Buffer.from(digest)),
  );
  if (!row) {
    throw new Error("Local workspace source path set is missing");
  }
  return decodeLocalWorkspaceSourcePathSet(row.paths_zstd);
}

/** Breadth-first batches traverse digest links within the caller's read snapshot. */
export function readLocalWorkspaceTree(db: EngineConnection, root: Uint8Array) {
  const loaded = new Map<
    string,
    {
      node: LocalWorkspaceManifestNode;
      contentRef: string;
      links: [string | null, string | null, string | null];
    }
  >();
  const pending = new Set([localWorkspaceDigestReference(root)]);
  while (pending.size) {
    const batch = [...pending].slice(0, LOCAL_WORKSPACE_NODE_BATCH);
    for (const ref of batch) {
      pending.delete(ref);
    }
    const rows = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom(nodes)
        .selectAll()
        .where("tree_digest", "in", batch.map(localWorkspaceDigestBytes)),
    ).rows;
    if (rows.length !== batch.length) {
      throw new Error("Local workspace baseline nodes are missing");
    }
    for (const row of rows) {
      const ref = localWorkspaceDigestReference(row.tree_digest);
      const reference = (value: Uint8Array | null) =>
        value ? localWorkspaceDigestReference(value) : null;
      const links: [string | null, string | null, string | null] = [
        reference(row.left_digest),
        reference(row.right_digest),
        reference(row.children_digest),
      ];
      loaded.set(ref, {
        // SAFETY: Immutable entry JSON is produced by the manifest tree owner.
        node: JSON.parse(row.entry_json) as LocalWorkspaceManifestNode,
        contentRef: localWorkspaceDigestReference(row.content_digest),
        links,
      });
      for (const link of links) {
        if (link && !loaded.has(link)) {
          pending.add(link);
        }
      }
    }
  }
  const records = new Map<string, LocalWorkspaceManifestRecord>();
  for (const [treeRef, { node, contentRef, links }] of loaded) {
    const childPath = (ref: string | null) => (ref ? loaded.get(ref)!.node.path : null);
    const [left, right, children] = links;
    records.set(node.path, {
      node,
      contentRef,
      treeRef,
      left: childPath(left),
      right: childPath(right),
      children: childPath(children),
    });
  }
  return records;
}

export function beginLocalWorkspaceSweepInDatabase(db: EngineConnection): number {
  const epoch = currentEpoch(db) + 1;
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("config_machine_state")
      .values({
        state_key: epochKey,
        value_json: String(epoch),
        updated_at_ms: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: String(epoch),
          updated_at_ms: Date.now(),
        }),
      ),
  );
  return epoch;
}

export type LocalWorkspaceSweepCandidates = { nodes: Uint8Array[]; paths: Uint8Array[] };

/** Select unreachable old content in the existing read worker's snapshot. */
export function readLocalWorkspaceSweepCandidates(
  db: EngineConnection,
  epoch: number,
): LocalWorkspaceSweepCandidates {
  const result: LocalWorkspaceSweepCandidates = { nodes: [], paths: [] };
  if (!tableExists(db, nodes)) {
    return result;
  }
  const reachable = new Set<string>();
  const paths = new Set<string>();
  const roots = new Set<string>();
  for (const row of executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("local_workspace_projections")
      .select(["tree_root_digest", "source_paths_digest", "checkpoint_json"]),
  ).rows) {
    if (row.tree_root_digest) {
      roots.add(localWorkspaceDigestReference(row.tree_root_digest));
    }
    if (row.source_paths_digest) {
      paths.add(localWorkspaceDigestReference(row.source_paths_digest));
    }
    if (row.checkpoint_json) {
      // SAFETY: The projection owner writes this recovery document with its pending receipt.
      const checkpoint = JSON.parse(row.checkpoint_json) as LocalWorkspaceManifestMutation;
      if (checkpoint.treeRoot) {
        roots.add(checkpoint.treeRoot);
      }
      if (checkpoint.previousTreeRoot) {
        roots.add(checkpoint.previousTreeRoot);
      }
    }
  }
  // Traverse the union once: revisions and projections share most of their graph.
  // GC needs only links, never entry JSON or decoded manifest maps.
  const pending = new Set(roots);
  while (pending.size) {
    const batch = [...pending].slice(0, LOCAL_WORKSPACE_NODE_BATCH);
    const rows = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom(nodes)
        .select(["tree_digest", "left_digest", "right_digest", "children_digest"])
        .where("tree_digest", "in", batch.map(localWorkspaceDigestBytes)),
    ).rows;
    if (rows.length !== batch.length) {
      throw new Error("Local workspace baseline nodes are missing");
    }
    for (const row of rows) {
      const ref = localWorkspaceDigestReference(row.tree_digest);
      reachable.add(ref);
      pending.delete(ref);
      for (const child of [row.left_digest, row.right_digest, row.children_digest]) {
        if (child) {
          const childRef = localWorkspaceDigestReference(child);
          if (!reachable.has(childRef)) {
            pending.add(childRef);
          }
        }
      }
    }
  }
  for (const row of executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(nodes)
      .select("tree_digest")
      .where("sweep_epoch", "<", epoch - 1),
  ).rows) {
    if (!reachable.has(localWorkspaceDigestReference(row.tree_digest))) {
      result.nodes.push(row.tree_digest);
    }
  }
  for (const row of executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom(pathSets)
      .select("path_digest")
      .where("sweep_epoch", "<", epoch - 1),
  ).rows) {
    if (!paths.has(localWorkspaceDigestReference(row.path_digest))) {
      result.paths.push(row.path_digest);
    }
  }
  return result;
}

/** The epoch predicate protects content reused after the read snapshot. */
export function deleteLocalWorkspaceSweepBatchInDatabase(
  db: EngineConnection,
  epoch: number,
  batch: LocalWorkspaceSweepCandidates,
): void {
  if (
    batch.nodes.length > LOCAL_WORKSPACE_NODE_BATCH ||
    batch.paths.length > LOCAL_WORKSPACE_NODE_BATCH
  ) {
    throw new Error("Local workspace sweep exceeds its batch limit");
  }
  if (batch.nodes.length) {
    executeSqliteQuerySync(
      db,
      query(db)
        .deleteFrom(nodes)
        .where(
          "tree_digest",
          "in",
          batch.nodes.map((value) => Buffer.from(value)),
        )
        .where("sweep_epoch", "<", epoch - 1),
    );
  }
  if (batch.paths.length) {
    executeSqliteQuerySync(
      db,
      query(db)
        .deleteFrom(pathSets)
        .where(
          "path_digest",
          "in",
          batch.paths.map((value) => Buffer.from(value)),
        )
        .where("sweep_epoch", "<", epoch - 1),
    );
  }
}

export function pruneLocalWorkspaceLegacyBatchInDatabase(
  db: EngineConnection,
  id: string,
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("local_workspace_projections")
      .select("tree_root_digest")
      .where("worktree_id", "=", id),
  );
  if (!row?.tree_root_digest) {
    return false;
  }
  const batch = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("local_workspace_manifest_nodes")
      .select("path")
      .where("worktree_id", "=", id)
      .limit(LOCAL_WORKSPACE_NODE_BATCH),
  ).rows;
  if (!batch.length) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("local_workspace_manifest_nodes")
      .where("worktree_id", "=", id)
      .where(
        "path",
        "in",
        batch.map((entry) => entry.path),
      ),
  );
  return batch.length === LOCAL_WORKSPACE_NODE_BATCH;
}
