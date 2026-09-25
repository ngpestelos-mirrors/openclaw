import "./swarm-scheduler.js";

type SwarmSchedulerTestApi = {
  testing: {
    reset(): void;
    capturePendingLaunch(
      runId: string,
    ):
      | (() => { holds: number; waitingForHolds: boolean; startFailureEntered: boolean })
      | undefined;
  };
};

function getTestApi(): SwarmSchedulerTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.swarmSchedulerTestApi")
  ] as SwarmSchedulerTestApi;
}

export const testing = getTestApi().testing;
