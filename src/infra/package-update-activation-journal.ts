import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { z } from "zod";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import type { PackageActivationReverseBinding } from "./package-update-activation-reverse-schema.js";
import {
  identity,
  basename,
  PackageActivationDescriptorSchema,
  PackageActivationPhaseSchema,
  intentSchema,
  type PackageActivationDescriptor,
  type PackageActivationPhase,
  type PackageActivationIntent,
  type PackageActivationRecord,
} from "./package-update-activation-schema.js";
import type { PackageLauncherFingerprint } from "./package-update-integrity.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

export type {
  PackageActivationDescriptor,
  PackageActivationPhase,
  PackageActivationIntent,
  PackageActivationRecord,
} from "./package-update-activation-schema.js";

/** Keep the journal's version-1 launcher encoding while the live reader exposes metadata. */
export function encodePackageActivationLauncher(value: PackageLauncherFingerprint): string {
  return JSON.stringify([value.type, value.mode, value.uid, value.gid, value.contents]);
}

const PACKAGE_ACTIVATION_JOURNAL = "operation.sqlite";
const MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES = 1024 * 1024;
type ActivationRow = {
  slot: number;
  revision: number;
  phase: string;
  descriptor_json: string;
  intent_json: string;
  publications_json: string;
};
const queries = (db: DatabaseSync) =>
  getNodeSqliteKysely<{ package_activation: ActivationRow }>(db);

export function packageActivationIdentity(file: string, directory: boolean | "launcher"): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    stat.ino === 0n ||
    !(directory === "launcher"
      ? stat.isSymbolicLink() || stat.isFile()
      : directory
        ? stat.isDirectory() && !stat.isSymbolicLink()
        : stat.isFile()) ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Package publication object has an unsafe identity");
  }
  return `${stat.dev}:${stat.ino}`;
}

export function resolvePackageActivationAnchor(installKey: string): string {
  const key = createHash("sha256").update(installKey).digest("hex").slice(0, 24);
  return path.join(path.dirname(installKey), `.openclaw.package-activation-${key}`);
}

// Publish the helper and complete journal together, outside the disposable anchor.
export function resolvePackageActivationControl(anchor: string): string {
  return `${anchor}.control`;
}
export function resolvePackageActivationJournalPath(anchor: string): string {
  return path.join(resolvePackageActivationControl(anchor), PACKAGE_ACTIVATION_JOURNAL);
}
export function resolvePackageActivationHelper(anchor: string): string {
  return path.join(resolvePackageActivationControl(anchor), "recovery.mjs");
}

export function assertPackageActivationLayout(anchor: string): void {
  if (
    [
      path.join(anchor, PACKAGE_ACTIVATION_JOURNAL),
      `${anchor}.sqlite`,
      `${anchor}.recovery.mjs`,
    ].some((file) => fs.lstatSync(file, { throwIfNoEntry: false }))
  ) {
    throw new Error(
      "Legacy package activation artifacts require their original recovery owner; no migration is performed.",
    );
  }
}

/** A receipt is a read-only completion fact, never a grant for another effect. */
export function isPackageActivationComplete(
  anchor: string,
  record: PackageActivationRecord,
): boolean {
  if (record.phase !== "anchor-retired" || record.intent?.kind !== "unlink-helper") {
    return false;
  }
  if (record.intent.identity !== record.descriptor.helperIdentity) {
    throw new Error("Final helper unlink identity is invalid.");
  }
  for (const file of [anchor, resolvePackageActivationHelper(anchor)]) {
    try {
      fs.lstatSync(file);
      return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return true;
}

function assertPrivate(file: string, directory: boolean): string {
  const value = packageActivationIdentity(file, directory);
  const stat = fs.lstatSync(file);
  if ((stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new Error("Package publication recovery permissions are unsafe");
  }
  return value;
}

function descriptorJson(descriptor: PackageActivationDescriptor): string {
  const encoded = JSON.stringify(PackageActivationDescriptorSchema.parse(descriptor));
  if (Buffer.byteLength(encoded) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES) {
    throw new Error("Package publication descriptor exceeds 1 MiB");
  }
  return encoded;
}

/** An existing operation is never bootstrapped, migrated, or repaired on open. */
export function openPackageActivationJournal(anchor: string) {
  assertPackageActivationLayout(anchor);
  const journalPath = resolvePackageActivationJournalPath(anchor);
  const parent = path.dirname(anchor);
  const parentIdentity = packageActivationIdentity(parent, true);
  const control = resolvePackageActivationControl(anchor);
  const journalParentIdentity = assertPrivate(control, true);
  const journalIdentity = assertPrivate(journalPath, false);
  const assertFiles = () => {
    if (
      packageActivationIdentity(parent, true) !== parentIdentity ||
      assertPrivate(control, true) !== journalParentIdentity ||
      assertPrivate(journalPath, false) !== journalIdentity ||
      fs.realpathSync(control) !== control
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  const withDatabase = <T>(
    write: boolean,
    operation: (db: DatabaseSync, transact: ExistingSqliteTransaction) => T,
  ): T =>
    withExistingSqliteRollbackDatabase(
      journalPath,
      {
        write,
        busyTimeoutMs: 0,
        assertIdentity: assertFiles,
        validate: (db) => {
          executeSqliteQuerySync(
            db,
            queries(db).selectFrom("package_activation").selectAll().limit(0),
          );
        },
      },
      (db, transact) => {
        if (write) {
          // Persist rollback-journal deletion before the next filesystem effect.
          db.exec("PRAGMA synchronous = EXTRA"); // sqlite-allow-raw -- Durable reverse intent before rename.
        }
        return operation(db, transact);
      },
    );
  const decode = (row: ActivationRow | undefined): PackageActivationRecord => {
    if (
      !row ||
      row.slot !== 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      Buffer.byteLength(row.descriptor_json) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES
    ) {
      throw new Error("Package publication journal is missing or invalid");
    }
    const descriptor = PackageActivationDescriptorSchema.parse(JSON.parse(row.descriptor_json));
    if (
      descriptor.parentIdentity !== parentIdentity ||
      descriptor.journalParentIdentity !== journalParentIdentity ||
      descriptor.journalIdentity !== journalIdentity ||
      resolvePackageActivationAnchor(descriptor.authority.installKey) !== anchor ||
      descriptor.parentIdentity !== packageActivationIdentity(path.dirname(anchor), true) ||
      new Set(descriptor.launchers.map((entry) => entry.name)).size !== descriptor.launchers.length
    ) {
      throw new Error("Package publication journal does not match its installation");
    }
    const expectedTransfers = new Map<string, string>([
      ["anchor", descriptor.anchorIdentity],
      ["helper", descriptor.helperIdentity],
      ["candidate", descriptor.candidate.identity],
      ["launchers", descriptor.launcherRootIdentity],
    ]);
    if (descriptor.previousLauncherRootIdentity) {
      expectedTransfers.set("previous-launchers", descriptor.previousLauncherRootIdentity);
    }
    if (
      descriptor.preparation.length !== expectedTransfers.size ||
      new Set(descriptor.preparation.map((entry) => entry.name)).size !== expectedTransfers.size ||
      descriptor.preparation.some(
        (entry) => expectedTransfers.get(entry.name) !== entry.identity,
      ) ||
      descriptor.preparation.find((entry) => entry.name === "candidate")?.source !==
        descriptor.originalStageRoot
    ) {
      throw new Error("Preparation custody does not match the recorded objects.");
    }
    const publications = z
      .array(z.strictObject({ name: basename, identity }))
      .max(64)
      .parse(JSON.parse(row.publications_json));
    const intent = intentSchema.parse(JSON.parse(row.intent_json));
    const names = new Set(descriptor.launchers.map((entry) => entry.name));
    if (
      descriptor.reverse &&
      (descriptor.reverse.operationId !== descriptor.operationId ||
        descriptor.reverse.runId !== descriptor.originalRunId ||
        ![
          "reverse-in-progress",
          "reverse-complete",
          "rolled-back",
          "retiring",
          "anchor-retired",
        ].includes(row.phase))
    ) {
      throw new Error("Reverse binding is not in its original operation phase.");
    }
    if (row.phase.startsWith("reverse-") && (!descriptor.reverse || intent?.kind !== "reverse")) {
      throw new Error("Reverse phase has no durable binding/progress.");
    }
    if (
      intent?.kind === "reverse" &&
      (!descriptor.reverse ||
        !["reverse-in-progress", "reverse-complete", "rolled-back"].includes(row.phase) ||
        intent.completed > descriptor.reverse.resources.length ||
        (row.phase !== "reverse-in-progress" &&
          (intent.completed !== descriptor.reverse.resources.length || intent.effect !== null)))
    ) {
      throw new Error("Reverse progress is incomplete or invalid.");
    }
    if (
      new Set(publications.map((entry) => entry.name)).size !== publications.length ||
      publications.some((entry) => !names.has(entry.name)) ||
      (intent?.kind === "launcher" && !names.has(intent.name))
    ) {
      throw new Error("Package publication intent names an unknown launcher.");
    }
    return {
      revision: row.revision,
      phase: PackageActivationPhaseSchema.parse(row.phase),
      intent,
      descriptor,
      publications,
    };
  };
  const readRow = (db: DatabaseSync) => {
    const sizes = executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("package_activation")
        .select((eb) => [
          "slot",
          eb.fn<number>("length", [eb.cast("descriptor_json", "blob")]).as("descriptor_bytes"),
          eb.fn<number>("length", [eb.cast("intent_json", "blob")]).as("intent_bytes"),
          eb.fn<number>("length", [eb.cast("publications_json", "blob")]).as("publications_bytes"),
        ])
        .limit(2),
    ).rows;
    const size = sizes[0];
    if (
      sizes.length !== 1 ||
      !size ||
      size.slot !== 1 ||
      [size.descriptor_bytes, size.intent_bytes, size.publications_bytes].some(
        (bytes) => bytes > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES,
      )
    ) {
      throw new Error("Package publication journal must contain one bounded operation.");
    }
    const rows = executeSqliteQuerySync(
      db,
      queries(db).selectFrom("package_activation").selectAll().limit(2),
    ).rows;
    if (rows.length !== 1) {
      throw new Error("Package publication journal must contain exactly one operation.");
    }
    return rows[0];
  };
  const read = () => withDatabase(false, (db) => decode(readRow(db)));
  const assertRecord = (expected: PackageActivationRecord, actual: PackageActivationRecord) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("Package publication intent is no longer current");
    }
  };
  return {
    read,
    async readForRecovery() {
      const fileFingerprint = (file: string) => {
        const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (!stat) {
          return null;
        }
        if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) {
          throw new Error("Package publication journal sidecar is unsafe");
        }
        return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
      };
      assertFiles();
      const files = [
        journalPath,
        `${journalPath}-journal`,
        `${journalPath}-wal`,
        `${journalPath}-shm`,
      ];
      const identities = files.map(fileFingerprint);
      const assertUnchanged = () => {
        assertFiles();
        if (files.some((file, index) => fileFingerprint(file) !== identities[index])) {
          throw new Error("Package publication recovery journal changed");
        }
      };
      let record: PackageActivationRecord;
      let hot = false;
      try {
        record = read();
      } catch (error) {
        if (!(error instanceof Error && "errcode" in error && error.errcode === 776)) {
          throw error;
        }
        hot = true;
        assertUnchanged();
        const directory = await fsp.mkdtemp(path.join(control, ".recovery-snapshot-"));
        try {
          const targetPath = path.join(directory, "operation.sqlite");
          await createVerifiedSqliteSnapshot({
            sourcePath: journalPath,
            targetPath,
            preserveRowIds: true,
            validate: (database) => {
              decode(readRow(database));
            },
          });
          const snapshot = openNodeSqliteDatabase(targetPath, { readOnly: true });
          try {
            record = decode(readRow(snapshot));
          } finally {
            snapshot.close();
          }
        } finally {
          await fsp.rm(directory, { recursive: true, force: true });
        }
      }
      assertUnchanged();
      return {
        record,
        assertUnchanged,
        admit(assertFence: () => void) {
          assertUnchanged();
          assertFence();
          if (!hot) {
            assertRecord(record, read());
            return;
          }
          const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(journalPath));
          try {
            assertFiles();
            assertFence();
            const mode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
            if (!["delete", "truncate", "persist"].includes(String(mode))) {
              throw new Error("Package publication recovery requires rollback journal mode");
            }
            assertRecord(record, decode(readRow(database)));
          } finally {
            database.close();
          }
        },
      };
    },
    replaceCompleted(
      expected: PackageActivationRecord,
      descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
      assertCurrent: () => void,
    ) {
      const encoded = descriptorJson({ ...descriptor, journalIdentity });
      return withDatabase(true, (db, transact) =>
        transact(
          () => {
            assertFiles();
            assertCurrent();
            const previous = decode(readRow(db));
            assertRecord(expected, previous);
            if (
              !isPackageActivationComplete(anchor, previous) ||
              descriptor.journalParentIdentity !== journalParentIdentity ||
              packageActivationIdentity(preparationSource(descriptor, "anchor"), true) !==
                descriptor.anchorIdentity ||
              packageActivationIdentity(preparationSource(descriptor, "helper"), false) !==
                descriptor.helperIdentity ||
              previous.descriptor.authority.databasePath !== descriptor.authority.databasePath ||
              previous.descriptor.authority.databaseIdentity !==
                descriptor.authority.databaseIdentity ||
              previous.descriptor.authority.parentIdentity !== descriptor.authority.parentIdentity
            ) {
              throw new Error("The previous package receipt is not safely replaceable.");
            }
            executeSqliteQuerySync(
              db,
              queries(db)
                .updateTable("package_activation")
                .set({
                  revision: previous.revision + 1,
                  phase: "preparing",
                  descriptor_json: encoded,
                  intent_json: JSON.stringify({ kind: "prepare", completed: [], moving: null }),
                  publications_json: "[]",
                })
                .where("slot", "=", 1)
                .where("revision", "=", previous.revision),
            );
          },
          {
            withCommit: (commit) => {
              assertFiles();
              assertCurrent();
              commit();
            },
          },
        ),
      );
    },
    assertCurrent(expected: PackageActivationRecord) {
      assertRecord(expected, read());
    },
    transition(
      expected: PackageActivationRecord,
      phase: PackageActivationPhase,
      intent: PackageActivationIntent,
      assertCurrent: () => void,
      publications = expected.publications,
      reverse?: PackageActivationReverseBinding,
    ): PackageActivationRecord {
      if (
        reverse &&
        (expected.descriptor.reverse ||
          expected.phase !== "publication-complete" ||
          phase !== "reverse-in-progress" ||
          reverse.operationId !== expected.descriptor.operationId ||
          reverse.runId !== expected.descriptor.originalRunId ||
          intent?.kind !== "reverse" ||
          intent.completed !== 0 ||
          intent.effect !== null)
      ) {
        throw new Error(
          "Reverse binding can only be committed once by original publication admission.",
        );
      }
      const encodedDescriptor = descriptorJson(
        reverse ? { ...expected.descriptor, reverse } : expected.descriptor,
      );
      const intentJson = JSON.stringify(intentSchema.parse(intent));
      PackageActivationPhaseSchema.parse(phase);
      return withDatabase(true, (db, transact) => {
        assertCurrent();
        return transact(
          () => {
            assertFiles();
            assertCurrent();
            assertRecord(expected, decode(readRow(db)));
            executeSqliteQuerySync(
              db,
              queries(db)
                .updateTable("package_activation")
                .set({
                  revision: expected.revision + 1,
                  phase,
                  descriptor_json: encodedDescriptor,
                  intent_json: intentJson,
                  publications_json: JSON.stringify(publications),
                })
                .where("slot", "=", 1)
                .where("revision", "=", expected.revision),
            );
            return decode(readRow(db));
          },
          {
            withCommit: (commit) => {
              assertFiles();
              assertCurrent();
              commit();
            },
          },
        );
      });
    },
  };
}
export type PackageActivationJournal = ReturnType<typeof openPackageActivationJournal>;

function preparationSource(
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  name: "anchor" | "helper",
): string {
  const source = descriptor.preparation.find((entry) => entry.name === name)?.source;
  if (!source) {
    throw new Error("Package preparation bootstrap custody is missing.");
  }
  return source;
}

/** Only the original admitted producer may create the one-operation database. */
export function createPackageActivationJournal(
  anchor: string,
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  stagedControl: string,
  assertCurrent: () => void,
  onCustody?: (retained: boolean) => void,
): PackageActivationJournal {
  const control = resolvePackageActivationControl(anchor);
  const journalPath = path.join(stagedControl, PACKAGE_ACTIVATION_JOURNAL);
  const helperPath = path.join(stagedControl, "recovery.mjs");
  const assertAnchor = () => {
    assertCurrent();
    assertPackageActivationLayout(anchor);
    if (
      assertPrivate(preparationSource(descriptor, "anchor"), true) !== descriptor.anchorIdentity ||
      packageActivationIdentity(path.dirname(anchor), true) !== descriptor.parentIdentity ||
      fs.realpathSync(path.dirname(anchor)) !== path.dirname(anchor) ||
      assertPrivate(stagedControl, true) !== descriptor.journalParentIdentity ||
      fs.realpathSync(stagedControl) !== stagedControl ||
      descriptor.journalParentIdentity.split(":")[0] !== descriptor.parentIdentity.split(":")[0] ||
      preparationSource(descriptor, "helper") !== resolvePackageActivationHelper(anchor) ||
      descriptor.preparation.find((entry) => entry.name === "helper")?.sourceParentIdentity !==
        descriptor.journalParentIdentity ||
      assertPrivate(helperPath, false) !== descriptor.helperIdentity ||
      createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex") !==
        descriptor.helperDigest ||
      packageActivationIdentity(descriptor.authority.installKey, true) !==
        descriptor.previous.identity ||
      packageActivationIdentity(descriptor.originalStageRoot, true) !==
        descriptor.candidate.identity ||
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(control, { throwIfNoEntry: false })
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  assertAnchor();
  descriptorJson({ ...descriptor, journalIdentity: "0:0" });
  let journalIdentity: string;
  let initial: ActivationRow;
  const assertCreated = () => {
    assertAnchor();
    if (assertPrivate(journalPath, false) !== journalIdentity) {
      throw new Error("Package publication journal identity changed");
    }
  };
  const fd = fs.openSync(journalPath, "wx", 0o600);
  try {
    const created = fs.fstatSync(fd, { bigint: true });
    journalIdentity = `${created.dev}:${created.ino}`;
    initial = {
      slot: 1,
      revision: 0,
      phase: "preparing",
      descriptor_json: descriptorJson({ ...descriptor, journalIdentity }),
      intent_json: JSON.stringify({ kind: "prepare", completed: ["helper"], moving: null }),
      publications_json: "[]",
    };
    // Retain the created inode until SQLite closes; a later pathname must not
    // become the authority for the file this producer created.
    assertCreated();
    const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(journalPath));
    try {
      assertCreated();
      executeSqliteQuerySync(
        db,
        queries(db)
          .schema.createTable("package_activation")
          .addColumn("slot", "integer", (column) => column.primaryKey().notNull())
          .addColumn("revision", "integer", (column) => column.notNull())
          .addColumn("phase", "text", (column) => column.notNull())
          .addColumn("descriptor_json", "text", (column) => column.notNull())
          .addColumn("intent_json", "text", (column) => column.notNull())
          .addColumn("publications_json", "text", (column) => column.notNull())
          .modifyEnd(sql`STRICT`),
      );
      assertCreated();
      executeSqliteQuerySync(db, queries(db).insertInto("package_activation").values(initial));
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const assertReady = () => {
    assertCreated();
    if (
      !isDeepStrictEqual(fs.readdirSync(stagedControl).toSorted(), [
        PACKAGE_ACTIVATION_JOURNAL,
        "recovery.mjs",
      ])
    ) {
      throw new Error("Private package control contains unknown objects.");
    }
  };
  const verifyPrivate = () =>
    withExistingSqliteRollbackDatabase(
      journalPath,
      { write: false, busyTimeoutMs: 0, assertIdentity: assertReady, validate: () => {} },
      (db) => {
        const rows = executeSqliteQuerySync(
          db,
          queries(db).selectFrom("package_activation").selectAll().limit(2),
        ).rows;
        if (rows.length !== 1 || !isDeepStrictEqual({ ...rows[0] }, initial)) {
          throw new Error("Private package publication journal is incomplete.");
        }
      },
    );
  verifyPrivate();
  requireDirectorySync(syncDirectorySync(stagedControl), "Private package control");
  // No public name exists until both closed objects are complete. A lost rename
  // acknowledgement retains stage custody; only proven nonpublication releases it.
  onCustody?.(true);
  try {
    assertReady();
    fs.renameSync(stagedControl, control);
    for (const directory of new Set([path.dirname(stagedControl), path.dirname(control)])) {
      assertCurrent();
      requireDirectorySync(syncDirectorySync(directory), "Package control publication");
    }
  } catch (error) {
    try {
      if (!fs.lstatSync(control, { throwIfNoEntry: false })) {
        verifyPrivate();
        onCustody?.(false);
      }
    } catch {
      // Unknown evidence is never permission for stage cleanup.
    }
    throw error;
  }
  const journal = openPackageActivationJournal(anchor);
  const published = journal.read();
  if (descriptorJson(published.descriptor) !== initial.descriptor_json) {
    throw new Error("Published package control identity changed.");
  }
  assertCurrent();
  return journal;
}

export function assertPackageActivationOperation(
  record: PackageActivationRecord,
  operationId: string,
): void {
  if (record.descriptor.operationId !== operationId) {
    throw new Error("Package recovery command belongs to a different operation.");
  }
}

export type PackageActivationStatus = {
  phase: PackageActivationPhase | "complete";
  operationId: string;
  installKey: string;
};
export function readPackageActivationRecordStatus(
  record: PackageActivationRecord,
): PackageActivationStatus {
  return {
    phase: isPackageActivationComplete(
      resolvePackageActivationAnchor(record.descriptor.authority.installKey),
      record,
    )
      ? "complete"
      : record.phase,
    operationId: record.descriptor.operationId,
    installKey: record.descriptor.authority.installKey,
  };
}
