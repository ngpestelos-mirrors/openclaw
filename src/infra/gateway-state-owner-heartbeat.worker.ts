import fs from "node:fs";
import { parentPort as port, workerData } from "node:worker_threads";
import { hasErrnoCode } from "./errno.js";
const { locks, intervalMs }: { locks: Record<string, string>; intervalMs: number } = workerData;
const rootPath = Object.keys(locks)[0];
setInterval(() => {
  try {
    Object.entries(locks).every(([lockPath, raw]) => {
      if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8") === raw) {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
        return true;
      }
      return lockPath !== rootPath;
    });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
}, intervalMs).unref();
port?.on("message", (message: "stop" | [string, string]) =>
  message === "stop" ? port?.close() : Object.assign(locks, { [message[0]]: message[1] }),
);
port?.postMessage(null);
