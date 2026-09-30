import { GatewayScheduler } from "./gateway-scheduler.js";

/** Capture the maintenance entrypoint while leaving storage admission and execution intact. */
export function observeSqliteWalPeriodicWork() {
  const originalScope = GatewayScheduler.prototype.scope;
  let periodic: (() => void | Promise<unknown>) | undefined;
  GatewayScheduler.prototype.scope = function () {
    const scope = originalScope.call(this);
    return {
      ...scope,
      schedule(params) {
        if (params.id.startsWith("sqlite-wal:") && params.id.endsWith(":periodic")) {
          if (periodic) {
            throw new Error("Expected one published WAL maintenance owner");
          }
          periodic = () => (scope.signal.aborted ? undefined : params.run());
        }
        return scope.schedule(params);
      },
    };
  };
  return {
    restore: () => {
      GatewayScheduler.prototype.scope = originalScope;
    },
    get periodic() {
      if (!periodic) {
        throw new Error("Database did not register periodic WAL maintenance");
      }
      return periodic;
    },
  };
}
