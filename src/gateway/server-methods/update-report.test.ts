import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";

const mocks = vi.hoisted(() => ({
  refreshLatest: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
  prepare: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("../../../packages/gateway-protocol/src/index.js", async (original) => ({
  ...(await original<typeof import("../../../packages/gateway-protocol/src/index.js")>()),
  validateUpdateReportParams: () => true,
  validateUpdateReportResult: () => true,
}));

vi.mock("../../infra/update-failure-report.js", () => ({
  prepareUpdateFailureReport: mocks.prepare,
  submitUpdateFailureReport: mocks.submit,
}));

vi.mock("../server-update-sentinel.js", async (original) => ({
  ...(await original<typeof import("../server-update-sentinel.js")>()),
  refreshLatestUpdateRestartSentinel: mocks.refreshLatest,
}));

const { updateHandlers } = await import("./update.js");

const failure: RestartSentinelPayload = {
  kind: "update",
  status: "error",
  ts: 500,
  stats: {
    handoffId: "handoff-failed",
    mode: "git",
    target: "origin/main@abcdef",
    reason: "build-failed",
    steps: [
      {
        name: "build",
        command: "pnpm build --token secret",
        cwd: "/Users/private/openclaw",
        log: { exitCode: 1, stderrTail: "raw log secret" },
      },
      { name: "post-install doctor", advisory: true, log: { exitCode: 86 } },
    ],
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
  },
};

const preparedReport = {
  attemptId: "handoff-failed",
  body: "sanitized body",
  previewDigest: "a".repeat(64),
  savedReportPath: "/tmp/report.md",
  title: "Update failure",
  url: "https://github.com/openclaw/openclaw/issues/new",
};
const previewParams = { action: "preview", attemptId: "handoff-failed" };
const submitParams = {
  ...previewParams,
  action: "submit",
  previewDigest: preparedReport.previewDigest,
};

function expectInvalid(respond: unknown, message?: string) {
  const error = {
    code: "INVALID_REQUEST",
    ...(message ? { message: expect.stringContaining(message) } : {}),
  };
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

async function invoke(
  params: Record<string, unknown>,
  hasCurrentClientAuthority: (() => boolean) | null = () => true,
) {
  const respond = vi.fn();
  const handler = updateHandlers["update.report"];
  if (!handler) {
    throw new Error("update.report handler is unavailable");
  }
  await handler({
    ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
    client: { internal: { operatorRoleActor: { kind: "system" } } },
    context: createDirectChatContext(),
    params,
    respond,
  } as never);
  return respond;
}

describe("update.report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshLatest.mockResolvedValue(failure);
    mocks.prepare.mockResolvedValue(preparedReport);
  });

  it.each([
    { name: "legacy handoff", runId: undefined, attemptId: "handoff-failed" },
    {
      name: "canonical run",
      runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
  ])(
    "previews a current $name failure with redaction and advisory classification",
    async ({ runId, attemptId }) => {
      mocks.refreshLatest.mockResolvedValue({
        ...failure,
        stats: { ...failure.stats, ...(runId ? { runId } : {}) },
      });
      const respond = await invoke({ action: "preview", attemptId });

      expect(mocks.prepare).toHaveBeenCalledOnce();
      const input = mocks.prepare.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        attemptId,
        target: "origin/main@abcdef",
        result: {
          status: "error",
          mode: "git",
          recovery: { serviceRestartSafe: true, version: "2026.8.1" },
          steps: [
            { name: "build", command: "", cwd: "", exitCode: 1 },
            { name: "post-install doctor", advisory: { kind: "package-post-install-doctor" } },
          ],
        },
      });
      expect(JSON.stringify(input)).not.toContain("secret");
      expect(JSON.stringify(input)).not.toContain("/Users/private");
      expect(input.result.steps[0]).not.toHaveProperty("advisory");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "ready", previewDigest: "a".repeat(64) }),
      );
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("savedReportPath");
    },
  );

  it("preserves advisory classification when projecting persisted update steps", async () => {
    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      stats: {
        ...failure.stats,
        steps: [
          ...(failure.stats?.steps ?? []),
          {
            name: "post-install doctor",
            command: "openclaw doctor",
            durationMs: 5,
            advisory: true,
            log: { exitCode: 86 },
          },
        ],
      },
    });

    await invoke({ action: "preview", attemptId: "handoff-failed" });

    const projected = mocks.prepare.mock.calls[0]?.[0];
    expect(projected).toMatchObject({
      result: {
        steps: [
          { name: "build" },
          {
            name: "post-install doctor",
            advisory: { kind: "package-post-install-doctor" },
          },
        ],
      },
    });
    expect(projected.result.steps[0]).not.toHaveProperty("advisory");
  });

  it("submits only the reviewed digest for the same current attempt", async () => {
    const respond = await invoke({
      action: "submit",
      attemptId: "handoff-failed",
      previewDigest: "a".repeat(64),
    });

    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "handoff-failed" }),
      "a".repeat(64),
      expect.objectContaining({
        hasCurrentAuthority: expect.any(Function),
        validateCurrentAttempt: expect.any(Function),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ status: "created" }));
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("savedReportPath");
  });

  it("rechecks the attempt after preparation and refuses a replacement before submission", async () => {
    mocks.refreshLatest.mockResolvedValueOnce(failure).mockResolvedValueOnce({
      ...failure,
      stats: { ...failure.stats, handoffId: "replacement-attempt" },
    });

    const respond = await invoke({
      action: "submit",
      attemptId: "handoff-failed",
      previewDigest: "a".repeat(64),
    });

    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("stale"),
      }),
    );
  });

  it("refuses submission when client authority closes during report preparation", async () => {
    let authorityCurrent = true;
    mocks.prepare.mockImplementation(async () => {
      authorityCurrent = false;
      return preparedReport;
    });

    const respond = await invoke(submitParams, () => authorityCurrent);

    expect(mocks.submit).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("refuses submission without a live authenticated-client guard", async () => {
    const respond = await invoke(submitParams, null);

    expect(mocks.submit).not.toHaveBeenCalled();
    expectInvalid(respond, "authenticated client");
  });

  it.each([
    { status: "ok", reason: "build-failed", ready: false },
    { status: "skipped", reason: "already-current", ready: false },
    { status: "skipped", reason: "not-git-install", ready: true },
  ] as const)("classifies $status/$reason for reporting", async ({ status, reason, ready }) => {
    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      status,
      stats: { ...failure.stats, reason },
    });
    const respond = await invoke(previewParams);
    expect(mocks.prepare).toHaveBeenCalledTimes(ready ? 1 : 0);
    if (ready) {
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ status: "ready" }));
    } else {
      expectInvalid(respond);
    }
  });

  it("uses the canonical sentinel instead of a stale cached attempt", async () => {
    mocks.getLatest.mockReturnValue(failure);
    mocks.refreshLatest.mockResolvedValue({
      ...failure,
      stats: { ...failure.stats, handoffId: "canonical-replacement" },
    });

    const respond = await invoke({ action: "preview", attemptId: "handoff-failed" });

    expect(mocks.getLatest).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("stale"),
      }),
    );
  });
});
