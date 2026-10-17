import { EventEmitter, once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

const pathMocks = vi.hoisted(() => ({
  resolveStrictExistingUploadPaths:
    vi.fn<
      (args: {
        requestedPaths: string[];
      }) => Promise<{ ok: true; paths: string[] } | { ok: false; error: string }>
    >(),
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
  const fileChooser = {
    setFiles: vi.fn<
      (paths: string[], options: { timeout?: number; signal: AbortSignal }) => Promise<void>
    >(async () => {}),
  };
  const events = new EventEmitter();
  const waitForEvent = vi.fn(
    async (_event: string, { signal }: { signal: AbortSignal }): Promise<typeof fileChooser> => {
      const [chooser] = await once(events, "filechooser", { signal });
      return chooser;
    },
  );
  const press = vi.fn(async () => {});
  const currentPage = { waitForEvent, keyboard: { press } };
  setPwToolsCoreCurrentPage(currentPage);
  return {
    currentPage,
    emitChooser: (observed = fileChooser) => {
      events.emit("filechooser", observed);
    },
    fileChooser,
    listenerCount: () => events.listenerCount("filechooser"),
    press,
  };
}

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const reportPath = "/home/user/.openclaw/media/inbound/report.pdf";
function upload(ref: string, options: Partial<Parameters<typeof uploadViaPlaywright>[0]> = {}) {
  return uploadViaPlaywright({ cdpUrl: target.cdpUrl, ref, paths: [reportPath], ...options });
}
function heldAuthority() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let current = true;
  return {
    entered,
    release,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    revoke: () => {
      current = false;
      release.resolve();
    },
    assertCurrent: async () => {
      if (!current) {
        throw new Error("Dashboard upload revoked");
      }
    },
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

  it("checks authority after upload page preparation", async () => {
    const page = createAtomicFileChooserPageMocks();
    const authority = heldAuthority();
    sessionMocks.getPageForTargetId.mockImplementationOnce(async () => {
      await authority.prepare();
      return page.currentPage;
    });
    interactionMocks.clickViaPlaywright.mockImplementationOnce(async () => page.emitChooser());
    const operation = upload("e1", {
      ...target,
      paths: ["/tmp/upload.txt"],
      assertCurrent: authority.assertCurrent,
    });
    const settled = Promise.allSettled([operation]);
    try {
      await Promise.race([
        authority.entered.promise,
        operation.then(() => {
          throw new Error("Upload skipped held preparation");
        }),
      ]);
      authority.revoke();
      expect(await settled).toMatchObject([
        { status: "rejected", reason: { message: "Dashboard upload revoked" } },
      ]);
      expect(interactionMocks.clickViaPlaywright).not.toHaveBeenCalled();
      expect(page.listenerCount()).toBe(0);
      expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
    } finally {
      authority.release.resolve();
      page.emitChooser();
      await settled;
    }
  });

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

  it("dismisses its acquired chooser when authority is revoked during atomic payload preparation", async () => {
    const page = createAtomicFileChooserPageMocks();
    const authority = heldAuthority();
    pathMocks.resolveStrictExistingUploadPaths.mockImplementationOnce(
      async ({ requestedPaths }) => {
        await authority.prepare();
        return { ok: true, paths: requestedPaths };
      },
    );
    interactionMocks.clickViaPlaywright.mockImplementationOnce(async () => page.emitChooser());
    const operation = upload("e1", {
      ...target,
      paths: ["/tmp/upload.txt"],
      assertCurrent: authority.assertCurrent,
    });
    const settled = Promise.allSettled([operation]);
    try {
      await Promise.race([
        authority.entered.promise,
        operation.then(() => {
          throw new Error("Upload skipped payload preparation");
        }),
      ]);
      authority.revoke();
      expect(await settled).toMatchObject([
        { status: "rejected", reason: { message: "Dashboard upload revoked" } },
      ]);
      expect(page.fileChooser.setFiles).not.toHaveBeenCalled();
      expect(page.press).toHaveBeenCalledExactlyOnceWith("Escape");
      expect(page.listenerCount()).toBe(0);
    } finally {
      authority.release.resolve();
      page.emitChooser();
      await settled;
    }
  });

  it("propagates strict path revalidation failures", async () => {
    pathMocks.resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: false,
      error: "Invalid path: upload target changed",
    });
    const page = createAtomicFileChooserPageMocks();
    interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());

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
      interactionMocks.clickViaPlaywright.mockImplementation(async () => page.emitChooser());
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
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(async () => page.emitChooser())
      .mockImplementationOnce(async () => page.emitChooser());

    const first = upload("e1", {
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    const firstRejection = expect(first).rejects.toThrow("superseded by another waiter");
    await vi.waitFor(() => expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1));

    const secondController = new AbortController();
    const second = upload("e2", {
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    secondController.abort(new Error("queued upload aborted"));
    await expect(second).rejects.toThrow("queued upload aborted");

    const third = upload("e3", {
      paths: ["/home/user/.openclaw/media/inbound/third.pdf"],
    });
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
    let finishFirstClick!: () => void;
    interactionMocks.clickViaPlaywright
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((resolve) => {
            finishFirstClick = () => {
              page.emitChooser();
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => page.emitChooser());

    const first = upload("e1", {
      paths: ["/home/user/.openclaw/media/inbound/first.pdf"],
    });
    await vi.waitFor(() => expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1));
    const second = upload("e2", {
      paths: ["/home/user/.openclaw/media/inbound/second.pdf"],
    });
    await Promise.resolve();
    expect(interactionMocks.clickViaPlaywright).toHaveBeenCalledTimes(1);

    finishFirstClick();
    await expect(first).rejects.toThrow("superseded by another waiter");
    await second;
    expect(page.fileChooser.setFiles).toHaveBeenCalledTimes(1);
    expect(page.press).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });
});
