export type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle" | "state-handles";

export type CoordinatorOptions = {
  databasePath: string;
  coordinatorPath?: string;
  runtimeDirectory?: string;
  uid?: number;
  busyTimeoutMs?: number;
  keepAlive?: boolean;
};

export type StateDatabaseCoordinatorLease = {
  path: string;
  // A remaining reference can accept custody without closing the native handle.
  readonly closed: boolean;
  release: () => void;
};
