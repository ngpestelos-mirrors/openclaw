import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
  setPwToolsCoreDownloadCapture,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.downloads.js");
const interactions = await import("./pw-tools-core.interactions.js");
const { waitForViaPlaywright } = await import("./pw-tools-core.interactions.content.js");
const target = { cdpUrl: "http://127.0.0.1:18792" };
const session = getPwToolsCoreSessionMocks();
function holdPreparation() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    release,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    wait: (operation: Promise<unknown>, message: string) =>
      Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error(message);
        }),
      ]),
  };
}

describe("pw-tools-core", () => {
  it("preserves an accepted download waiter when a stale successor finishes page preparation", async () => {
    const page = {};
    setPwToolsCoreCurrentPage(page);
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ click });
    const result = {
      url: "https://example.com/accepted.txt",
      suggestedFilename: "accepted.txt",
      path: "/tmp/accepted.txt",
    };
    const captured = createDeferred<typeof result>();
    setPwToolsCoreDownloadCapture({ armed: true, promise: captured.promise, cancel: vi.fn() });
    const accepted = mod.waitForDownloadViaPlaywright({ ...target, targetId: "T1" });
    const acceptedResult = Promise.allSettled([accepted]);
    await Promise.resolve();
    const held = holdPreparation();
    session.getPageForTargetId.mockImplementationOnce(async () => {
      await held.prepare();
      return page;
    });
    const successor = mod.downloadViaPlaywright({
      ...target,
      targetId: "T1",
      ref: "e1",
      path: "/tmp/rejected.txt",
      assertCurrent: async () => {
        throw new Error("Dashboard successor revoked");
      },
    });
    const successorResult = Promise.allSettled([successor]);
    try {
      await held.wait(successor, "Successor skipped held page lookup");
      held.release.resolve();
      expect(await successorResult).toMatchObject([
        { status: "rejected", reason: { message: "Dashboard successor revoked" } },
      ]);
      captured.resolve(result);
      expect(await acceptedResult).toEqual([{ status: "fulfilled", value: result }]);
      expect(click).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      captured.resolve(result);
      await Promise.all([acceptedResult, successorResult]);
    }
  });

  it.each(["page preparation", "pending-dialog lookup"] as const)(
    "checks dialog authority after %s",
    async (boundary) => {
      const page = {};
      setPwToolsCoreCurrentPage(page);
      const held = holdPreparation();
      if (boundary === "page preparation") {
        session.getPageForTargetId.mockImplementationOnce(async () => {
          await held.prepare();
          return page;
        });
      } else {
        session.respondToObservedDialogOnPage.mockImplementationOnce(async () => {
          await held.prepare();
          throw new Error("No dialog is pending.");
        });
      }
      let current = true;
      const operation = mod.armDialogViaPlaywright({
        ...target,
        accept: true,
        assertCurrent: async () => {
          if (!current) {
            throw new Error("Dashboard dialog revoked");
          }
        },
      });
      const settled = Promise.allSettled([operation]);
      try {
        await held.wait(operation, "Dialog skipped preparation");
        current = false;
        held.release.resolve();
        expect(await settled).toMatchObject([
          { status: "rejected", reason: { message: "Dashboard dialog revoked" } },
        ]);
        expect(session.armObservedDialogResponseOnPage).not.toHaveBeenCalled();
        if (boundary === "page preparation") {
          expect(session.respondToObservedDialogOnPage).not.toHaveBeenCalled();
        }
      } finally {
        held.release.resolve();
        await settled;
      }
    },
  );
  it("last file-chooser arm wins", async () => {
    const firstPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-arm-1-${crypto.randomUUID()}.txt`);
    const secondPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-arm-2-${crypto.randomUUID()}.txt`);
    await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    await Promise.all([
      fs.writeFile(firstPath, "1", "utf8"),
      fs.writeFile(secondPath, "2", "utf8"),
    ]);
    const secondCanonicalPath = await fs.realpath(secondPath);

    const chooserEvents = new EventEmitter();
    const fileChooser = {
      setFiles: vi.fn(
        async (_paths: string[], _options: { timeout: number; signal: AbortSignal }) => {},
      ),
    };
    // Native event waiters reject on abort and remove their old chooser listener.
    const waitForEvent = vi.fn(async (_event: string, { signal }: { signal: AbortSignal }) => {
      const [chooser] = await once(chooserEvents, "filechooser", { signal });
      return chooser;
    });

    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    try {
      await mod.armFileUploadViaPlaywright({ ...target, paths: [firstPath] });
      await mod.armFileUploadViaPlaywright({ ...target, paths: [secondPath] });

      expect(waitForEvent).toHaveBeenCalledTimes(2);
      expect(waitForEvent.mock.calls[0]![1].signal.aborted).toBe(true);
      expect(chooserEvents.listenerCount("filechooser")).toBe(1);
      chooserEvents.emit("filechooser", fileChooser);
      await vi.waitFor(() => {
        expect(fileChooser.setFiles).toHaveBeenCalledExactlyOnceWith([secondCanonicalPath], {
          timeout: expect.any(Number),
          signal: expect.any(AbortSignal),
        });
      });
      const { timeout, signal } = fileChooser.setFiles.mock.calls[0]![1];
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(120_000);
      expect(signal.aborted).toBe(false);
      expect(chooserEvents.listenerCount("filechooser")).toBe(0);
    } finally {
      chooserEvents.emit("filechooser", fileChooser);
      await Promise.all([fs.rm(firstPath, { force: true }), fs.rm(secondPath, { force: true })]);
    }
  });
  it("arms the next dialog with the default timeout", async () => {
    const page = {};
    setPwToolsCoreCurrentPage(page);

    const response = { accept: true, promptText: "x" };
    await mod.armDialogViaPlaywright({ ...target, ...response });
    expect(session.respondToObservedDialogOnPage).toHaveBeenCalledWith({
      page,
      ...response,
      closedBy: "agent",
    });
    expect(session.armObservedDialogResponseOnPage).toHaveBeenCalledWith({
      page,
      ...response,
      timeoutMs: 120_000,
    });
  });
  it("waits for selector, url, load state, and function", async () => {
    const waitForSelector = vi.fn(async () => {});
    const waitForURL = vi.fn(async () => {});
    const waitForLoadState = vi.fn(async () => {});
    const waitForFunction = vi.fn(
      async (_predicate: unknown, _state: unknown, _options: unknown) => {},
    );
    const waitForTimeout = vi.fn(async () => {});
    const documentHandle = { dispose: vi.fn(async () => {}) };

    const page = {
      evaluateHandle: vi.fn(async () => documentHandle),
      locator: vi.fn(() => ({ first: () => ({ waitFor: waitForSelector }) })),
      waitForURL,
      waitForLoadState,
      waitForFunction,
      waitForTimeout,
    };
    setPwToolsCoreCurrentPage(page);

    await waitForViaPlaywright({
      ...target,
      selector: "#main",
      url: "**/dash",
      loadState: "networkidle",
      fn: "window.ready===true",
      timeoutMs: 1234,
      timeMs: 50,
    });

    expect(waitForTimeout).toHaveBeenCalledWith(50);
    expect(page.locator).toHaveBeenCalledWith("#main");
    expect(waitForSelector).toHaveBeenCalledWith({ state: "visible", timeout: 1234 });
    expect(waitForURL).toHaveBeenCalledWith("**/dash", { timeout: 1234 });
    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 1234 });
    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      { document: documentHandle },
      { timeout: 1234 },
    );
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("clamps passive wait deadlines without running an executable predicate", async () => {
    const waitFor = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({ locator: () => ({ first: () => ({ waitFor }) }) });
    await waitForViaPlaywright({ ...target, selector: "#main", timeoutMs: 999_999 });
    expect(waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 120_000 });
  });

  it("clamps interaction timeoutMs to 60000 for click steps", async () => {
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      url: vi.fn(() => "https://example.com"),
      locator: vi.fn(() => ({ click })),
    });

    await interactions.clickViaPlaywright({ ...target, selector: "#main", timeoutMs: 999_999 });

    expect(click).toHaveBeenCalledWith({ timeout: 60_000, signal: expect.any(AbortSignal) });
  });
});
