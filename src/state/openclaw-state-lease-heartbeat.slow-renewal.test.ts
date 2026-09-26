import { pathToFileURL } from "node:url";
import { setEnvironmentData, type Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

const fixtureKey = "openclaw.test.slow-renewal";
const controls = vi.hoisted(() => ({
  preload: undefined as string | undefined,
  onCreate: undefined as ((worker: Worker) => void) | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const [{ runtimeProcessEntrypoints }, { resolveRuntimeWorkerUrl }] = await Promise.all([
    import("../infra/runtime-process-entrypoints.js"),
    import("../infra/runtime-worker-url.js"),
  ]);
  const heartbeatUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const heartbeat = String(filename) === heartbeatUrl.href;
        super(
          filename,
          heartbeat && controls.preload
            ? {
                ...options,
                execArgv: [...(options.execArgv ?? []), "--import", controls.preload],
              }
            : options,
        );
        if (heartbeat) {
          controls.onCreate?.(this);
        }
      }
    },
  };
});
afterEach(() => {
  setEnvironmentData(fixtureKey, undefined);
  controls.preload = undefined;
  controls.onCreate = undefined;
});

it("retains durable ownership while a real worker renewal exceeds the responsiveness grace", async () => {
  await withOpenClawTestState({ label: "slow-native-renewal" }, async (state) => {
    const control = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    setEnvironmentData(fixtureKey, control.buffer);
    const preload = await state.writeText(
      "slow-renewal.mjs",
      [
        'import { DatabaseSync } from "node:sqlite";',
        'import { getEnvironmentData } from "node:worker_threads";',
        "const control = new Int32Array(getEnvironmentData(" + JSON.stringify(fixtureKey) + "));",
        "const prepare = DatabaseSync.prototype.prepare;",
        "DatabaseSync.prototype.prepare = function(sql) {",
        "  const statement = Reflect.apply(prepare, this, [sql]);",
        '  if (/^update ["\x60]?state_leases/i.test(sql)) {',
        "    const run = statement.run;",
        "    statement.run = function(...args) {",
        "      if (Atomics.compareExchange(control, 0, 1, 0) === 1) {",
        "        Atomics.store(control, 1, 1); Atomics.notify(control, 1);",
        "        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);",
        "      }",
        "      return Reflect.apply(run, this, args);",
        "    };",
        "  }",
        "  return statement;",
        "};",
      ].join("\n"),
    );
    controls.preload = pathToFileURL(preload).href;
    let worker: Worker | undefined;
    controls.onCreate = (created) => {
      worker = created;
    };
    const options = {
      scope: "core:test-slow-renewal",
      key: "maintenance",
      database: { scope: "shared" as const, options: { env: state.env } },
      leaseMs: 30_000,
      waitMs: 0,
      heartbeat: "worker" as const,
    };
    await withOpenClawStateLease(options, async (lease) => {
      if (!worker) {
        throw new Error("Missing real heartbeat worker");
      }
      const database = openOpenClawStateDatabase({ env: state.env });
      const read = () =>
        database.db
          .prepare("SELECT owner, expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
          .get(options.scope, options.key);
      const before = read();
      expect(before).toBeDefined();
      // Delay one actual SQLite UPDATE in the worker, not its acknowledgment or
      // the parent's clock. The normal lease owner must wait, then recheck disk.
      Atomics.store(control, 0, 1);
      worker.postMessage({ id: 1_000_000, operation: "renew" }, []);
      Atomics.wait(control, 1, 0, 10_000);
      expect(Atomics.load(control, 1)).toBe(1);
      const started = performance.now();
      lease.assertOwned();
      expect(performance.now() - started).toBeGreaterThan(1_000);
      expect(lease.signal.aborted).toBe(false);
      const after = read();
      expect(after?.owner).toBe(before?.owner);
      expect(Number(after?.expires_at)).toBeGreaterThanOrEqual(Number(before?.expires_at));
    });
  });
});
