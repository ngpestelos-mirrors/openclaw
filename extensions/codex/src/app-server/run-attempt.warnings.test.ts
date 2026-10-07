import { expect, it, vi } from "vitest";
import { CodexEventProjection } from "./event-projector-events.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it("retries an unprojected policy warning on the next attempt, then stops replaying it", async () => {
  const harness = createStartedThreadHarness();
  const onAgentEvent = vi.fn();
  const params = { ...createTestParams(), onAgentEvent };
  const warning = {
    method: "configWarning",
    params: { summary: "Example policy was not applied." },
  };
  const projectWarning = vi.spyOn(CodexEventProjection.prototype, "handleWarning");
  projectWarning.mockImplementationOnce(() => {
    throw new Error("synthetic warning projection failure");
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const run = runCodexAppServerAttempt({ ...params, runId: "warning-run-" + attempt });
    await run.waitForTurnAccepted();
    if (attempt === 0) {
      await harness.notify(warning);
    }
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect(projectWarning).toHaveBeenNthCalledWith(1, warning.params);
    const notices = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "notice");
    expect(notices).toEqual(
      attempt === 0
        ? []
        : [
            {
              stream: "notice",
              data: { phase: "warning", message: warning.params.summary },
            },
          ],
    );
  }
});
