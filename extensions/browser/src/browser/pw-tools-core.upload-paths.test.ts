import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitStarted, fileChooserPage, heldAction } from "./pw-tools-core.guard-test-support.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

const pathMocks = vi.hoisted(() => ({
  resolveStrictExistingUploadPaths:
    vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>(),
}));

const interactionMocks = vi.hoisted(() => ({
  clickViaPlaywright: vi.fn<(opts: { signal?: AbortSignal }) => Promise<void>>(async () => {}),
}));

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return {
    ...actual,
    resolveStrictExistingUploadPaths: pathMocks.resolveStrictExistingUploadPaths,
  };
});

vi.mock("./pw-tools-core.interactions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-tools-core.interactions.js")>()),
  ...interactionMocks,
}));

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const { armFileUploadViaPlaywright, uploadViaPlaywright } =
  await import("./pw-tools-core.downloads.js");

function nativeAbortError(signal: AbortSignal) {
  return Object.assign(new Error("Operation aborted", { cause: signal.reason }), {
    name: "AbortError",
  });
}

function createAtomicFileChooserPageMocks() {
  const page = fileChooserPage();
  interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());
  setPwToolsCoreCurrentPage(page.currentPage);
  return page;
}

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const reportPath = "/home/user/.openclaw/media/inbound/report.pdf";
function upload(ref: string, options: Partial<Parameters<typeof uploadViaPlaywright>[0]> = {}) {
  return uploadViaPlaywright({ cdpUrl: target.cdpUrl, ref, paths: [reportPath], ...options });
}
function heldAuthority() {
  const held = heldAction();
  const authority = new AbortController();
  return {
    ...held,
    revoke: () => {
      authority.abort(new Error("Dashboard upload revoked"));
      held.resolve();
    },
    assertCurrent: async () => authority.signal.throwIfAborted(),
  };
}

describe("armFileUploadViaPlaywright upload path validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interactionMocks.clickViaPlaywright.mockReset().mockResolvedValue(undefined);
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: [reportPath],
    });
  });

  it.each(["page", "payload"] as const)(
    "checks upload authority after %s preparation",
    async (stage) => {
      const page = createAtomicFileChooserPageMocks();
      const authority = heldAuthority();
      if (stage === "page") {
        sessionMocks.getPageForTargetId.mockImplementationOnce(async () => {
          await authority.run();
          return page.currentPage;
        });
      } else {
        pathMocks.resolveStrictExistingUploadPaths.mockImplementationOnce(
          async ({ requestedPaths }) => {
            await authority.run();
            return { ok: true, paths: requestedPaths };
          },
        );
      }
      const operation = upload("e1", {
        ...target,
        paths: ["/tmp/upload.txt"],
        assertCurrent: authority.assertCurrent,
      });
      const settled = Promise.allSettled([operation]);
      try {
        await awaitStarted(authority.started, operation);
        authority.revoke();
        expect(await settled).toMatchObject([
          { status: "rejected", reason: { message: "Dashboard upload revoked" } },
        ]);
        if (stage === "page") {
          expect(interactionMocks.clickViaPlaywright).not.toHaveBeenCalled();
        } else {
          expect(page.press).toHaveBeenCalledExactlyOnceWith("Escape");
        }
        expect(page.listenerCount()).toBe(0);
        expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
      } finally {
        authority.resolve();
        page.emitChooser();
        await settled;
      }
    },
  );

  it("keeps an accepted passive upload arm alive after its requesting invocation ends", async () => {
    const page = createAtomicFileChooserPageMocks();
    const invocation = new AbortController();
    const assertCurrent = vi.fn(async () => invocation.signal.throwIfAborted());
    try {
      await armFileUploadViaPlaywright({
        ...target,
        paths: ["/tmp/upload.txt"],
        assertCurrent,
      });
      invocation.abort(new Error("requesting invocation ended"));
      page.emitChooser();
      await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledOnce());
      expect(page.listenerCount()).toBe(0);
    } finally {
      page.emitChooser();
    }
  });

  it("propagates strict path revalidation failures", async () => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: false,
      error: "Invalid path: upload target changed",
    });
    const page = createAtomicFileChooserPageMocks();

    await expect(upload("e12")).rejects.toThrow("Invalid path: upload target changed");
    expect(page.press).not.toHaveBeenCalled();
    expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });

  it("bounds file assignment by the same request deadline", async () => {
    vi.useFakeTimers();
    try {
      const page = createAtomicFileChooserPageMocks();
      page.fileChooser.setFiles.mockImplementation(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(nativeAbortError(options.signal)),
              { once: true },
            );
          }),
      );
      const operation = upload("e12", { timeoutMs: 500 });
      const rejection = expect(operation).rejects.toThrow(
        "Timeout 500ms exceeded while completing file upload",
      );

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(page.press).not.toHaveBeenCalled();
      expect(page.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the cleanup tail when a queued owner aborts", async () => {
    const page = createAtomicFileChooserPageMocks();
    let firstSignal: AbortSignal | undefined;
    let finishCancellation!: () => void;
    page.fileChooser.setFiles
      .mockImplementationOnce(
        async (_paths, options) =>
          await new Promise<void>((_resolve, reject) => {
            firstSignal = options.signal;
            finishCancellation = () => reject(nativeAbortError(options.signal));
          }),
      )
      .mockResolvedValueOnce(undefined);
    const first = upload("e1");
    const firstRejection = expect(first).rejects.toThrow("superseded by another waiter");
    await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1));

    const secondController = new AbortController();
    const second = upload("e2", {
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    secondController.abort(new Error("queued upload aborted"));
    await expect(second).rejects.toThrow("queued upload aborted");

    const third = upload("e3");
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    finishCancellation();
    await firstRejection;
    await third;
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(2);
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(2);
    expect(page.listenerCount()).toBe(0);
  });

  it("waits for a superseded click to settle before arming the next chooser", async () => {
    const page = createAtomicFileChooserPageMocks();
    const firstClick = createDeferred<void>();
    interactionMocks.clickViaPlaywright.mockImplementationOnce(async () => {
      await firstClick.promise;
      page.emitChooser();
    });

    const first = upload("e1");
    await vi.waitFor(() => expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1));
    const second = upload("e2");
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    firstClick.resolve();
    await expect(first).rejects.toThrow("superseded by another waiter");
    await second;
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(page.press).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });
});
