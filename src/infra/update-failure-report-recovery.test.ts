import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import type {
  GithubIssueSubmitHooks,
  GithubIssueReconcileHooks,
  PreparedGithubIssue,
} from "./github-issue.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPrepared as markPrepared,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt as reserveReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport } from "./update-failure-report.js";
import {
  createUpdateFailureReportFixture,
  submitUpdateFailureReportFixture as submitUpdateFailureReport,
  expireUpdateFailureReportReceipt,
  savedReportArtifactPath,
  mockCreatedIssue,
  mockFallbackIssue,
} from "./update-failure-report.test-support.js";

const tempDirs = useStateDatabaseTempDirs();
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";

async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function prepareFailedReport(attemptId = "attempt") {
  const stateDir = tempDirs.make("openclaw-update-report-");
  const prepared = await prepareUpdateFailureReport(
    {
      attemptId,
      result: { status: "error", mode: "git", reason: "build-failed", steps: [], durationMs: 20 },
    },
    { stateDir },
  );
  const fixture = createUpdateFailureReportFixture(prepared, stateDir);
  const reserve = async (owner: string) => {
    expect(
      await reserveReceipt(attemptId, owner, prepared.previewDigest, fixture.env),
    ).toMatchObject({ reserved: true });
  };
  const prepareReceipt = async (owner: string) => {
    await reserve(owner);
    expect(await markPrepared(attemptId, owner, prepared.previewDigest, fixture.env)).toBe(true);
  };
  return {
    ...fixture,
    reserve,
    prepareReceipt,
    pending: (owner: string, digest = prepared.previewDigest) =>
      markUpdateFailureReportReceiptPending(attemptId, owner, digest, fixture.env),
    finalize: (value: Parameters<typeof finalizeUpdateFailureReportReceipt>[1]) =>
      finalizeUpdateFailureReportReceipt(attemptId, value, fixture.env),
  };
}

function mockRetryableNoStartIssue() {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return {
      cause: "transport-unavailable" as const,
      reason: "fallback-url-too-long" as const,
      status: "fallback-unavailable" as const,
    };
  });
}

async function pendingReport() {
  const fixture = await prepareFailedReport();
  const createIssue = mockCreatedIssue(issueUrl);
  const submitted = await fixture.submit({ createIssue, finalizeReceipt: () => false });
  return { ...fixture, createIssue, submitted };
}

describe("update failure report receipt recovery", () => {
  it.each(["created", "fallback"] as const)(
    "recognizes an already finalized %s receipt without replaying issue creation",
    async (status) => {
      const { prepared, submit } = await prepareFailedReport(`attempt-${status}-lost-ack`);
      const createIssue =
        status === "created" ? mockCreatedIssue(issueUrl) : mockFallbackIssue(prepared.url);
      const finalizeReceipt = vi.fn(
        async (...args: Parameters<typeof finalizeUpdateFailureReportReceipt>) => {
          await finalizeUpdateFailureReportReceipt(...args);
          return finalizeUpdateFailureReportReceipt(...args);
        },
      );
      const first = await submit({ createIssue, finalizeReceipt });
      const second = await submit({ createIssue });
      const link = status === "created" ? { url: issueUrl } : { fallbackUrl: prepared.url };
      expect(first).toMatchObject({ status, ...link });
      expect(second).toMatchObject({ status: "duplicate", ...link });
      expect(createIssue).toHaveBeenCalledOnce();
      await expectMissing(`${prepared.savedReportPath}.result.json`);
    },
  );

  it("keeps an unknown no-start receipt write pending without replay", async () => {
    const { receipt, submit } = await prepareFailedReport();
    const createIssue = mockRetryableNoStartIssue();
    const finalizeReceipt = vi.fn(async () => {
      throw new Error("Receipt acknowledgement unavailable");
    });
    const result = await submit({ createIssue, finalizeReceipt });
    expect(result).toMatchObject({ status: "pending" });
    expect(finalizeReceipt).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("keeps a retryable artifact when a later submission is stale", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport();
    const first = await submit({ createIssue: mockRetryableNoStartIssue() });
    const staleCreateIssue = mockCreatedIssue(issueUrl);
    const stale = await submit({
      createIssue: staleCreateIssue,
      validateCurrentAttempt: () => false,
    });

    expect(stale).toMatchObject({ status: "stale" });
    expect(staleCreateIssue).not.toHaveBeenCalled();
    const retainedReceipt = await receipt();
    expect(retainedReceipt).toMatchObject({ status: "retryable" });
    expect(retainedReceipt).not.toHaveProperty("cleanup");
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);
  });

  it.each(["retryable", "expired"] as const)(
    "retains %s custody through interrupted cleanup",
    async (origin) => {
      const { prepared, receipt, stateDir, submit, reserve } = await prepareFailedReport();
      const owner = "expired-cleanup-owner";
      let reportPath: string;
      if (origin === "expired") {
        await reserve(owner);
        reportPath = savedReportArtifactPath(prepared, owner);
        await fs.mkdir(path.dirname(reportPath), { recursive: true });
        await fs.writeFile(reportPath, prepared.body, { mode: 0o600 });
        expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
      } else {
        reportPath = (await submit({ createIssue: mockRetryableNoStartIssue() })).savedReportPath;
      }
      const createIssue = mockCreatedIssue(issueUrl);
      const rm = vi
        .spyOn(fs, "rm")
        .mockRejectedValueOnce(new Error("simulated expired cleanup interruption"));

      let interrupted: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
      try {
        interrupted = await submit({ createIssue });
      } finally {
        rm.mockRestore();
      }

      expect(interrupted).toMatchObject({ status: "retryable" });
      expect(createIssue).not.toHaveBeenCalled();
      expect(await receipt()).toMatchObject({
        cleanup: "pending",
        reservationId: origin === "expired" ? owner : expect.any(String),
        status: "retryable",
      });
      await expect(fs.readFile(reportPath, "utf8")).resolves.toBe(prepared.body);

      const recovered = await submit({ createIssue });

      expect(recovered).toMatchObject({ status: "created", url: issueUrl });
      expect(recovered.savedReportPath).not.toBe(reportPath);
      expect(createIssue).toHaveBeenCalledOnce();
      await expectMissing(reportPath);
    },
  );

  it("preserves non-growing expired-owner sweep custody across repeated retries", async () => {
    const { prepared, receipt, stateDir, submit, reserve } = await prepareFailedReport();
    const expiredReservationId = "expired-owner-before-retry";
    await reserve(expiredReservationId);
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);

    let retryable: Awaited<ReturnType<typeof submitUpdateFailureReport>> | undefined;
    for (let index = 0; index < 20; index += 1) {
      retryable = await submit({ createIssue: mockRetryableNoStartIssue() });
      expect(retryable).toMatchObject({ status: "retryable" });
    }

    const created = await submit({ createIssue: mockCreatedIssue(issueUrl) });

    expect(created).toMatchObject({ status: "created" });
    expect(await receipt()).toMatchObject({ artifactSweep: "pending", status: "created" });
    if (!retryable) {
      throw new Error("expected the repeated retry result");
    }
    await expectMissing(retryable.savedReportPath);
  });

  it("reconciles a created issue after restart before stale-attempt validation", async () => {
    const { prepared, receipt, submit, createIssue, submitted } = await pendingReport();
    const reconcileIssue = vi.fn(async () => ({ status: "created" as const, url: issueUrl }));
    const recovered = await submit({
      createIssue,
      reconcileIssue,
      validateCurrentAttempt: () => false,
    });

    expect(recovered).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(reconcileIssue).toHaveBeenCalledWith(prepared, expect.any(Object));
    expect(await receipt()).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "created",
      url: issueUrl,
    });
    await expectMissing(submitted.savedReportPath);
  });

  it("keeps an unreconciled restart pending without replaying issue creation", async () => {
    const { submit, createIssue } = await pendingReport();
    const result = await submit({
      createIssue,
      reconcileIssue: async () => ({ status: "not-found" }),
    });

    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("url");
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("stops restart reconciliation when client authority expires before lookup", async () => {
    const { receipt, submit, createIssue } = await pendingReport();
    let authorityCurrent = true;
    let lookupCalls = 0;
    const reconcileIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueReconcileHooks) => {
        authorityCurrent = false;
        await hooks.beforeIssueLookup?.();
        lookupCalls += 1;
        return { status: "created" as const, url: issueUrl };
      },
    );

    const result = await submit({
      createIssue,
      hasCurrentAuthority: () => authorityCurrent,
      reconcileIssue,
    });

    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("url");
    expect(lookupCalls).toBe(0);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "pending" });
  });

  it("returns the created URL when post-transport receipt reads are also unavailable", async () => {
    const { submit } = await prepareFailedReport();
    const createIssue = mockCreatedIssue(issueUrl);
    const readReceipt = vi
      .fn(readUpdateFailureReportReceipt)
      .mockImplementationOnce(readUpdateFailureReportReceipt)
      .mockImplementationOnce(() => {
        throw new Error("simulated state read outage after transport");
      });

    const first = await submit({
      createIssue,
      finalizeReceipt: () => false,
      readReceipt,
    });
    const second = await submit({ createIssue });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("commits cleanup intent before filesystem deletion and resumes it after reconnect", async () => {
    const { prepared, receipt, submit } = await prepareFailedReport();
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    let observedReceipt: Awaited<ReturnType<typeof readUpdateFailureReportReceipt>> | undefined;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        path.dirname(String(target)) === path.dirname(prepared.savedReportPath) &&
        path.basename(String(target)).startsWith(`${path.parse(prepared.savedReportPath).name}.`)
      ) {
        observedReceipt = await receipt();
        throw new Error("simulated post-commit cleanup interruption");
      }
      return await realRm(target, options);
    });

    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submit({ createIssue });
    } finally {
      rm.mockRestore();
    }

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(observedReceipt).toMatchObject({
      cleanup: "pending",
      previewDigest: prepared.previewDigest,
      status: "created",
      url: issueUrl,
    });
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);

    const second = await submit({ createIssue });

    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expectMissing(first.savedReportPath);
    const completed = await receipt();
    expect(completed).toMatchObject({ status: "created", url: issueUrl });
    expect(completed).not.toHaveProperty("cleanup");
  });

  it("refuses to start transport after the approved preview digest changes", async () => {
    const { prepared, receipt, prepareReceipt, pending } = await prepareFailedReport();
    await prepareReceipt("digest-owner");

    expect(await pending("digest-owner", "f".repeat(64))).toBe(false);
    expect(await receipt()).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "prepared",
    });
  });

  it.each([
    { cleanup: "pending" as const, reservationId: "owner", status: "created" as const },
    {
      fallbackUrl: "https://evil.example/openclaw/openclaw/issues/new",
      reservationId: "owner",
      status: "fallback" as const,
    },
  ])(
    "refuses an unreadable terminal receipt without wedging the pending owner",
    async (terminalReceipt) => {
      const { prepared, receipt, prepareReceipt, pending, finalize } = await prepareFailedReport(
        `attempt-invalid-terminal-${terminalReceipt.status}`,
      );
      await prepareReceipt(terminalReceipt.reservationId);
      if (terminalReceipt.status === "created") {
        expect(await pending(terminalReceipt.reservationId)).toBe(true);
      }

      expect(await finalize({ ...terminalReceipt, previewDigest: prepared.previewDigest })).toBe(
        false,
      );
      expect(await receipt()).toMatchObject({
        previewDigest: prepared.previewDigest,
        status: terminalReceipt.status === "created" ? "pending" : "prepared",
      });
    },
  );

  it("parses a pre-upgrade receipt conservatively without exposing an unbound URL", async () => {
    const { env, prepared, submit, reserve } = await prepareFailedReport();
    await reserve("legacy-owner");
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb =
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">>(db);
    const key = `update-failure-report:${createHash("sha256")
      .update(prepared.attemptId)
      .digest("hex")}`;
    const legacyReceipt = {
      reservationId: "legacy-owner",
      status: "created",
      url: issueUrl,
    };
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("gateway_restart_sentinel")
        .set({
          message: JSON.stringify(legacyReceipt),
          payload_json: JSON.stringify({
            kind: "update",
            message: JSON.stringify(legacyReceipt),
            stats: { reason: "update-failure-report-receipt" },
            status: "skipped",
            ts: Date.now(),
          }),
        })
        .where("sentinel_key", "=", key),
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/124");

    const result = await submit({ createIssue });

    expect(result).toMatchObject({
      message: expect.stringContaining("different reviewed preview"),
      status: "duplicate",
    });
    expect(result).not.toHaveProperty("url");
    expect(createIssue).not.toHaveBeenCalled();
  });
});
