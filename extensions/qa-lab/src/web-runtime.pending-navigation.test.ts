import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { withPendingWebPage } from "./web-runtime.pending-navigation.test-helper.js";

function pendingFixture() {
  const opening = createDeferred<void>();
  const ready = createDeferred<void>();
  const close = vi.fn<() => void>();
  const verify = vi.fn<() => Promise<void>>();
  return {
    opening,
    ready,
    close,
    verify,
    run: () =>
      withPendingWebPage({ opening: opening.promise, ready: ready.promise, close, verify }),
  };
}

describe("QA web pending-navigation fixture", () => {
  it("rejects acquisition that completes before the request", async () => {
    const { opening, close, verify, run } = pendingFixture();
    opening.resolve();
    await expect(run()).rejects.toThrow("web page acquisition completed before pending navigation");
    expect(verify).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs the cancellation assertion only after request readiness", async () => {
    const { opening, ready, close, verify, run } = pendingFixture();
    const cancelled = new Error("scenario cancelled");
    const order: string[] = [];
    verify.mockImplementation(async () => {
      order.push("verify");
      opening.reject(cancelled);
      await expect(opening.promise).rejects.toBe(cancelled);
    });
    close.mockImplementation(() => {
      order.push("close");
    });
    const pending = run();
    try {
      expect(verify).not.toHaveBeenCalled();
      ready.resolve();
      await pending;
      expect(verify).toHaveBeenCalledOnce();
      expect(order).toEqual(["verify", "close"]);
    } finally {
      ready.resolve();
      opening.reject(cancelled);
      await pending;
    }
  });

  it.each(["assertion", "close"] as const)(
    "cancels and joins acquisition after %s failure",
    async (phase) => {
      const { opening, ready, close, verify, run } = pendingFixture();
      const cancelled = new Error("fixture cancelled");
      const closeError = new Error("fixture close failed");
      const assertionError = new Error("fixture assertion failed");
      const closing = createDeferred<void>();
      const finished = vi.fn();
      close.mockImplementation(() => {
        closing.resolve();
        if (phase === "close") {
          throw closeError;
        }
      });
      verify.mockImplementation(async () => {
        if (phase === "assertion") {
          throw assertionError;
        }
      });
      ready.resolve();
      const pending = run()
        .catch((error: unknown) => error)
        .then((result) => {
          finished();
          return result;
        });
      try {
        await Promise.race([
          closing.promise,
          pending.then(() => {
            throw new Error("fixture settled before cancellation");
          }),
        ]);
        await setImmediate();
        expect(close).toHaveBeenCalledOnce();
        expect(finished).not.toHaveBeenCalled();
        opening.reject(cancelled);
        await expect(pending).resolves.toBe(phase === "assertion" ? assertionError : closeError);
        expect(finished).toHaveBeenCalledOnce();
      } finally {
        opening.reject(cancelled);
        await pending;
      }
    },
  );

  it("preserves both acquisition and cleanup failures without waiting for readiness", async () => {
    const { opening, close, verify, run } = pendingFixture();
    const acquisitionError = new Error("navigation failed");
    const rollbackError = new Error("rollback failed");
    const primaryFailure = new AggregateError(
      [acquisitionError, rollbackError],
      "web page open and cleanup failed",
      { cause: acquisitionError },
    );
    const closeError = new AggregateError([rollbackError], "web session cleanup failed");
    close.mockImplementation(() => {
      throw closeError;
    });
    opening.reject(primaryFailure);
    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw failure;
    }
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(primaryFailure);
    expect(failure.errors[1]).toBe(closeError);
    expect(failure.cause).toBe(primaryFailure);
    expect(close).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
  });
});
