import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as pwSessionConnection from "./pw-session-connection.js";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreDownloadCapture,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };
const session = getPwToolsCoreSessionMocks();
const guard = getPwToolsCoreNavigationGuardMocks();
const permissive = { allowPrivateNetwork: true };
function navigate(options: Omit<Parameters<typeof mod.navigateViaPlaywright>[0], "cdpUrl">) {
  return mod.navigateViaPlaywright({ cdpUrl: target.cdpUrl, ...options });
}
function attachment(url = "https://example.com/export.csv", source = "https://example.com/start") {
  const download = {
    url,
    suggestedFilename: "export.csv",
    path: "/tmp/openclaw/downloads/export.csv",
  };
  const capture = { armed: true, promise: Promise.resolve(download), cancel: vi.fn() };
  setPwToolsCoreDownloadCapture(capture);
  const page = {
    goto: vi.fn(async () => {
      throw new Error("page.goto: Download is starting");
    }),
    url: vi.fn(() => source),
  };
  setPwToolsCoreCurrentPage(page);
  return { download, capture, page };
}

function prepareReconnect() {
  const owner: { targetId?: string } = { targetId: "original-target" };
  const originalPage = {
    goto: vi.fn(async () => {
      owner.targetId = undefined;
      throw new Error("page.goto: Frame has been detached");
    }),
    url: vi.fn(() => "https://example.com/original"),
    on: vi.fn(),
    off: vi.fn(),
  };
  const replacementPage = {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.com/recovered"),
    on: vi.fn(),
    off: vi.fn(),
  };
  setPwToolsCoreCurrentPage(originalPage);
  const reconnect = vi.spyOn(pwSessionConnection, "connectBrowser").mockImplementation(async () => {
    owner.targetId = "replacement-target";
    return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
  });
  const retry = () =>
    navigate({
      targetId: "original-target",
      url: "https://example.com/recovered",
      resolveOperationTarget: () => owner.targetId,
    });
  return { owner, originalPage, replacementPage, reconnect, retry };
}

describe("pw-tools-core.snapshot navigate guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "about:blank"),
    });

    await expect(navigate({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );

    expect(session.getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("returns managed download metadata when navigation starts an attachment download", async () => {
    const { download, capture } = attachment();

    const result = await navigate({
      ...target,
      url: "https://example.com/export.csv",
      ssrfPolicy: permissive,
    });

    expect(result).toEqual({ url: download.url, download });
    expect(capture.cancel).not.toHaveBeenCalled();
    expect(session.assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
    expect(guard.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: download.url,
      ssrfPolicy: permissive,
    });
  });

  it("handles capture timeouts that win before ordinary navigation settles", async () => {
    let rejectCapture!: (err: Error) => void;
    const downloadCapture = {
      armed: true,
      promise: new Promise<never>((_, reject) => {
        rejectCapture = reject;
      }),
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage({
      goto: vi.fn(async () => {
        rejectCapture(new Error("Timeout waiting for navigation download"));
        await Promise.resolve();
      }),
      url: vi.fn(() => "https://example.com/final"),
    });

    const result = await navigate({
      url: "https://example.com/final",
      ssrfPolicy: permissive,
    });

    expect(result).toEqual({ url: "https://example.com/final" });
    expect(downloadCapture.cancel).toHaveBeenCalledTimes(1);
  });

  it("closes the tab when captured navigation download resolves to a blocked URL", async () => {
    const { page } = attachment("http://127.0.0.1:18080/export.csv", "https://93.184.216.34/start");
    guard.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      navigate({
        ...target,
        url: "https://93.184.216.34/export.csv",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(session.closeBlockedNavigationTarget).toHaveBeenCalledWith({ ...target, page });
  });

  it("reconnects and retries once when navigation detaches frame", async () => {
    const goto = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("page.goto: Frame has been detached"))
      .mockResolvedValueOnce(undefined);
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/recovered"),
    });

    const result = await navigate({
      ...target,
      url: "https://example.com/recovered",
      ssrfPolicy: permissive,
    });

    expect(session.getPageForTargetId).toHaveBeenCalledTimes(2);
    expect(session.forceDisconnectPlaywrightForTarget).toHaveBeenCalledTimes(1);
    expect(session.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      ...target,
      ssrfPolicy: permissive,
      page: expect.objectContaining({ goto }),
    });
    expect(session.gotoPageWithNavigationGuard).toHaveBeenCalledTimes(2);
    expect(result.url).toBe("https://example.com/recovered");
  });

  it("rebinds a detached navigation to the same relay-owned tab after reconnect", async () => {
    const { originalPage, replacementPage, reconnect, retry } = prepareReconnect();
    session.getPageForTargetId
      .mockResolvedValueOnce(originalPage)
      .mockImplementationOnce(async () => {
        const selected = (
          session.getPageForTargetId.mock.calls.at(-1) as unknown[] | undefined
        )?.[0] as { targetId?: string } | undefined;
        if (selected?.targetId !== "replacement-target") {
          throw new BrowserTabNotFoundError({ input: selected?.targetId });
        }
        return replacementPage;
      });

    try {
      const result = await retry();

      expect(reconnect).toHaveBeenCalledWith("http://127.0.0.1:18792", undefined, undefined);
      expect(session.getPageForTargetId).toHaveBeenLastCalledWith(
        expect.objectContaining({ targetId: "replacement-target" }),
      );
      expect(replacementPage.goto).toHaveBeenCalledTimes(1);
      expect(session.gotoPageWithNavigationGuard).toHaveBeenLastCalledWith(
        expect.objectContaining({
          targetId: "replacement-target",
          assertPageCurrent: expect.any(Function),
        }),
      );
      expect(session.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "replacement-target" }),
      );
      expect(result.url).toBe("https://example.com/recovered");
    } finally {
      reconnect.mockRestore();
    }
  });

  it.each([
    { reason: "owner is revoked before selection", revokeDuringLookup: false },
    { reason: "owner changes during the exact page lookup", revokeDuringLookup: true },
  ])("rejects detached navigation when its $reason", async ({ revokeDuringLookup }) => {
    const { owner, originalPage, replacementPage, reconnect, retry } = prepareReconnect();
    reconnect.mockImplementation(async () => {
      owner.targetId = revokeDuringLookup ? "replacement-target" : undefined;
      return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
    });
    session.getPageForTargetId.mockResolvedValueOnce(originalPage);
    if (revokeDuringLookup) {
      session.getPageForTargetId.mockImplementationOnce(async () => {
        owner.targetId = "unrelated-target";
        return replacementPage;
      });
    }

    try {
      await expect(retry()).rejects.toBeInstanceOf(BrowserTabNotFoundError);

      expect(replacementPage.goto).not.toHaveBeenCalled();
      expect(session.getPageForTargetId).toHaveBeenCalledTimes(revokeDuringLookup ? 2 : 1);
    } finally {
      reconnect.mockRestore();
    }
  });

  it("closes the replacement relay target when its retried navigation violates policy", async () => {
    const { originalPage, replacementPage, reconnect, retry } = prepareReconnect();
    session.getPageForTargetId
      .mockResolvedValueOnce(originalPage)
      .mockResolvedValueOnce(replacementPage);
    session.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new SsrFBlockedError("blocked replacement navigation"),
    );

    try {
      await expect(retry()).rejects.toBeInstanceOf(SsrFBlockedError);

      expect(session.closeBlockedNavigationTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page: replacementPage,
        targetId: "replacement-target",
      });
    } finally {
      reconnect.mockRestore();
    }
  });

  it("does not close the tab when post-navigation rejection is not a policy deny", async () => {
    const goto = vi.fn(async () => ({ request: () => undefined }));
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/final"),
    });
    session.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error("transient playwright error"),
    );

    await expect(navigate({ url: "https://example.com/final" })).rejects.toThrow(
      "transient playwright error",
    );

    expect(session.closeBlockedNavigationTarget).not.toHaveBeenCalled();
  });
});
