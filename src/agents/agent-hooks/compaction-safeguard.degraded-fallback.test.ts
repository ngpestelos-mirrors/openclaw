import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeCompactionHistory } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { consumeCompactionSafeguardCancellation } from "./compaction-safeguard-runtime.js";
import {
  testing,
  stubSessionManager,
  structuredSummary,
  userMessage,
  createQualityGuardSessionManager,
  createCompactionEvent,
  runCompactionScenario,
  expectCompactionResult,
} from "./compaction-safeguard.test-support.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const { createMockSubsystemLogger } =
    await import("../../../test/helpers/mock-subsystem-logger.js");
  const compactionLogger = createMockSubsystemLogger("compaction-safeguard", { warn });
  return {
    ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
    createSubsystemLogger: () => compactionLogger,
  };
});

const { MAX_COMPACTION_SUMMARY_CHARS, CONTEXT_TRUNCATED_MARKER } = testing;
const mockSummarizeCompactionHistory = vi.fn<typeof summarizeCompactionHistory>();

beforeEach(() => {
  mockSummarizeCompactionHistory.mockReset();
  testing.setSummarizeCompactionHistoryForTest(mockSummarizeCompactionHistory);
  warn.mockClear();
});
afterEach(() => testing.setSummarizeCompactionHistoryForTest());

async function degradedSummary(
  event: Parameters<typeof createCompactionEvent>[0],
  session = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 }),
) {
  const { result } = await runCompactionScenario(session, createCompactionEvent(event));
  expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
  expect(consumeCompactionSafeguardCancellation(session)).toBeNull();
  const { summary } = expectCompactionResult(result);
  expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
  return summary;
}

function expectSummaryContains(summary: string, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(summary).toContain(fragment);
  }
}

describe("compaction-safeguard degraded fallback", () => {
  it.each(["branch read", "context projection"] as const)(
    "cancels rather than writing an empty boundary after a failed %s",
    async (stage) => {
      const failure = new Error(`Failed ${stage}`);
      const sessionManager = stubSessionManager();
      sessionManager.getBranch = () => {
        if (stage === "branch read") {
          throw failure;
        }
        return [
          {
            type: "message",
            id: "older",
            parentId: null,
            timestamp: "1970-01-01T00:00:00.000Z",
            get message(): never {
              throw failure;
            },
          },
          {
            type: "message",
            id: "entry-1",
            parentId: "older",
            timestamp: "1970-01-01T00:00:00.001Z",
            message: { role: "user", content: "Kept user request", timestamp: 1 },
          },
        ];
      };
      const { result, getApiKeyAndHeadersMock } = await runCompactionScenario(
        sessionManager,
        createCompactionEvent({ preparation: { messagesToSummarize: [] } }),
      );

      expect(result).toEqual({ cancel: true });
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toEqual({
        reason: "session history inspection failed",
        error: failure,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("session history inspection failed"),
      );
      expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
      expect(mockSummarizeCompactionHistory).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "degrades when an identifier exceeds the cap (run-owned request: %s)",
    async (runOwnedRequest) => {
      const latestAsk = "preserve the pending deployment status";
      const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
      const fittingIdentifier = "/var/log/deploy-status.log";
      mockSummarizeCompactionHistory.mockResolvedValue(
        structuredSummary({ asks: latestAsk, identifiers: identifier }),
      );

      const summary = await degradedSummary({
        preparation: {
          messagesToSummarize: [
            userMessage(`the status log is ${fittingIdentifier}`, 1),
            userMessage(`${latestAsk} ${identifier}`, 2),
          ],
          // The session owner bounds a run-owned request to 800 chars before it gets here.
          ...(runOwnedRequest ? { latestUnresolvedUserRequest: latestAsk } : {}),
        },
      });

      // Oversized identifiers must not leave the session permanently uncompactable.
      expectSummaryContains(summary, "Latest user request context:", latestAsk, fittingIdentifier);
      expect(summary).not.toContain(identifier);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/loss=.*identifier-retention/));
      expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(1);
    },
  );

  it("retains the pending ask and identifiers and logs the degraded reasonCode", async () => {
    const latestAsk = "confirm the staging rollback finished";
    const identifier = "/tmp/degraded-retention.log";
    mockSummarizeCompactionHistory.mockResolvedValue("Core summary without headings");
    const summary = await degradedSummary({ messageText: `${latestAsk} ${identifier}` });

    expectSummaryContains(summary, "Core summary without headings", latestAsk, identifier);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reasonCode=quality_guard_degraded_fallback"),
    );
  });

  it("keeps the stronger summary when a corrective retry loses context", async () => {
    const better = structuredSummary({ decisions: "Keep the blue deployment." }).replace(
      "## Exact identifiers",
      "Identifiers",
    );
    mockSummarizeCompactionHistory
      .mockResolvedValueOnce(better)
      .mockResolvedValueOnce("Unrelated retry without sections.");
    const summary = await degradedSummary(
      { messageText: "confirm deployment status" },
      createQualityGuardSessionManager({ recentTurnsPreserve: 0, qualityGuardMaxRetries: 1 }),
    );
    expectSummaryContains(summary, "Keep the blue deployment.", "confirm deployment status");
    expect(summary).not.toContain("Unrelated retry");
    expect(summary.match(/^## Pending user asks$/gm)).toHaveLength(1);
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps generated split-turn context when a terminal audit trims the suffix", async () => {
    const latestAsk = "roll back the api deployment and confirm health";
    const activeTurn = "Active turn: rolled back api-7 and is waiting on the health check.";
    // Fill each cap so the suffix alone exceeds the artifact budget.
    const files = (kind: string) =>
      Array.from({ length: 40 }, (_, index) => `/srv/app/${kind}/module-${index}.ts`);
    const history = Array.from({ length: 14 }, (_, turn) => [
      userMessage(`turn ${turn} ${"u".repeat(700)}`, 2 * turn + 1),
      castAgentMessage(timestampedTextAssistant(`reply ${turn} ${"r".repeat(700)}`, 2 * turn + 2)),
    ]).flat();
    mockSummarizeCompactionHistory.mockImplementation(async (params) =>
      params.summaryPrompt?.kind === "custom"
        ? "Core summary without headings"
        : `${activeTurn} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`,
    );

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: history,
        turnPrefixMessages: [userMessage(latestAsk, 100)],
        isSplitTurn: true,
      },
    });
    Object.assign(event.preparation.fileOps, { read: files("read"), edited: files("edit") });
    const summary = await degradedSummary(
      event,
      createQualityGuardSessionManager({ recentTurnsPreserve: 12, qualityGuardMaxRetries: 0 }),
    );
    // Capping the suffix by its tail used to drop the active split turn first.
    expectSummaryContains(
      summary,
      `**Turn Context (split turn):**\n\n${activeTurn}`,
      latestAsk,
      CONTEXT_TRUNCATED_MARKER.trim(),
      "reply 13 ",
    );
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(2);
  });
});
