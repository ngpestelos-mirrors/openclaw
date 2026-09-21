import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { normalizeWindowsPathForComparison } from "@openclaw/fs-safe/path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { sqliteErrorCode } from "./sqlite-error-diagnostics.js";

export type SqliteReaderOwner = {
  operation: string;
  ownerKind: "main" | "worker";
  actorId?: number;
};

export type SqliteReaderDiagnostic = SqliteReaderOwner & {
  kind: "iterator" | "statement" | "transaction";
  connectionId: number;
  threadId: number;
  ageMs: number;
  idleMs: number;
};

type ActiveReader = Omit<SqliteReaderDiagnostic, "ageMs" | "idleMs"> & {
  startedAtMs: number;
  lastProgressAtMs: number;
};

type ReaderLease = { progress(): void; release(): void };
type StatementReader = { lease?: ReaderLease };
type Connection = {
  id: number;
  path?: string;
  database: WeakRef<DatabaseSync>;
  owner: SqliteReaderOwner;
  openedAtMs: number;
  nativeTracked: boolean;
  transaction?: ReaderLease;
};

export type SqliteReaderDiagnostics = {
  scope: "current-thread";
  blockingOwner: "unknown";
  threadId: number;
  observedAtMs: number;
  connectionCount: number;
  readerCount: number;
  connections: Array<
    SqliteReaderOwner & {
      connectionId: number;
      threadId: number;
      ageMs: number;
      transactionOpen: boolean;
      activeStatements: number;
    }
  >;
  activeReaders: SqliteReaderDiagnostic[];
};

const readerOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReaderOwners"),
  () => new AsyncLocalStorage<SqliteReaderOwner>(),
);

const activeReaders = resolveGlobalSingleton(Symbol.for("openclaw.sqliteActiveReaders"), () => ({
  byDatabase: new WeakMap<DatabaseSync, Map<symbol, ActiveReader>>(),
  byPath: new Map<string, Map<symbol, ActiveReader>>(),
}));

const connections = resolveGlobalSingleton(Symbol.for("openclaw.sqliteReaderConnections"), () => ({
  nextId: 0,
  instrumented: new WeakSet<DatabaseSync>(),
  byDatabase: new WeakMap<DatabaseSync, Connection>(),
  byPath: new Map<string, Map<number, Connection>>(),
  finalizer: new FinalizationRegistry<Connection>((connection) => releaseConnection(connection)),
}));
const statementReaders = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteStatementReaders"),
  () => new FinalizationRegistry<StatementReader>((reader) => reader.lease?.release()),
);

/** The same Windows file can arrive with a namespaced or differently cased path. */
export function sqliteReaderDatabasePathKey(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  return process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
}

function boundedOperation(operation: string): string {
  const normalized = operation.trim();
  return (normalized || "sqlite reader").slice(0, 120);
}

export function withSqliteReaderOwner<T>(owner: SqliteReaderOwner, operation: () => T): T {
  return readerOwners.run({ ...owner, operation: boundedOperation(owner.operation) }, operation);
}

export function captureSqliteReaderOwner(): SqliteReaderOwner | undefined {
  const owner = readerOwners.getStore();
  return owner ? { ...owner } : undefined;
}

function currentOwner(
  fallbackOperation: string,
  capturedOwner?: SqliteReaderOwner,
): SqliteReaderOwner {
  const inherited = capturedOwner ?? readerOwners.getStore();
  return {
    operation: boundedOperation(inherited?.operation ?? fallbackOperation),
    ownerKind: inherited?.ownerKind ?? (isMainThread ? "main" : "worker"),
    ...(inherited?.actorId !== undefined ? { actorId: inherited.actorId } : {}),
  };
}

function connectionFor(database: DatabaseSync): Connection {
  let connection = connections.byDatabase.get(database);
  if (!connection) {
    const now = Date.now();
    const location = database.location();
    connection = {
      id: ++connections.nextId,
      path: location ? sqliteReaderDatabasePathKey(location) : undefined,
      database: new WeakRef(database),
      owner: currentOwner("sqlite connection"),
      openedAtMs: now,
      nativeTracked: connections.instrumented.has(database),
    };
    connections.byDatabase.set(database, connection);
    if (connection.path) {
      const entries = connections.byPath.get(connection.path) ?? new Map();
      entries.set(connection.id, connection);
      connections.byPath.set(connection.path, entries);
    }
    connections.finalizer.register(database, connection, connection);
  }
  return connection;
}

function releaseConnection(connection: Connection): void {
  connection.transaction?.release();
  connection.transaction = undefined;
  if (connection.path) {
    const readers = activeReaders.byPath.get(connection.path);
    for (const [token, reader] of readers ?? []) {
      if (reader.connectionId === connection.id) {
        readers?.delete(token);
      }
    }
    if (readers?.size === 0) {
      activeReaders.byPath.delete(connection.path);
    }
    const entries = connections.byPath.get(connection.path);
    entries?.delete(connection.id);
    if (entries?.size === 0) {
      connections.byPath.delete(connection.path);
    }
  }
  const database = connection.database.deref();
  if (database && connections.byDatabase.get(database) === connection) {
    activeReaders.byDatabase.delete(database);
    connections.byDatabase.delete(database);
  }
  connections.finalizer.unregister(connection);
}

export function retainSqliteReader(
  database: DatabaseSync,
  fallbackOperation: string,
  capturedOwner?: SqliteReaderOwner,
  kind: SqliteReaderDiagnostic["kind"] = "iterator",
): ReaderLease {
  const connection = connectionFor(database);
  // Native stepping owns reader lifetime on managed handles; Kysely remains a fallback
  // for external handles without publishing a second record for the same statement.
  if (kind === "iterator" && connection.nativeTracked) {
    return { progress() {}, release() {} };
  }
  const now = Date.now();
  const reader: ActiveReader = {
    ...currentOwner(fallbackOperation, capturedOwner),
    kind,
    connectionId: connection.id,
    threadId,
    startedAtMs: now,
    lastProgressAtMs: now,
  };
  const token = Symbol(reader.operation);
  const databaseReaders = activeReaders.byDatabase.get(database) ?? new Map();
  databaseReaders.set(token, reader);
  activeReaders.byDatabase.set(database, databaseReaders);
  const databasePath = connection.path;
  const pathReaders = databasePath
    ? (activeReaders.byPath.get(databasePath) ?? new Map<symbol, ActiveReader>())
    : undefined;
  pathReaders?.set(token, reader);
  if (databasePath && pathReaders) {
    activeReaders.byPath.set(databasePath, pathReaders);
  }
  let released = false;
  const databaseReference = connection.database;
  return {
    progress() {
      if (!released) {
        reader.lastProgressAtMs = Date.now();
      }
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      databaseReaders.delete(token);
      if (databaseReaders.size === 0) {
        const current = databaseReference.deref();
        if (current && activeReaders.byDatabase.get(current) === databaseReaders) {
          activeReaders.byDatabase.delete(current);
        }
      }
      pathReaders?.delete(token);
      if (
        databasePath &&
        pathReaders?.size === 0 &&
        activeReaders.byPath.get(databasePath) === pathReaders
      ) {
        activeReaders.byPath.delete(databasePath);
      }
    },
  };
}

function diagnostics(readers: Iterable<ActiveReader>): SqliteReaderDiagnostic[] {
  const now = Date.now();
  return [...readers]
    .map((reader) => {
      const diagnostic: SqliteReaderDiagnostic = {
        operation: reader.operation,
        ownerKind: reader.ownerKind,
        kind: reader.kind,
        connectionId: reader.connectionId,
        threadId: reader.threadId,
        ageMs: Math.max(0, now - reader.startedAtMs),
        idleMs: Math.max(0, now - reader.lastProgressAtMs),
      };
      if (reader.actorId !== undefined) {
        diagnostic.actorId = reader.actorId;
      }
      return diagnostic;
    })
    .toSorted((left, right) => right.ageMs - left.ageMs)
    .slice(0, 8);
}

function readActiveSqliteReaders(database: DatabaseSync): SqliteReaderDiagnostic[] {
  return diagnostics(activeReaders.byDatabase.get(database)?.values() ?? []);
}

/** Observed local activity is diagnostic evidence, not proof of which connection owns a WAL lock. */
export function readSqliteReaderDiagnosticsForPath(databasePath: string): SqliteReaderDiagnostics {
  const key = sqliteReaderDatabasePathKey(databasePath);
  const entries = connections.byPath.get(key);
  const localConnections: SqliteReaderDiagnostics["connections"] = [];
  const now = Date.now();
  for (const connection of entries?.values() ?? []) {
    const database = connection.database.deref();
    if (!database?.isOpen) {
      releaseConnection(connection);
      continue;
    }
    const readers = activeReaders.byDatabase.get(database);
    localConnections.push({
      ...connection.owner,
      connectionId: connection.id,
      threadId,
      ageMs: Math.max(0, now - connection.openedAtMs),
      transactionOpen: database.isTransaction,
      activeStatements: [...(readers?.values() ?? [])].filter(
        (reader) => reader.kind !== "transaction",
      ).length,
    });
  }
  const readers = activeReaders.byPath.get(key);
  return {
    scope: "current-thread",
    blockingOwner: "unknown",
    threadId,
    observedAtMs: now,
    connectionCount: localConnections.length,
    readerCount: readers?.size ?? 0,
    connections: localConnections
      .toSorted(
        (left, right) =>
          right.activeStatements - left.activeStatements ||
          Number(right.transactionOpen) - Number(left.transactionOpen),
      )
      .slice(0, 8),
    activeReaders: diagnostics(readers?.values() ?? []),
  };
}

type StatementCall<Result> = {
  (...parameters: SQLInputValue[]): Result;
  (named: Record<string, SQLInputValue>, ...parameters: SQLInputValue[]): Result;
};

function isNamedBindings(
  value: SQLInputValue | Record<string, SQLInputValue>,
): value is Record<string, SQLInputValue> {
  return value !== null && typeof value === "object" && !ArrayBuffer.isView(value);
}

function callNativeStatement<Result>(
  execute: StatementCall<Result>,
  parameters: [] | [SQLInputValue | Record<string, SQLInputValue>, ...SQLInputValue[]],
): Result {
  if (parameters.length === 0) {
    return execute();
  }
  const [firstValue, ...remaining] = parameters;
  const first = firstValue!;
  // Views are positional BLOBs; other objects select the native named-bindings overload.
  if (isNamedBindings(first)) {
    return execute(first, ...remaining);
  }
  return execute(first, ...remaining);
}

/** Observe native lifetimes without retaining SQL, bindings, or the connection itself. */
export function installSqliteReaderDiagnostics(database: DatabaseSync): void {
  if (connections.instrumented.has(database)) {
    return;
  }
  connections.instrumented.add(database);
  if (database.isOpen) {
    connectionFor(database).nativeTracked = true;
  }
  const observeTransaction = () => {
    if (!database.isOpen) {
      return;
    }
    const connection = connectionFor(database);
    if (database.isTransaction) {
      if (!connection.transaction) {
        connection.owner = captureSqliteReaderOwner() ?? connection.owner;
        connection.transaction = retainSqliteReader(
          database,
          "sqlite transaction",
          undefined,
          "transaction",
        );
      }
    } else {
      connection.transaction?.release();
      connection.transaction = undefined;
    }
  };
  const exec = database.exec.bind(database);
  database.exec = (...args) => {
    try {
      return exec(...args);
    } finally {
      observeTransaction();
    }
  };
  const prepare = database.prepare.bind(database);
  database.prepare = (...args) => {
    const statement = prepare(...args);
    connectionFor(database);
    const preparedOwner = captureSqliteReaderOwner();
    // Keep only the independent lease in finalization custody, never this statement's closures.
    const active: StatementReader = {};
    const release = () => {
      active.lease?.release();
      active.lease = undefined;
      statementReaders.unregister(active);
    };
    const resetAndRun = <T>(execute: () => T): T => {
      release();
      try {
        return execute();
      } finally {
        observeTransaction();
      }
    };
    const get = statement.get.bind(statement);
    statement.get = (...parameters) => resetAndRun(() => callNativeStatement(get, parameters));
    const all = statement.all.bind(statement);
    statement.all = (...parameters) => resetAndRun(() => callNativeStatement(all, parameters));
    const run = statement.run.bind(statement);
    statement.run = (...parameters) => resetAndRun(() => callNativeStatement(run, parameters));
    const iterate = statement.iterate.bind(statement);
    statement.iterate = (...parameters) => {
      release();
      const iterator = callNativeStatement(iterate, parameters);
      const next = iterator.next.bind(iterator);
      iterator.next = (...input) => {
        if (!database.isOpen) {
          return next(...input);
        }
        const alreadyActive = active.lease !== undefined;
        active.lease ??= retainSqliteReader(
          database,
          "sqlite statement",
          captureSqliteReaderOwner() ?? preparedOwner,
          "statement",
        );
        if (!alreadyActive) {
          statementReaders.register(statement, active, active);
        }
        active.lease.progress();
        // A native decoding error can leave sqlite3_step at SQLITE_ROW; keep custody
        // until return, statement reset, or connection close actually releases it.
        try {
          const result = next(...input);
          if (result.done) {
            release();
          }
          return result;
        } catch (error) {
          // An invalidated iterator never stepped; an older iterator must not
          // discard another iterator's still-active reader on the same statement.
          if (!alreadyActive && sqliteErrorCode(error) === "ERR_INVALID_STATE") {
            release();
          }
          throw error;
        }
      };
      if (iterator.return) {
        const finish = iterator.return.bind(iterator);
        iterator.return = (...input) => {
          const result = finish(...input);
          release();
          return result;
        };
      }
      return iterator;
    };
    return statement;
  };
  const close = database.close.bind(database);
  const releaseClosed = () => {
    const connection = connections.byDatabase.get(database);
    if (connection && !database.isOpen) {
      releaseConnection(connection);
    }
  };
  database.close = () => {
    try {
      return close();
    } finally {
      releaseClosed();
    }
  };
  if (typeof database[Symbol.dispose] === "function") {
    const dispose = database[Symbol.dispose].bind(database);
    database[Symbol.dispose] = () => {
      try {
        dispose();
      } finally {
        releaseClosed();
      }
    };
  }
  const open = database.open.bind(database);
  database.open = () => {
    open();
    connectionFor(database);
  };
  if (typeof database.deserialize === "function") {
    const deserialize = database.deserialize.bind(database);
    database.deserialize = (...parameters) => {
      try {
        return deserialize(...parameters);
      } finally {
        // Native replacement finalizes statements before attempting deserialization,
        // including a failed attempt. The connection's transaction is observed anew.
        const connection = connections.byDatabase.get(database);
        if (connection) {
          releaseConnection(connection);
        }
        observeTransaction();
      }
    };
  }
}

export function assertNoActiveSqliteReaders(database: DatabaseSync, label: string): void {
  const readers = readActiveSqliteReaders(database);
  if (readers.length === 0) {
    return;
  }
  const oldest = readers[0]!;
  throw new Error(
    `${label} retained ${readers.length} active SQLite reader(s); oldest operation=${oldest.operation} ageMs=${oldest.ageMs}`,
  );
}
