import { createDeferred } from "../../test/helpers/promise.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createSessionActivitySummaries } from "./session-activity-summaries.js";

/** Await provider and publication progress without racing worker startup against a polling timeout. */
export function createActivitySummaryTestProgress() {
  let progress = createDeferred();
  const notify = () => {
    const previous = progress;
    progress = createDeferred();
    previous.resolve();
  };
  const unsubscribe = sessionChanges.subscribe(notify);
  return {
    dispose: unsubscribe,
    create(deps: Parameters<typeof createSessionActivitySummaries>[0]) {
      const { prepareModel, completeModel } = deps;
      return createSessionActivitySummaries({
        ...deps,
        onChanged(target) {
          deps.onChanged(target);
          notify();
        },
        prepareModel:
          prepareModel &&
          ((params) => {
            const result = prepareModel(params);
            notify();
            return result;
          }),
        completeModel:
          completeModel &&
          ((params) => {
            const result = completeModel(params);
            notify();
            return result;
          }),
      });
    },
    async waitFor(assertion: () => void) {
      for (;;) {
        const next = progress.promise;
        try {
          assertion();
          return;
        } catch {
          await next;
        }
      }
    },
  };
}
