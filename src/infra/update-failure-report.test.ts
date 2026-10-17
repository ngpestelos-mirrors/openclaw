import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { VERSION } from "../version.js";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import {
  beginStaleUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  finalizeUpdateFailureReportReceipt,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { cleanRetiredUpdateFailureReportArtifacts } from "./update-failure-report-artifact-sweep.js";
import { prepareUpdateFailureReport } from "./update-failure-report.js";
import {
  createUpdateFailureReportFixture,
  submitUpdateFailureReportFixture as submitUpdateFailureReport,
  expireUpdateFailureReportReceipt,
  savedReportArtifactPath,
  mockCreatedIssue,
  mockFallbackIssue,
  mockFallbackAfterIssueCreateNoStart,
} from "./update-failure-report.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const tempDirs = useStateDatabaseTempDirs();
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";

async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

type PreparedReport = Awaited<ReturnType<typeof prepareUpdateFailureReport>>;

async function currentSavedReportArtifactPath(
  prepared: PreparedReport,
  stateDir: string,
): Promise<string> {
  const receipt = await readUpdateFailureReportReceipt(prepared.attemptId, {
    OPENCLAW_STATE_DIR: stateDir,
  });
  if (!receipt) {
    throw new Error("expected an authoritative update report receipt");
  }
  return savedReportArtifactPath(
    prepared,
    receipt.reservationId,
    receipt.previewDigest ?? prepared.previewDigest,
  );
}

async function listSavedReportArtifacts(prepared: PreparedReport): Promise<string[]> {
  const parsed = path.parse(prepared.savedReportPath);
  const entries = await fs.readdir(parsed.dir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => entry.startsWith(`${parsed.name}.`) && entry.endsWith(parsed.ext))
    .map((entry) => path.join(parsed.dir, entry));
}

function failedUpdate(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [
      {
        name: "build",
        command: "pnpm build --token raw-command-secret",
        cwd: "/Users/private/openclaw",
        durationMs: 12,
        exitCode: 1,
        stdoutTail: "raw chat and log output must not be copied",
        stderrTail: "token=raw-log-secret /Users/private/openclaw/build.log",
      },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
    ...overrides,
  };
}

async function prepareFailedReport(
  result: Partial<UpdateRunResult> = {},
  stateDir = tempDirs.make("openclaw-update-report-"),
) {
  const prepared = await prepareUpdateFailureReport(
    { attemptId: "attempt", result: failedUpdate(result) },
    { stateDir },
  );
  return createUpdateFailureReportFixture(prepared, stateDir);
}

function pausedValidation() {
  const started = createDeferred();
  const gate = createDeferred<boolean>();
  const validate = vi
    .fn<() => boolean | Promise<boolean>>()
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
  return { started: started.promise, finish: gate.resolve, validate };
}

function pausedFallback(url: string) {
  const entered = createDeferred();
  const gate = createDeferred();
  const createIssue = vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    entered.resolve();
    await gate.promise;
    return { url, reason: "cli-unavailable" as const, status: "browser-fallback" as const };
  });
  return { entered: entered.promise, release: gate.resolve, createIssue };
}

async function expectDuplicate(submit: Awaited<ReturnType<typeof prepareFailedReport>>["submit"]) {
  const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/124");
  expect(await submit({ createIssue })).toMatchObject({ status: "duplicate", url: issueUrl });
  expect(createIssue).not.toHaveBeenCalled();
}

async function retireReceipt(
  fixture: Awaited<ReturnType<typeof prepareFailedReport>>,
  reservationId: string,
  stageArtifact = false,
) {
  const { prepared, env, stateDir } = fixture;
  const { attemptId, previewDigest } = prepared;
  expect(
    await reserveUpdateFailureReportReceipt(attemptId, reservationId, previewDigest, env),
  ).toMatchObject({ reserved: true });
  const reportPath = savedReportArtifactPath(prepared, reservationId);
  if (stageArtifact) {
    await fs.mkdir(path.dirname(reportPath), { mode: 0o700, recursive: true });
    await fs.writeFile(`${reportPath}.pending`, prepared.body, { mode: 0o600 });
  }
  expireUpdateFailureReportReceipt(attemptId, stateDir);
  expect(await beginStaleUpdateFailureReportReceiptCleanup(attemptId, reservationId, env)).toBe(
    true,
  );
  expect(await completeUpdateFailureReportReceiptCleanup(attemptId, reservationId, env)).toBe(true);
  return reportPath;
}

it("excludes a later advisory step when selecting the failed phase", async () => {
  const { prepared } = await prepareFailedReport({
    steps: [
      failedUpdate().steps[0]!,
      {
        name: "post-install doctor",
        command: "openclaw doctor",
        cwd: "/tmp/openclaw",
        durationMs: 5,
        exitCode: 86,
        advisory: {
          kind: "package-post-install-doctor",
          message: "recoverable repair warning",
        },
      },
    ],
  });

  expect(prepared.title).toBe(`Update failure: build (${VERSION})`);
  expect(prepared.body).toContain("Failed phase: build");
  expect(prepared.body).not.toContain("post-install doctor");
});

it("saves only allowlisted, redacted, Unicode-safe report facts for fallback", async () => {
  const home = tempDirs.make("openclaw-update-report-");
  const stateDir = path.join(home, ".openclaw");
  const secret = "sk-test-update-report-secret-1234567890";
  const emoji = "🦞".repeat(2_000);
  const prepared = await prepareUpdateFailureReport(
    {
      attemptId: "attempt-redaction",
      error: `opaque raw chat payload token=${secret} ${home}/private/error.log`,
      result: failedUpdate({
        reason:
          "build-failed at /Users/Alice Smith/private/customer list.txt after checksum mismatch",
        steps: [
          {
            ...failedUpdate().steps[0]!,
            name: `Command failed: /usr/local/bin/openclaw doctor --fix ${home}/source token=${secret}`,
          },
        ],
      }),
      target: [
        `origin/main token=${secret}`,
        "windows C:\\Users\\Alice Smith\\private\\project after windows marker",
        "unc \\\\server\\Alice Smith\\private\\project after unc marker",
        "rooted \\Users\\Alice Smith\\private\\rooted-secret.txt after rooted marker",
        'quoted "/Users/Alice Smith/private project" after quoted marker',
        "openclaw.exe doctor --token openclaw-exe-secret",
        '"npm.cmd" install --token npm-cmd-secret',
        "npm.ps1 install --token npm-ps1-secret",
        '"PowerShell.EXE" -EncodedCommand powershell-exe-secret',
        '"cmd.exe" /c echo cmd-exe-secret',
        emoji,
      ].join("\n"),
    },
    { env: { HOME: home, OPENCLAW_STATE_DIR: stateDir }, stateDir },
  );
  await expectMissing(prepared.savedReportPath);
  const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
    createIssue: mockFallbackIssue("https://github.com/openclaw/openclaw/issues/new?title=update"),
    env: { HOME: home, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
  });
  expect(result).toMatchObject({ status: "fallback" });

  const saved = await fs.readFile(result.savedReportPath, "utf8");
  expect(saved).toBe(prepared.body);
  expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(16_000);
  expect(saved).toContain("Recovery outcome: verified safe to restart");
  expect(saved).toContain("Failed phase:");
  expect(saved).toContain("Update target:");
  expect(saved).toContain("🦞");
  expect(saved).toContain("[redacted-path]");
  expect(saved).not.toContain("�");
  expect(saved).not.toContain(secret);
  expect(saved).not.toContain(home);
  expect(saved).not.toContain("/var/lib/openclaw");
  expect(saved).not.toContain("/Users/alice");
  expect(saved).not.toContain("Alice Smith");
  expect(saved).not.toContain("rooted-secret");
  expect(saved).not.toContain("openclaw-exe-secret");
  expect(saved).not.toContain("npm-cmd-secret");
  expect(saved).not.toContain("npm-ps1-secret");
  expect(saved).not.toContain("powershell-exe-secret");
  expect(saved).not.toContain("cmd-exe-secret");
  expect(saved).not.toContain("customer list.txt");
  expect(saved).not.toContain("after checksum mismatch");
  expect(saved).not.toContain("https://example.com/?next=/docs");
  expect(saved).not.toContain("opaque raw chat payload");
  expect(saved).not.toContain("raw-command-secret");
  expect(saved).not.toContain("raw-log-secret");
  expect(saved).not.toContain("raw chat and log output");
  expect(saved).not.toContain("openclaw doctor --fix");
  expect(saved).not.toContain("C:\\Users\\private");
  expect(saved).not.toContain("\\\\server\\private");
  if (process.platform !== "win32") {
    expect((await fs.stat(path.dirname(result.savedReportPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(result.savedReportPath)).mode & 0o777).toBe(0o600);
  }
});

it("does not substitute restored post-failure state for an unavailable update target", async () => {
  const { prepared } = await prepareFailedReport({
    after: { version: "2026.8.1" },
    recovery: {
      packageRollbackVerified: true,
      reason: "runtime-verification-failed",
      serviceRestartSafe: false,
    },
  });

  expect(prepared.body).toContain("Update target: exact target unavailable; mode: git");
  expect(prepared.body).not.toContain("Update target: version 2026.8.1");
  expect(prepared.body).toContain(
    "Recovery outcome: package rollback verified; service restart not verified (runtime-verification-failed)",
  );
});

it("submits once and rejects a duplicate click for the same attempt", async () => {
  const { submit } = await prepareFailedReport();
  const createIssue = mockCreatedIssue(issueUrl);

  const [first, second] = await Promise.all([submit({ createIssue }), submit({ createIssue })]);
  const third = await submit({ createIssue, validateCurrentAttempt: () => false });

  expect(createIssue).toHaveBeenCalledOnce();
  expect([first.status, second.status].toSorted()).toEqual(["created", "retryable"]);
  expect(third).toMatchObject({ status: "duplicate", url: issueUrl });
  await expectMissing(first.savedReportPath);
});

it("returns the fallback when issue creation cannot start after auth preflight", async () => {
  const { prepared, receipt, submit } = await prepareFailedReport();
  const createIssue = mockFallbackAfterIssueCreateNoStart(prepared.url);

  const first = await submit({ createIssue });
  const second = await submit({ createIssue });

  expect(first).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
  expect(second).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
  expect(createIssue).toHaveBeenCalledOnce();
  expect(await receipt()).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
});

it.each(["authority", "attempt", "refresh error"] as const)(
  "releases preparation after %s immediately before issue creation",
  async (change) => {
    const { prepared, submit } = await prepareFailedReport();
    let current = true;
    let issueCreateCalls = 0;
    let validationCalls = 0;
    const guards = {
      hasCurrentAuthority: () => change !== "authority" || current,
      validateCurrentAttempt: () => {
        if (change === "refresh error" && ++validationCalls === 3) {
          throw new Error("restart sentinel refresh unavailable");
        }
        return change !== "attempt" || current;
      },
    };
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        current = false;
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return { status: "created" as const, url: issueUrl };
      },
    );
    const submission = submit({ createIssue, ...guards });
    if (change === "authority") {
      await expect(submission).rejects.toThrow("current authenticated client");
    } else if (change === "refresh error") {
      await expect(submission).rejects.toThrow("could not be rechecked");
    } else {
      await expect(submission).resolves.toMatchObject({ status: "stale" });
    }
    expect(issueCreateCalls).toBe(0);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
    current = true;
    const retryCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/124");
    await expect(submit({ createIssue: retryCreateIssue, ...guards })).resolves.toMatchObject({
      status: "created",
    });
    expect(retryCreateIssue).toHaveBeenCalledOnce();
  },
);

it("does not let a pending-reservation loser delete the winner's fallback report", async ({
  signal,
}) => {
  const { prepared, stateDir, submit } = await prepareFailedReport();
  const fallbackUrl = prepared.url;
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  const validationGate = createDeferred<boolean>();
  const fallback = pausedFallback(fallbackUrl);
  const delayedCreateIssue = vi.fn();
  const delayed = submit({
    createIssue: delayedCreateIssue,
    validateCurrentAttempt: () => validationGate.promise,
  });
  const createIssue = fallback.createIssue;
  const winner = submit({ createIssue });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        fallback.entered,
        winner,
        "Winner did not reach fallback transport",
      ),
      signal,
    );
    expect(createIssue).toHaveBeenCalledOnce();
    const winnerReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(winnerReportPath, "utf8")).toBe(prepared.body);

    validationGate.resolve(true);
    const delayedResult = await withinTest(delayed, signal);
    expect(delayedResult).toMatchObject({ status: "retryable" });
    expect(delayedResult).not.toHaveProperty("fallbackUrl");
    expect(delayedCreateIssue).not.toHaveBeenCalled();
    fallback.release();
    const winnerResult = await withinTest(winner, signal);
    expect(winnerResult).toMatchObject({
      status: "fallback",
      fallbackUrl,
      savedReportPath: winnerReportPath,
    });
    expect(await fs.readFile(winnerReportPath, "utf8")).toBe(prepared.body);
  } finally {
    validationGate.resolve(true);
    fallback.release();
    await Promise.allSettled([delayed, winner]);
  }
});

it("does not let a delayed cleanup worker delete a successor report artifact", async () => {
  const { prepared, stateDir, submit } = await prepareFailedReport();
  const validation = pausedValidation();
  const oldCreateIssue = vi.fn();
  const cleanup = createDeferred();
  const cleanupStarted = createDeferred();
  const oldSubmission = submit({
    createIssue: oldCreateIssue,
    validateCurrentAttempt: validation.validate,
  });
  try {
    await validation.started;
    expect(validation.validate).toHaveBeenCalledTimes(2);
    const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

    const realRm = fs.rm.bind(fs);
    let blockedFirstCleanup = false;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === oldReportPath && !blockedFirstCleanup) {
        blockedFirstCleanup = true;
        cleanupStarted.resolve();
        await cleanup.promise;
      }
      return await realRm(target, options);
    });

    validation.finish(false);
    await cleanupStarted.promise;
    let replacement: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    let oldResult: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      replacement = await submit({ createIssue: mockFallbackIssue(prepared.url) });
      expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
      expect(replacement.savedReportPath).not.toBe(oldReportPath);
      expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
      cleanup.resolve();
      oldResult = await oldSubmission;
    } finally {
      cleanup.resolve();
      rm.mockRestore();
    }

    expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
    await expectMissing(oldReportPath);
    await expectMissing(`${oldReportPath}.pending`);
  } finally {
    validation.finish(false);
    cleanup.resolve();
    await Promise.allSettled([oldSubmission]);
  }
});

it("isolates a replacement from an expired owner's mismatched report artifact", async () => {
  const { prepared: oldPrepared, stateDir, submit } = await prepareFailedReport();
  const { prepared: replacementPrepared, submit: replace } = await prepareFailedReport(
    { reason: "install-failed" },
    stateDir,
  );
  expect(replacementPrepared.body).not.toBe(oldPrepared.body);
  const validation = pausedValidation();
  const oldCreateIssue = vi.fn();
  const oldSubmission = submit({
    createIssue: oldCreateIssue,
    validateCurrentAttempt: validation.validate,
  });
  try {
    await validation.started;
    expect(validation.validate).toHaveBeenCalledTimes(2);
    const oldReportPath = await currentSavedReportArtifactPath(oldPrepared, stateDir);
    expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(oldPrepared.body);

    expireUpdateFailureReportReceipt(oldPrepared.attemptId, stateDir);
    const replacement = await replace({ createIssue: mockFallbackIssue(replacementPrepared.url) });
    validation.finish(false);
    const oldResult = await oldSubmission;

    expect(replacement).toMatchObject({ fallbackUrl: replacementPrepared.url, status: "fallback" });
    expect(oldResult).toMatchObject({
      message: expect.stringContaining("different reviewed preview"),
      status: "duplicate",
    });
    expect(oldResult).not.toHaveProperty("fallbackUrl");
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(replacement.savedReportPath).not.toBe(oldReportPath);
    expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(replacementPrepared.body);
    await expectMissing(`${oldReportPath}.pending`);
  } finally {
    validation.finish(false);
    await oldSubmission;
  }
});

it("fences an expired staged writer and recovers its interrupted cleanup", async () => {
  const { prepared, receipt, stateDir, submit } = await prepareFailedReport();
  const write = createDeferred();
  const writeStarted = createDeferred();
  let delayFirstStagedWrite = true;
  const writeFile = fs.writeFile;
  const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (delayFirstStagedWrite && typeof args[0] === "string" && args[0].endsWith(".pending")) {
      delayFirstStagedWrite = false;
      writeStarted.resolve();
      await write.promise;
    }
    return writeFile(...args);
  });
  const oldCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/122");

  const oldSubmission = submit({ createIssue: oldCreateIssue });
  try {
    await writeStarted.promise;
    const oldReportPath = await currentSavedReportArtifactPath(prepared, stateDir);
    const oldStagedReportPath = `${oldReportPath}.pending`;
    expect(await receipt()).toMatchObject({ status: "preparing" });

    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    const replacement = await submit({ createIssue: mockCreatedIssue(issueUrl) });
    await fs.mkdir(path.dirname(oldReportPath), { mode: 0o700, recursive: true });
    const rm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0] === oldStagedReportPath) {
        throw new Error("simulated late-owner cleanup interruption");
      }
      return rm(...args);
    });
    write.resolve();
    const oldResult = await oldSubmission.finally(() => {
      rmSpy.mockRestore();
      writeSpy.mockRestore();
    });

    expect(replacement).toMatchObject({ status: "created", url: issueUrl });
    expect(oldResult).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ artifactSweep: "pending", status: "created" });
    await expectMissing(oldReportPath);
    await expect(fs.readFile(oldStagedReportPath, "utf8")).resolves.toBe(prepared.body);

    await expectDuplicate(submit);
    await expectMissing(oldReportPath);
    await expectMissing(oldStagedReportPath);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
  } finally {
    write.resolve();
    await Promise.allSettled([oldSubmission]);
    writeSpy.mockRestore();
  }
});

it("fences an expired sweep holder before listing successor artifacts", async () => {
  const fixture = await prepareFailedReport();
  const { prepared, stateDir, submit } = fixture;
  const expiredReservationId = "expired-sweep-reservation";
  const retiredPath = await retireReceipt(fixture, expiredReservationId, true);
  const sweep = createDeferred();
  const sweepClaimed = createDeferred();
  const staleListCandidates = vi.fn(async () => {
    throw new Error("an expired sweep holder must not scan after takeover");
  });
  const staleCreateIssue = vi.fn();
  const transport = createDeferred();
  const staleSubmission = submit({
    artifactSweepHooks: {
      beforeList: async () => {
        sweepClaimed.resolve();
        await sweep.promise;
      },
      listCandidates: staleListCandidates,
    },
    createIssue: staleCreateIssue,
  });
  const submissions = [staleSubmission];
  try {
    await sweepClaimed.promise;

    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    const published = createDeferred();
    let transportCount = 0;
    const successorCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        published.resolve();
        await transport.promise;
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        transportCount += 1;
        return { status: "created" as const, url: issueUrl };
      },
    );
    const successorSubmission = submit({ createIssue: successorCreateIssue });
    submissions.push(successorSubmission);
    await published.promise;
    const successorPath = await currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(successorPath, "utf8")).toBe(prepared.body);
    await expectMissing(`${retiredPath}.pending`);

    sweep.resolve();
    const staleResult = await staleSubmission;
    expect(staleResult).toMatchObject({ status: "retryable" });
    expect(staleListCandidates).not.toHaveBeenCalled();
    expect(staleCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(successorPath, "utf8")).toBe(prepared.body);

    transport.resolve();
    const successorResult = await successorSubmission;
    expect(successorResult).toMatchObject({ status: "created", url: issueUrl });
    expect(transportCount).toBe(1);
    expect(successorCreateIssue).toHaveBeenCalledOnce();

    await expectDuplicate(submit);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
    await expectMissing(`${retiredPath}.pending`);
  } finally {
    sweep.resolve();
    transport.resolve();
    await Promise.allSettled(submissions);
  }
});

it("preserves successor artifacts when the final sweep reply arrives after foreign takeover", async () => {
  const fixture = await prepareFailedReport();
  const { env, prepared, receipt, stateDir, submit } = fixture;
  const reservationId = "retired-reservation";
  const retiredPath = await retireReceipt(fixture, reservationId);
  const retired = await receipt();
  if (!retired) {
    throw new Error("Expected retired receipt");
  }
  await fs.mkdir(path.dirname(retiredPath), { recursive: true });
  await fs.writeFile(retiredPath, prepared.body);
  const queried = createDeferred();
  const releaseReply = createDeferred();
  const execute = stateReads.executeExistingOpenClawStateRead;
  let leaseReads = 0;
  const reader = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const reply = await execute(...args);
      if (
        reply?.ok &&
        reply.type === "restartSentinel.reportReceipt" &&
        reply.receipt?.sweepOwnerId
      ) {
        leaseReads += 1;
        if (leaseReads === 2) {
          queried.resolve();
          await releaseReply.promise;
        }
      }
      return reply;
    });
  const sweeping = cleanRetiredUpdateFailureReportArtifacts(prepared, retired, env, false);
  let successor: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
  try {
    await queried.promise;
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    successor = await submit({ publicationMode: "browser" });
    expect(successor).toMatchObject({ status: "fallback" });
    expect(successor.savedReportPath).not.toBe(retiredPath);
    releaseReply.resolve();
    expect(await sweeping).toBe(false);
    expect(await fs.readFile(successor.savedReportPath, "utf8")).toBe(prepared.body);
  } finally {
    releaseReply.resolve();
    await sweeping;
    reader.mockRestore();
  }
});

it("does not publish a fallback after its preparation lease is replaced", async ({ signal }) => {
  const { prepared, stateDir, submit } = await prepareFailedReport();
  const fallback = pausedFallback(prepared.url!);
  const oldSubmission = submit({ createIssue: fallback.createIssue });
  const submissions = [oldSubmission];
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        fallback.entered,
        oldSubmission,
        "Old owner did not reach fallback transport",
      ),
      signal,
    );
    expect(fallback.createIssue).toHaveBeenCalledOnce();
    expireUpdateFailureReportReceipt(prepared.attemptId, stateDir);
    const replacementSubmission = submit({ createIssue: mockCreatedIssue(issueUrl) });
    submissions.push(replacementSubmission);
    const replacement = await withinTest(replacementSubmission, signal);
    fallback.release();
    const oldResult = await withinTest(oldSubmission, signal);

    expect(replacement).toMatchObject({ status: "created", url: issueUrl });
    expect(oldResult).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(oldResult).not.toHaveProperty("fallbackUrl");
    await expectMissing(`${prepared.savedReportPath}.result.json`);
  } finally {
    fallback.release();
    await Promise.allSettled(submissions);
  }
});

it.each(["returns false", "throws"])(
  "returns a created URL without replaying unknown finalization when it %s",
  async (failure) => {
    const { submit } = await prepareFailedReport();
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi
      .fn(finalizeUpdateFailureReportReceipt)
      .mockImplementationOnce(async () => {
        if (failure === "throws") {
          throw new Error("receipt database unavailable");
        }
        return false;
      });

    const first = await submit({ createIssue, finalizeReceipt });
    const second = await submit({ createIssue });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    if (failure === "throws") {
      expect(second).toMatchObject({ status: "pending" });
      expect(finalizeReceipt).toHaveBeenCalledOnce();
      expect(await fs.readFile(first.savedReportPath, "utf8")).not.toBe("");
    } else {
      expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
      expect(finalizeReceipt).toHaveBeenCalledTimes(2);
      await expectMissing(first.savedReportPath);
    }
  },
);
