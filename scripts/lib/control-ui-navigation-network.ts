import type { Browser } from "playwright";

export type NavigationNetworkConditions = {
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
};

/** Page-target emulation does not reach fetches made by the production service worker. */
export async function emulateNavigationWorkerNetwork(
  browser: Browser,
  conditions: NavigationNetworkConditions,
) {
  const cdp = await browser.newBrowserCDPSession();
  let sequence = 0;
  let closed = false;
  const attaching = new Set<string>();
  const failures: Error[] = [];
  const pending = new Map<
    number,
    {
      sessionId: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const send = (sessionId: string, method: string, params: object = {}) =>
    new Promise<void>((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Service worker CDP ${method} timed out`));
      }, 30_000);
      pending.set(id, { sessionId, resolve, reject, timeout });
      void cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  const apply = (sessionId: string) =>
    send(sessionId, "Network.emulateNetworkConditions", {
      offline: false,
      latency: conditions.latency,
      downloadThroughput: conditions.downloadThroughput,
      uploadThroughput: conditions.uploadThroughput,
    });
  cdp.on("Target.receivedMessageFromTarget", (event: { sessionId: string; message: string }) => {
    const message: { id?: number; error?: { message: string } } = JSON.parse(event.message);
    if (message.id === undefined) {
      return;
    }
    const request = pending.get(message.id);
    if (!request || request.sessionId !== event.sessionId) {
      return;
    }
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve();
    }
  });
  cdp.on(
    "Target.attachedToTarget",
    (event: { sessionId: string; targetInfo: { type: string; targetId: string } }) => {
      const { targetId, type } = event.targetInfo;
      if (type !== "service_worker" || attaching.has(targetId)) {
        return;
      }
      attaching.add(targetId);
      void (async () => {
        // Browser auto-attach requires flat sessions. A second public, non-flat
        // attachment provides sendMessageToTarget without Playwright internals.
        const { sessionId }: { sessionId: string } = await cdp.send("Target.attachToTarget", {
          targetId,
          flatten: false,
        });
        try {
          await send(sessionId, "Network.enable");
          await apply(sessionId);
        } finally {
          try {
            await send(sessionId, "Runtime.runIfWaitingForDebugger");
          } finally {
            // The original flat session owns the worker startup throttle. Release
            // that attachment only after its replacement has applied the profile.
            await cdp.send("Target.detachFromTarget", { sessionId: event.sessionId });
          }
        }
      })().catch((error: unknown) => {
        if (!closed) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  );
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "service_worker" }, { exclude: true }],
  });
  return {
    assertHealthy() {
      if (failures.length) {
        throw new AggregateError(failures, "Service worker network emulation failed");
      }
    },
    async close() {
      closed = true;
      await cdp.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error("Service worker network emulation closed"));
      }
      pending.clear();
      await cdp.detach();
    },
  };
}
