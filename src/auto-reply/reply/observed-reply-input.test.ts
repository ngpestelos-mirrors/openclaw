import { beforeEach, describe, expect, it } from "vitest";
import {
  recordConversationObservationCore,
  type ConversationHistoryCapture,
} from "../../config/sessions/conversation-history.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestFollowupRun, createTestQueueSettings } from "./agent-runner.test-fixtures.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  prepareObservedReplyTakeover,
  readObservedReplyInputOwner,
  withObservedReplyInputOwner,
} from "./observed-reply-input.js";
import { clearSessionQueues, enqueueFollowupRun } from "./queue.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

describe("observed reply input ownership", () => {
  const fixture = useTempSessionsFixture("openclaw-observed-reply-");
  const targetKey = "agent:main:acp:bound";
  const sourceKey = "agent:main:discord:channel:source";
  const sessionId = "bound-session";
  const scope = () => ({ agentId: "main", storePath: fixture.storePath() });
  const target = () => ({ ...scope(), sessionKey: targetKey, sessionId });
  const observe = (sourceId: string, text = sourceId) =>
    recordConversationObservationCore(scope(), {
      conversationRef: "conv_source",
      sourceId,
      message: { text, sender: { name: "Friend" } },
    });
  const recorderFor = (sourceId: string) =>
    createUserTurnTranscriptRecorder({
      input: { text: sourceId, idempotencyKey: sourceId, timestamp: 1 },
      target: { ...target(), sessionEntry: { sessionId, updatedAt: 1 } },
    });
  const prepare = async (capture: ConversationHistoryCapture, sourceId: string) => {
    const recorder = recorderFor(sourceId);
    return await withObservedReplyInputOwner(capture, undefined, async (options) => {
      const owner = readObservedReplyInputOwner(options)!;
      return await owner.prepare({ recorder, runId: sourceId, assertCurrent: () => {} });
    });
  };

  beforeEach(async () => {
    await upsertSessionEntryCore(target(), { sessionId, updatedAt: 1 });
    await upsertSessionEntryCore(
      { ...scope(), sessionKey: sourceKey },
      {
        sessionId: "source-session",
        updatedAt: 1,
      },
    );
  });

  it("gives a bound takeover its captured prompt and commits only to the target transcript", async () => {
    await observe("background", "The deadline is Friday");
    const capture = await observe("request", "Summarize");
    const ctx = finalizeInboundContext({
      SessionKey: sourceKey,
      Body: "Summarize",
      BodyForAgent: "Summarize",
      RawBody: "Summarize",
      Provider: "discord",
      Surface: "discord",
      AccountId: "default",
      From: "discord:channel:source",
      To: "channel:source",
      ChatType: "channel",
      MessageSid: "request",
      SenderId: "owner",
      ConversationHistory: capture,
    });
    setChannelSourceTurnId(ctx, "request");
    await withObservedReplyInputOwner(capture, undefined, async (replyOptions) => {
      const params = { replyOptions };
      expect(
        await prepareObservedReplyTakeover(
          {
            params,
            ctx,
            cfg: { session: { store: fixture.storePath() } },
            workspaceDir: fixture.sessionsDir(),
            getPreDispatchAbortSignal: () => undefined,
            replaceDispatchAgentText: (text) => {
              ctx.agentText = text;
            },
          },
          targetKey,
        ),
      ).toBe(true);
      expect(ctx.agentText).toContain("Friend: The deadline is Friday");
      expect(ctx.agentText).toContain("Summarize");
      await params.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    });
    expect(JSON.stringify(await loadTranscriptEvents(target()))).toContain(
      "The deadline is Friday",
    );
    expect(
      await loadTranscriptEvents({
        ...scope(),
        sessionKey: sourceKey,
        sessionId: "source-session",
      }),
    ).toEqual([]);
  });

  it("releases history when an early refusal returns before runtime execution", async () => {
    await observe("background", "Do not lose this context");
    const capture = await observe("refused");
    await withObservedReplyInputOwner(capture, undefined, async (options) => {
      await readObservedReplyInputOwner(options)!.prepare({
        recorder: recorderFor("refused"),
        runId: "refused",
        assertCurrent: () => {},
      });
      return { reason: "question-response-refused" };
    });
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("cancelled");
    expect(await prepare(await observe("next"), "next")).toContain("Do not lose this context");
  });

  it("retains interrupted input identity for a safe retry after a pre-submission error", async () => {
    const capture = await observe("retry");
    await expect(
      withObservedReplyInputOwner(capture, undefined, async (options) => {
        await readObservedReplyInputOwner(options)!.prepare({
          recorder: recorderFor("retry"),
          runId: "retry",
          assertCurrent: () => {},
        });
        throw new Error("preparation failed");
      }),
    ).rejects.toThrow("preparation failed");
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("interrupted");
    expect(await prepare(capture, "retry")).toBe("retry");
  });

  it("transfers cleanup only after queue admission and releases it when that queue closes", async () => {
    const capture = await observe("queued");
    const recorder = recorderFor("queued");
    const queueKey = "observed-input-owner";
    await withObservedReplyInputOwner(capture, undefined, async (options) => {
      const observedInput = readObservedReplyInputOwner(options)!;
      await observedInput.prepare({ recorder, runId: "queued", assertCurrent: () => {} });
      const queued = createTestFollowupRun();
      queued.observedInput = observedInput;
      queued.userTurnTranscriptRecorder = recorder;
      expect(enqueueFollowupRun(queueKey, queued, createTestQueueSettings())).toBe(true);
    });
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("queued");
    clearSessionQueues([queueKey]);
    expect(listSessionPendingInputs(target()).items[0]?.state).toBe("cancelled");
  });
});
