import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

const clients: CodexAppServerClient[] = [];
const policyWarning = {
  method: "configWarning",
  params: {
    summary:
      "Ignoring unknown `features` requirement `ultrafast_mode` from requirements layers: enterprise-managed requirements Example policy (example-policy)",
    details: null,
    path: null,
    range: null,
  },
};

function createHarness() {
  const harness = createClientHarness();
  clients.push(harness.client);
  return { ...harness, router: getCodexAppServerTurnRouter(harness.client) };
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  vi.restoreAllMocks();
});

it.each([false, true])(
  "does not replay a delivered policy warning on later turns (active: %s)",
  async (active) => {
    const harness = createHarness();
    const { router } = harness;
    const receive = vi.fn(() => true);
    const first = router.reserveThread({ threadId: "first", onNotification: receive });
    first.armTurn();
    if (active) {
      await first.bindTurn("turn-1");
    }
    harness.send(policyWarning);
    if (!active) {
      await first.bindTurn("turn-1");
    }
    await first.drain();
    expect(receive).toHaveBeenCalledExactlyOnceWith(policyWarning, { threadId: "first" });
    first.release();

    const later = router.reserveThread({ threadId: "first", onNotification: receive });
    later.armTurn();
    await later.bindTurn("turn-2");
    expect(receive).toHaveBeenCalledTimes(1);

    const sibling = router.reserveThread({ threadId: "sibling", onNotification: receive });
    sibling.armTurn();
    await sibling.bindTurn("turn-1");
    expect(receive).toHaveBeenLastCalledWith(policyWarning, { threadId: "sibling" });
    expect(receive).toHaveBeenCalledTimes(2);

    // An actual new upstream receipt is not a replay, even with identical text.
    harness.send(policyWarning);
    await Promise.all([later.drain(), sibling.drain()]);
    expect(receive).toHaveBeenCalledTimes(4);

    const scoped = {
      method: "warning",
      params: { threadId: "first", message: "Execution policy changed." },
    };
    harness.send(scoped);
    harness.send(scoped);
    await later.drain();
    expect(receive.mock.calls.slice(-2)).toEqual([
      [scoped, { threadId: "first" }],
      [scoped, { threadId: "first" }],
    ]);
  },
);

it.each(["unbound", "request-only", "failed", "unacknowledged"] as const)(
  "retains policy warnings after %s routes",
  async (kind) => {
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const { router } = harness;
    harness.send(policyWarning);
    const first = router.reserveThread({
      threadId: "first",
      ...(kind === "request-only"
        ? { onRequest: async () => null }
        : {
            onNotification: () => {
              if (kind === "failed") {
                throw new Error("projection failed");
              }
            },
          }),
    });
    if (kind !== "unbound") {
      first.armTurn();
      await first.bindTurn("turn-1");
    }
    first.release();
    const receive = vi.fn(() => true);
    const later = router.reserveThread({ threadId: "first", onNotification: receive });
    later.armTurn();
    await later.bindTurn("turn-2");
    expect(receive).toHaveBeenCalledExactlyOnceWith(policyWarning, { threadId: "first" });
  },
);

it("keeps startup receipts connection-local", async () => {
  const receive = vi.fn(() => true);
  for (let connection = 0; connection < 2; connection++) {
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.send(policyWarning);
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "first",
      onNotification: receive,
    });
    route.armTurn();
    await route.bindTurn("turn-1");
    harness.client.close();
  }
  expect(receive).toHaveBeenCalledTimes(2);
});

it("bounds global warning receipts by allowing old threads to be notified again", async () => {
  const harness = createHarness();
  const { router } = harness;
  const receive = vi.fn(() => true);
  const warning = {
    method: "warning",
    params: { threadId: null, message: "Custom execution rules were not applied." },
  };
  harness.send(warning);
  async function runThread(threadId: string) {
    const route = router.reserveThread({ threadId, onNotification: receive });
    route.armTurn();
    await route.bindTurn("turn");
    route.release();
  }
  for (let index = 0; index < 256; index++) {
    await runThread(String(index));
  }
  expect(receive).toHaveBeenCalledTimes(256);
  await runThread("0");
  expect(receive).toHaveBeenCalledTimes(256);
  await runThread("256");
  await runThread("0");
  expect(receive).toHaveBeenCalledTimes(258);
  expect(receive).toHaveBeenLastCalledWith(warning, { threadId: "0" });
});

it.each([false, true])("joins a replaced route's pending delivery (fails: %s)", async (fails) => {
  vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  const harness = createHarness();
  const { router } = harness;
  harness.send(policyWarning);
  const started = createDeferred<void>();
  const projected = createDeferred<void>();
  const receive = vi
    .fn<() => boolean | Promise<boolean>>(() => true)
    .mockImplementationOnce(() => {
      started.resolve();
      return projected.promise.then(() => true);
    });
  const first = router.reserveThread({ threadId: "first", onNotification: receive });
  first.armTurn();
  const firstBinding = first.bindTurn("turn-1");
  const rejected = expect(firstBinding).rejects.toThrow("released");
  await started.promise;
  first.release();
  await rejected;

  const later = router.reserveThread({ threadId: "first", onNotification: receive });
  later.armTurn();
  const laterBinding = later.bindTurn("turn-2");
  // Let the replacement enter its already-enqueued delivery callback.
  await Promise.resolve();
  const callsWhilePending = receive.mock.calls.length;
  if (fails) {
    projected.reject(new Error("projection failed"));
  } else {
    projected.resolve();
  }
  await laterBinding;
  expect(callsWhilePending).toBe(1);
  expect(receive).toHaveBeenCalledTimes(fails ? 2 : 1);
});
