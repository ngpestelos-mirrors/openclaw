import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeGitHubOAuthRecord } from "../agents/github-oauth-records.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { createGitHubOAuthLifecycle } from "./github-oauth-lifecycle.js";
import {
  configForScope,
  identity,
  NOW,
  oauthRecord,
  OLD_PROFILE,
} from "./github-oauth-lifecycle.test-support.js";

const refreshToken = vi.hoisted(() => vi.fn());
vi.mock("../agents/github-oauth-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/github-oauth-client.js")>()),
  refreshGitHubOAuthToken: refreshToken,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refreshes once after sleep while personal maintenance is pending, then stops scheduling", async () => {
  closeOpenClawStateDatabaseForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-github-oauth-scheduling-"));
  const time = createGatewaySchedulerClock(NOW);
  vi.spyOn(Date, "now").mockImplementation(time.clock.now);
  const config = configForScope("system", identity(OLD_PROFILE, { oauth: true }));
  writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
  let scheduled = createDeferredCore();
  const scheduler = new GatewayScheduler({
    clock: {
      ...time.clock,
      arm: (run, delayMs) => {
        const cancel = time.clock.arm(run, delayMs);
        if (delayMs > 0) {
          scheduled.resolve();
        }
        return cancel;
      },
    },
  });
  refreshToken.mockResolvedValue({ status: "error", code: "device_flow_disabled" });
  const lifecycle = createGitHubOAuthLifecycle({
    getConfig: () => config,
    warn: vi.fn(),
    scheduler,
  });
  const personal = createDeferredCore();
  vi.spyOn(lifecycle.personal, "maintain").mockReturnValue(personal.promise);

  try {
    lifecycle.start();
    time.wake();
    await scheduled.promise;
    expect(refreshToken).toHaveBeenCalledOnce();

    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    scheduled = createDeferredCore();
    time.advanceBy(5 * 60_000);
    await scheduled.promise;
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(lifecycle.personal.maintain).toHaveBeenCalledOnce();

    personal.resolve();
    await lifecycle.stop();
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    time.advanceBy(60_000);
    expect(refreshToken).toHaveBeenCalledTimes(2);
  } finally {
    personal.resolve();
    await lifecycle.stop();
  }
});
