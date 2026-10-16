import { once } from "node:events";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { expect, it } from "vitest";

it("reports an unavailable admission host when its peer disappears without replying", async () => {
  const channel = new MessageChannel();
  const elapsed = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  channel.port1.once("message", (request: { port: MessagePort; decision: SharedArrayBuffer }) => {
    request.port.close();
    channel.port1.close();
    // Advance only the worker's monotonic deadline and wake its native wait;
    // the production timeout remains 30 seconds without slowing this regression.
    Atomics.store(elapsed, 0, 30_001);
    Atomics.notify(new Int32Array(request.decision), 0);
  });
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { exchangeSqliteDatabaseAdmissions } = await import(workerData.relay);
       const monotonic = process.hrtime.bigint.bind(process.hrtime);
       const elapsed = new Int32Array(workerData.elapsed);
       process.hrtime.bigint = () => monotonic() + BigInt(Atomics.load(elapsed, 0)) * 1_000_000n;
       parentPort.postMessage({ ready: true });
       try {
         exchangeSqliteDatabaseAdmissions(workerData.port, []);
         parentPort.postMessage({ unexpectedSuccess: true });
       } catch (error) {
         parentPort.postMessage({ message: error.message, code: error.code });
       } finally {
         workerData.port.close();
         parentPort.close();
       }
     })().catch((error) => { throw error; });`,
    {
      eval: true,
      execArgv: [],
      workerData: {
        port: channel.port2,
        elapsed: elapsed.buffer,
        loader: import.meta.resolve("tsx/esm/api"),
        relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
      },
      transferList: [channel.port2],
    },
  );
  try {
    await once(worker, "message");
    const [result] = await once(worker, "message", { signal: AbortSignal.timeout(2_000) });
    expect(result).toEqual({
      message: "SQLite admission facts exchange timed out after 30 seconds; the host did not reply",
      code: "unavailable",
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
    await worker.terminate();
  }
});
