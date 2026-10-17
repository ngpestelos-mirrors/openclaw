import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import * as pwSessionConnection from "./pw-session-connection.js";
import { managedDownload } from "./pw-tools-core.guard-test-support.js";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreDownloadCapture,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((key) => [
  key,
  key.toLowerCase(),
]);

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };
const session = getPwToolsCoreSessionMocks();
const guard = getPwToolsCoreNavigationGuardMocks();
const permissive = { allowPrivateNetwork: true };
const permissiveTarget = { ...target, ssrfPolicy: permissive };
const recoveredUrl = "https://example.com/recovered";
function navigate(options: Omit<Parameters<typeof mod.navigateViaPlaywright>[0], "cdpUrl">) {
  return mod.navigateViaPlaywright({ cdpUrl: target.cdpUrl, ...options });
}
function pageAt<T>(url: string, goto: T) {
  return { url: vi.fn(() => url), goto };
}
function attachment(url = "https://example.com/export.csv", source = "https://example.com/start") {
  const download = { ...managedDownload("export.csv"), url };
  const capture = { armed: true, promise: Promise.resolve(download), cancel: vi.fn() };
  setPwToolsCoreDownloadCapture(capture);
  const page = pageAt(
    source,
    vi.fn(async () => {
      throw new Error("page.goto: Download is starting");
    }),
  );
  setPwToolsCoreCurrentPage(page);
  return { download, capture, page };
}

function prepareReconnect() {
  const owner: { targetId?: string } = { targetId: "original-target" };
  const originalPage = pageAt(
    "https://example.com/original",
    vi.fn(async () => {
      owner.targetId = undefined;
      throw new Error("page.goto: Frame has been detached");
    }),
  );
  const replacementPage = pageAt(
    recoveredUrl,
    vi.fn(async () => {}),
  );
  session.getPageForTargetId.mockResolvedValueOnce(originalPage);
  setPwToolsCoreCurrentPage(originalPage);
  const reconnect = vi.spyOn(pwSessionConnection, "connectBrowser").mockImplementation(async () => {
    owner.targetId = "replacement-target";
    return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
  });
  const retry = () =>
    navigate({
      targetId: "original-target",
      url: recoveredUrl,
      resolveOperationTarget: () => owner.targetId,
    });
  return { owner, replacementPage, reconnect, retry };
}

describe("pw-tools-core.snapshot navigate guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage(pageAt("about:blank", goto));

    await expect(navigate({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );

    expect(session.getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("returns managed download metadata when navigation starts an attachment download", async () => {
    const { download, capture } = attachment();

    const result = await navigate({ ...permissiveTarget, url: "https://example.com/export.csv" });

    expect(result).toEqual({ url: download.url, download });
    expect(capture.cancel).not.toHaveBeenCalled();
    expect(session.assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
    expect(guard.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: download.url,
      ssrfPolicy: permissive,
    });
  });

  it("handles capture timeouts that win before ordinary navigation settles", async () => {
    const capture = Promise.withResolvers<never>();
    const downloadCapture = {
      armed: true,
      promise: capture.promise,
      cancel: vi.fn(),
    };
    setPwToolsCoreDownloadCapture(downloadCapture);
    setPwToolsCoreCurrentPage(
      pageAt(
        "https://example.com/final",
        vi.fn(async () => {
          capture.reject(new Error("Timeout waiting for navigation download"));
          await Promise.resolve();
        }),
      ),
    );

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
    setPwToolsCoreCurrentPage(pageAt(recoveredUrl, goto));

    const result = await navigate({ ...permissiveTarget, url: recoveredUrl });

    expect(session.getPageForTargetId).toHaveBeenCalledTimes(2);
    expect(session.forceDisconnectPlaywrightForTarget).toHaveBeenCalledTimes(1);
    expect(session.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      ...target,
      ssrfPolicy: permissive,
      page: expect.objectContaining({ goto }),
    });
    expect(session.gotoPageWithNavigationGuard).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(recoveredUrl);
  });

  it("rebinds a detached navigation to the same relay-owned tab after reconnect", async () => {
    const { replacementPage, reconnect, retry } = prepareReconnect();
    session.getPageForTargetId.mockResolvedValueOnce(replacementPage);

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
    expect(result.url).toBe(recoveredUrl);
  });

  it.each([
    { reason: "owner is revoked before selection", revokeDuringLookup: false },
    { reason: "owner changes during the exact page lookup", revokeDuringLookup: true },
  ])("rejects detached navigation when its $reason", async ({ revokeDuringLookup }) => {
    const { owner, replacementPage, reconnect, retry } = prepareReconnect();
    reconnect.mockImplementation(async () => {
      owner.targetId = revokeDuringLookup ? "replacement-target" : undefined;
      return {} as Awaited<ReturnType<typeof pwSessionConnection.connectBrowser>>;
    });
    if (revokeDuringLookup) {
      session.getPageForTargetId.mockImplementationOnce(async () => {
        owner.targetId = "unrelated-target";
        return replacementPage;
      });
    }

    await expect(retry()).rejects.toBeInstanceOf(BrowserTabNotFoundError);

    expect(replacementPage.goto).not.toHaveBeenCalled();
    expect(session.getPageForTargetId).toHaveBeenCalledTimes(revokeDuringLookup ? 2 : 1);
  });

  it("closes the replacement relay target when its retried navigation violates policy", async () => {
    const { replacementPage, retry } = prepareReconnect();
    session.getPageForTargetId.mockResolvedValueOnce(replacementPage);
    session.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new SsrFBlockedError("blocked replacement navigation"),
    );

    await expect(retry()).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(session.closeBlockedNavigationTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page: replacementPage,
      targetId: "replacement-target",
    });
  });

  it("does not close the tab when post-navigation rejection is not a policy deny", async () => {
    setPwToolsCoreCurrentPage(
      pageAt(
        "https://example.com/final",
        vi.fn(async () => {}),
      ),
    );
    session.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error("transient playwright error"),
    );

    await expect(navigate({ url: "https://example.com/final" })).rejects.toThrow(
      "transient playwright error",
    );

    expect(session.closeBlockedNavigationTarget).not.toHaveBeenCalled();
  });
});
