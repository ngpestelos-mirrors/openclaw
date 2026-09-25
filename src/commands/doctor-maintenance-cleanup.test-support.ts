import { resolveCommandProcessSignal, retainCommandProcessCleanup } from "../process/exec-spawn.js";
import { createDeferredCore } from "../shared/deferred.js";

export function cleanupBarrier() {
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  return {
    cleanup,
    joining: joining.promise,
    retain() {
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
    },
  };
}
