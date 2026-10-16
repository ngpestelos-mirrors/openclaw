import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return { ...actual, fetchWithSsrFGuard: mocks.fetchWithSsrFGuard };
});

import { runGitHubCopilotDeviceFlow } from "./login.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const VALID_DEVICE_CODE_BODY = {
  device_code: "dev-code-abc123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function guardResponse(body: unknown, status = 200, url = DEVICE_CODE_URL) {
  return {
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    finalUrl: url,
    release: vi.fn(async () => {}),
  };
}

function mockPoll(body: unknown) {
  mocks.fetchWithSsrFGuard
    .mockResolvedValueOnce(guardResponse(VALID_DEVICE_CODE_BODY))
    .mockResolvedValueOnce(guardResponse(body, 200, ACCESS_TOKEN_URL));
}

afterEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function runDeviceFlowAfterFirstPoll(
  io: Parameters<typeof runGitHubCopilotDeviceFlow>[0] = { showCode: vi.fn(async () => {}) },
  domain?: string,
) {
  vi.useFakeTimers();
  const result = runGitHubCopilotDeviceFlow(io, domain);
  return Promise.all([result, vi.advanceTimersByTimeAsync(5_000)]).then(
    ([flowResult]) => flowResult,
  );
}

describe("runGitHubCopilotDeviceFlow — normal flow", () => {
  it("bounds requests and returns authorized status and access token on successful flow", async () => {
    let callIdx = 0;
    const requestTimeouts: Array<number | undefined> = [];
    const controller = new AbortController();
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      callIdx += 1;
      requestTimeouts.push(params.timeoutMs);
      expect(params.signal).toBe(controller.signal);
      if (callIdx === 1) {
        expect(params.url).toBe(DEVICE_CODE_URL);
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }
      expect(params.url).toBe(ACCESS_TOKEN_URL);
      return guardResponse(
        { access_token: "ghu_tok_xyz", token_type: "bearer" },
        200,
        ACCESS_TOKEN_URL,
      );
    });

    const showCode = vi.fn(async () => {});
    const result = await runDeviceFlowAfterFirstPoll({ showCode, signal: controller.signal });

    expect(result).toEqual({ status: "authorized", accessToken: "ghu_tok_xyz" });
    expect(showCode).toHaveBeenCalledWith({
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInMs: expect.any(Number),
    });
    expect(callIdx).toBe(2);
    expect(requestTimeouts).toEqual([30_000, 30_000]);
  });

  it("returns access_denied when GitHub rejects the authorization", async () => {
    mockPoll({ error: "access_denied" });
    const result = await runDeviceFlowAfterFirstPoll();
    expect(result).toEqual({ status: "access_denied" });
  });

  it("returns expired when GitHub reports expired_token", async () => {
    mockPoll({ error: "expired_token" });
    const result = await runDeviceFlowAfterFirstPoll();
    expect(result).toEqual({ status: "expired" });
  });
});

describe("runGitHubCopilotDeviceFlow — live authority", () => {
  it("does not dispatch the initial request after authority is revoked", async () => {
    const dispatch = vi.fn();
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      params.beforeRequest?.();
      dispatch();
      throw new Error("Request dispatched after authority was revoked");
    });

    await expect(
      runGitHubCopilotDeviceFlow({
        showCode: vi.fn(),
        assertCurrent: () => {
          throw new Error("Login revoked");
        },
      }),
    ).rejects.toThrow("Login revoked");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not poll after authority is revoked while presenting the device code", async () => {
    vi.useFakeTimers();
    let current = true;
    let tokenPolls = 0;
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      params.beforeRequest?.();
      if (params.url === DEVICE_CODE_URL) {
        return guardResponse({ ...VALID_DEVICE_CODE_BODY, interval: 0 });
      }
      tokenPolls += 1;
      return guardResponse(
        { access_token: "ghu_tok_xyz", token_type: "bearer" },
        200,
        ACCESS_TOKEN_URL,
      );
    });

    const rejection = expect(
      runGitHubCopilotDeviceFlow({
        showCode: async () => {
          current = false;
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Login revoked");
          }
        },
      }),
    ).rejects.toThrow("Login revoked");
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(tokenPolls).toBe(0);
  });

  it("does not issue another poll after a pending response loses authority", async () => {
    vi.useFakeTimers();
    let current = true;
    let tokenPolls = 0;
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      params.beforeRequest?.();
      if (params.url === DEVICE_CODE_URL) {
        return guardResponse({ ...VALID_DEVICE_CODE_BODY, interval: 1 });
      }
      tokenPolls += 1;
      if (tokenPolls === 1) {
        current = false;
        return guardResponse({ error: "authorization_pending" }, 200, ACCESS_TOKEN_URL);
      }
      return guardResponse(
        { access_token: "ghu_tok_xyz", token_type: "bearer" },
        200,
        ACCESS_TOKEN_URL,
      );
    });

    const rejection = expect(
      runGitHubCopilotDeviceFlow({
        showCode: vi.fn(async () => {}),
        assertCurrent: () => {
          if (!current) {
            throw new Error("Login revoked");
          }
        },
      }),
    ).rejects.toThrow("Login revoked");
    await vi.advanceTimersByTimeAsync(2_000);

    await rejection;
    expect(tokenPolls).toBe(1);
  });
});

describe("runGitHubCopilotDeviceFlow — HTTP error propagation", () => {
  it("cancels the unread device token body before throwing on non-OK", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: "server_error" })));
      },
      cancel() {
        canceled = true;
      },
    });
    mocks.fetchWithSsrFGuard
      .mockResolvedValueOnce(guardResponse(VALID_DEVICE_CODE_BODY))
      .mockResolvedValueOnce({
        response: new Response(body, {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
        finalUrl: ACCESS_TOKEN_URL,
        release: vi.fn(async () => {}),
      });

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow(
      "GitHub device token failed: HTTP 401",
    );
    expect(canceled).toBe(true);
  });

  it("rejects a malformed access token response", async () => {
    mockPoll({ access_token: null, token_type: "bearer" });

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow(
      "GitHub device flow returned an invalid access token",
    );
  });
});

describe("postGitHubDeviceFlowForm — response size bound", () => {
  it("bounds oversized access token bodies and cancels the stream", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let readCount = 0;
    let canceled = false;
    // Stop well before consuming the 64 MiB source body.
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= 64) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    mocks.fetchWithSsrFGuard
      .mockResolvedValueOnce(guardResponse(VALID_DEVICE_CODE_BODY))
      .mockResolvedValueOnce({
        response: new Response(oversizedBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        finalUrl: ACCESS_TOKEN_URL,
        release: async () => {},
      });

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow("github-copilot.device-flow");
    expect(readCount).toBeLessThan(64);
    expect(canceled).toBe(true);
  });
});

describe("runGitHubCopilotDeviceFlow — data-residency GitHub Enterprise", () => {
  const GHE_DOMAIN = "acme.ghe.com";

  it("rejects a verification URL whose host does not match the configured domain", async () => {
    mocks.fetchWithSsrFGuard.mockImplementation(async () =>
      guardResponse(
        { ...VALID_DEVICE_CODE_BODY, verification_uri: "https://github.com/login/device" },
        200,
        `https://${GHE_DOMAIN}/login/device/code`,
      ),
    );

    await expect(
      runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) }, GHE_DOMAIN),
    ).rejects.toThrow("unexpected verification URL");
  });
});

describe("runGitHubCopilotDeviceFlow — polling intervals", () => {
  it("waits before the first poll and keeps cumulative slow_down increases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00Z"));
    const startedAt = Date.now();
    const pollTimes: number[] = [];
    const pollResponses = [
      { error: "authorization_pending" },
      { error: "slow_down", interval: 7 },
      { error: "slow_down" },
      { access_token: "test-access-token", token_type: "bearer" },
    ];
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      if (params.url === DEVICE_CODE_URL) {
        const { interval: _interval, ...withoutInterval } = VALID_DEVICE_CODE_BODY;
        return guardResponse(withoutInterval);
      }
      pollTimes.push(Date.now());
      return guardResponse(pollResponses.shift(), 200, ACCESS_TOKEN_URL);
    });

    const result = runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(pollTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toEqual([startedAt + 5_000]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollTimes).toEqual([startedAt + 5_000, startedAt + 10_000]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollTimes).toEqual([startedAt + 5_000, startedAt + 10_000, startedAt + 20_000]);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
    expect(pollTimes).toEqual([
      startedAt + 5_000,
      startedAt + 10_000,
      startedAt + 20_000,
      startedAt + 35_000,
    ]);
  });

  it("uses the interval returned with slow_down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00Z"));
    const startedAt = Date.now();
    const pollTimes: number[] = [];
    const pollResponses = [
      { error: "slow_down", interval: 7 },
      { access_token: "test-access-token", token_type: "bearer" },
    ];
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      if (params.url === DEVICE_CODE_URL) {
        return guardResponse({ ...VALID_DEVICE_CODE_BODY, interval: 2 });
      }
      pollTimes.push(Date.now());
      return guardResponse(pollResponses.shift(), 200, ACCESS_TOKEN_URL);
    });

    const result = runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(pollTimes).toEqual([startedAt + 2_000]);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(pollTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
    expect(pollTimes).toEqual([startedAt + 2_000, startedAt + 9_000]);
  });
});
