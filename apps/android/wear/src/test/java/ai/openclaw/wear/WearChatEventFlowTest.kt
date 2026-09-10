package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcError
import ai.openclaw.wear.shared.WearRpcMethod
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35])
class WearChatEventFlowTest {
  @Test
  fun acceptedSendSettlesOnRemoteErrorAndAbortWithUnchangedHistory() {
    for ((terminal, outcome) in listOf("error" to WearReplyOutcome.Error, "aborted" to WearReplyOutcome.Aborted)) {
      withFlow { flow ->
        flow.send()
        assertNotNull(flow.state.pendingReply)
        flow.emit(terminal)
        assertNull(flow.state.pendingReply)
        assertNull(flow.state.activeRunId)
        assertEquals(outcome, flow.state.replyTerminal?.outcome)
        assertTrue(flow.state.messages.isEmpty())
        flow.vm.refresh()
        flow.idle()
        assertEquals(outcome, flow.state.replyTerminal?.outcome)
        assertEquals(if (terminal == "error") WearConversationFailure.INTERNAL_ERROR else null, flow.state.conversationFailure)
      }
    }
  }

  @Test
  fun foreignAndAnonymousTerminalsCannotSettleAcceptedIdentifiedReply() =
    withFlow { flow ->
      flow.send()
      for (terminal in listOf("final", "aborted", "error")) {
        flow.emit(terminal, eventRunId = "older-run")
        assertNotNull(flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
        flow.emit(terminal, eventRunId = null)
        assertNotNull(flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
      }
      flow.emit("final")
      assertNull(flow.state.pendingReply)
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun terminalBeforeSendAcknowledgmentSurvivesTheAcknowledgmentHistoryLoad() =
    withFlow { flow ->
      flow.sendGate = CompletableDeferred()
      flow.send()
      assertTrue(flow.state.sending)
      flow.emit("error")
      flow.sendGate?.complete(Unit)
      flow.idle()
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertNull(flow.state.pendingReply)
      assertEquals(false, flow.state.sending)
    }

  @Test
  fun orderedCompleteProjectionsShrinkClearAndRemainUnicodeBounded() =
    withFlow { flow ->
      for (text in listOf("Hello world", "Hello", "")) {
        flow.emit("delta", text = text, complete = true)
        assertEquals(text, flow.state.streamText)
      }
      flow.emit("delta", text = "😀".repeat(2_100), complete = true)
      assertEquals("😀".repeat(2_000), flow.state.streamText)
    }

  @Test
  fun incompleteProjectionsAndSnapshotRacesStillPreservePrefixes() =
    withFlow { flow ->
      flow.emit("delta", text = "Hello world", complete = true)
      flow.emit("delta", text = "Hello", complete = false)
      assertEquals("Hello world", flow.state.streamText)
      flow.emit("delta", text = " world!", complete = false)
      assertEquals("Hello world!", flow.state.streamText)
      assertEquals("Hello world", reconcileWearStreamSnapshot("Hello world", "Hello", liveComplete = true))
      assertEquals("Hello world", reconcileWearStreamSnapshot("Hello world", "", liveComplete = true))
    }

  @Test
  fun historyCannotResurrectATerminatedRunButCanRevealANewerRun() =
    withFlow { flow ->
      flow.send()
      flow.emit("error")
      val ended = flow.state
      val stale = flow.transcript(activeRunId = flow.runId, text = "stale text")
      val reconciled = ended.copy(activeRunId = stale.activeRunId, streamText = stale.activeText).reconcileReplyHistory(stale)
      assertNull(reconciled.activeRunId)
      assertNull(reconciled.streamText)
      assertEquals(ended.replyTerminal, reconciled.replyTerminal)
      val newer = flow.transcript(activeRunId = "newer-run", text = "new text")
      val newRun = ended.copy(activeRunId = newer.activeRunId, streamText = newer.activeText).reconcileReplyHistory(newer)
      assertEquals("newer-run", newRun.activeRunId)
      assertEquals("new text", newRun.streamText)
      assertNull(newRun.replyTerminal)
      val anonymous = flow.transcript(activeRunId = null, text = "anonymous text")
      assertNull(ended.copy(streamText = anonymous.activeText).reconcileReplyHistory(anonymous).replyTerminal)
      assertNull(ended.resetForPhoneChange().replyTerminal)
      assertNull(ended.switchSessionContext(checkNotNull(ended.selectedSession).copy(key = "other")).replyTerminal)
      assertNull(ended.switchAgentContext("other").replyTerminal)
    }

  @Test
  fun canonicalOwnedAssistantCanSettleWhenATerminalWasMissed() =
    withFlow { flow ->
      flow.send()
      val reply = WearChatMessage("reply", "assistant", "Done", 1L, idempotencyKey = flow.runId)
      val transcript = flow.transcript().copy(messages = listOf(reply))
      assertNull(
        flow.state
          .copy(messages = listOf(reply))
          .reconcileReplyHistory(transcript)
          .pendingReply,
      )
      assertNotNull(flow.state.reconcileReplyHistory(flow.transcript()).pendingReply)
    }

  @Test
  fun completedRunMustNotSuppressLaterTerminalOnlyError() =
    withFlow { flow ->
      flow.emit("final", eventRunId = "completed-a")
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      val historyBefore = flow.historyRequests
      flow.emit("error", eventRunId = "external-b")
      assertEquals("A completed run does not own future terminal-only events", WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals("external-b", flow.state.replyTerminal?.runId)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertEquals(historyBefore + 1, flow.historyRequests)
    }

  @Test
  fun completedErrorMustClearWhenAnotherTerminalOnlyReplyCompletes() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      val historyBefore = flow.historyRequests
      flow.historyMessages = """[{"id":"canonical-b","role":"assistant","content":"Later reply"}]"""
      flow.emit("final", eventRunId = "external-b")
      assertNull("Error from the prior completed run must not poison a later successful reply", flow.state.conversationFailure)
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertEquals("external-b", flow.state.replyTerminal?.runId)
      assertEquals(historyBefore + 1, flow.historyRequests)
      assertEquals(
        "Later reply",
        flow.state.messages
          .single()
          .text,
      )
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.conversationFailure)
    }

  @Test
  fun laterTerminalOnlyAbortReloadsCanonicalHistoryWithoutANewMessage() =
    withFlow { flow ->
      flow.emit("final", eventRunId = "completed-a")
      val historyBefore = flow.historyRequests
      flow.emit("aborted", eventRunId = "external-b")
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyTerminal?.outcome)
      assertEquals("external-b", flow.state.replyTerminal?.runId)
      assertEquals(historyBefore + 1, flow.historyRequests)
      assertNull(flow.state.conversationFailure)
    }

  @Test
  fun laterFinalMessageStillReloadsTheRestOfTheCanonicalTranscript() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      val historyBefore = flow.historyRequests
      flow.historyMessages = """[{"id":"question-b","role":"user","content":"Question from phone"}]"""
      flow.emit(
        "final",
        eventRunId = "external-b",
        message =
          buildJsonObject {
            put("id", "reply-b")
            put("role", "assistant")
            put("content", "New reply")
          },
      )
      assertNull(flow.state.conversationFailure)
      assertEquals(historyBefore + 1, flow.historyRequests)
      assertEquals(listOf("Question from phone", "New reply"), flow.state.messages.map { it.text })
    }

  @Test
  fun delayedForeignTerminalCannotSettleANewPendingReplyAfterACompletedRun() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      flow.sendGate = CompletableDeferred()
      flow.send()
      val pending = checkNotNull(flow.state.pendingReply)
      val historyBefore = flow.historyRequests
      for (terminal in listOf("final", "error", "aborted")) {
        flow.emit(terminal, eventRunId = "completed-a")
        assertEquals(pending, flow.state.pendingReply)
        assertTrue(flow.state.sending)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
        assertEquals(historyBefore, flow.historyRequests)
      }
      flow.sendGate?.complete(Unit)
      flow.idle()
      flow.emit("final")
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertNull(flow.state.pendingReply)
    }

  @Test
  fun completedOutcomeStillRejectsStaleSequenceEpochPhoneAndSessionEvents() =
    withFlow { flow ->
      flow.emit("aborted", eventRunId = "completed-a")
      val completed = flow.state.replyTerminal
      flow.emit("error", eventRunId = "older-run", eventSequence = 1)
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("error", eventRunId = "older-run", eventStreamId = "old-epoch")
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("error", eventRunId = "other-phone-run", sourceNodeId = "phone-b", eventSequence = 3)
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("error", eventRunId = "other-session-run", sessionKey = "agent:main:other", eventSequence = 3)
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("final", eventRunId = "later-run")
      assertEquals("later-run", flow.state.replyTerminal?.runId)
      assertNull(flow.state.conversationFailure)
    }

  @Test
  fun matchingErrorAfterAnonymousDeltaSettles() =
    withFlow { flow ->
      flow.send()
      assertNotNull(flow.state.pendingReply)
      flow.emit("delta", eventRunId = null, text = "Anonymous partial reply", complete = false)
      assertNull(flow.state.activeRunId)
      assertNotNull(flow.state.streamText)
      val before = flow.historyRequests
      flow.emit("error")
      assertEquals(before + 1, flow.historyRequests)
      assertNull(flow.state.activeRunId)
      assertNull(flow.state.streamText)
      assertTrue(flow.state.messages.isEmpty())
      assertNull("Matching terminal and inactive canonical history must settle the pending reply", flow.state.pendingReply)
    }

  @Test
  fun matchingAbortedAfterAnonymousDeltaSettles() =
    withFlow { flow ->
      flow.send()
      assertNotNull(flow.state.pendingReply)
      flow.emit("delta", eventRunId = null, text = "Anonymous partial reply", complete = false)
      assertNull(flow.state.activeRunId)
      assertNotNull(flow.state.streamText)
      val before = flow.historyRequests
      flow.emit("aborted")
      assertEquals(before + 1, flow.historyRequests)
      assertNull(flow.state.activeRunId)
      assertNull(flow.state.streamText)
      assertTrue(flow.state.messages.isEmpty())
      assertNull("Matching terminal and inactive canonical history must settle the pending reply", flow.state.pendingReply)
    }

  @Test
  fun matchingTerminalWaitsForInactiveCanonicalHistory() =
    withFlow { flow ->
      flow.send()
      flow.emit("delta", eventRunId = null, text = "Anonymous reply")
      flow.historyGate = CompletableDeferred()
      flow.emit("error")
      assertNotNull(flow.state.pendingReply)
      assertEquals("Anonymous reply", flow.state.streamText)
      assertNull(flow.state.replyTerminal)
      assertNull(flow.state.conversationFailure)
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.streamText)
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.vm.refresh()
      flow.idle()
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun matchingTerminalDoesNotClearAnActiveHistorySnapshot() {
    for (run in listOf(null, "pending", "newer-run")) {
      for (text in listOf("New live reply", "")) {
        withFlow { flow ->
          flow.send()
          flow.emit("delta", eventRunId = null, text = "Anonymous reply")
          val activeRun = if (run == "pending") flow.runId else run
          flow.historyRun =
            buildJsonObject {
              activeRun?.let { put("runId", it) }
              put("text", text)
            }
          flow.emit("error")
          assertEquals(activeRun, flow.state.activeRunId)
          assertEquals(text, flow.state.streamText)
          assertNull(flow.state.replyTerminal)
          assertNull(flow.state.conversationFailure)
        }
      }
    }
  }

  @Test
  fun laterDeltasInvalidateATerminalAwaitingHistory() {
    for (run in listOf(null, "pending", "newer-run")) {
      withFlow { flow ->
        flow.send()
        flow.emit("delta", eventRunId = null, text = "Anonymous reply")
        flow.historyGate = CompletableDeferred()
        flow.emit("error")
        flow.emit("delta", eventRunId = if (run == "pending") flow.runId else run, text = "New live reply")
        flow.historyGate?.complete(Unit)
        flow.idle()
        assertEquals("New live reply", flow.state.streamText)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
        flow.vm.refresh()
        flow.idle()
        assertNull("A later inactive snapshot cannot revive the superseded terminal", flow.state.replyTerminal)
      }
    }
  }

  @Test
  fun sequenceAndEpochResyncDiscardATerminalAwaitingHistory() {
    for (changedEpoch in listOf(false, true)) {
      withFlow { flow ->
        flow.send()
        flow.emit("delta", eventRunId = null, text = "Anonymous reply")
        flow.historyGate = CompletableDeferred()
        flow.emit("error")
        flow.emit("error", eventRunId = "unrelated", eventSequence = if (changedEpoch) 3 else 4, eventStreamId = if (changedEpoch) "old-epoch" else "epoch-a")
        flow.historyGate?.complete(Unit)
        flow.idle()
        assertNotNull(flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
      }
    }
  }

  @Test
  fun foreignAndRunlessTerminalsCannotSettleAnAnonymousPendingStream() {
    for (run in listOf(null, "foreign-run")) {
      for (terminal in listOf("final", "error", "aborted")) {
        withFlow { flow ->
          flow.send()
          val pending = flow.state.pendingReply
          flow.emit("delta", eventRunId = null, text = "Anonymous reply")
          flow.emit(terminal, eventRunId = run)
          assertEquals(pending, flow.state.pendingReply)
          assertNull(flow.state.replyTerminal)
          assertNull(flow.state.conversationFailure)
        }
      }
    }
  }

  @Test
  fun matchingTerminalSurvivesAFailedHistoryRefresh() =
    withFlow { flow ->
      flow.send()
      flow.emit("delta", eventRunId = null, text = "Anonymous reply")
      flow.historyFails = true
      flow.emit("aborted")
      assertNotNull(flow.state.pendingReply)
      assertNull(flow.state.replyTerminal)
      flow.historyFails = false
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.conversationFailure)
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun newerCanonicalReplySupersedesACompletedErrorWithoutALiveEvent() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = """[{"id":"reply-b","role":"assistant","content":"Later successful reply"}]"""
      flow.vm.refresh()
      flow.idle()
      assertEquals(listOf("Later successful reply"), flow.state.messages.map { it.text })
      assertNull("Canonical evidence of a newer reply must clear the completed error", flow.state.conversationFailure)
      assertNull(flow.state.replyTerminal)
    }

  @Test
  fun terminalOnlyFinalWaitsForHistoryToResolveItsSpeakableReply() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"reply","role":"assistant","content":"Ready to speak","idempotencyKey":"${flow.runId}"}]"""
      flow.historyGate = CompletableDeferred()
      flow.emit("final")
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertNull("The UI must not conclude there is no reply while history is pending", flow.state.replyTerminal?.history)
      assertTrue(flow.state.messages.isEmpty())
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNotNull(flow.state.replyTerminal?.history)
      assertEquals(listOf("Ready to speak"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun terminalOnlyFinalCanFinishAfterHistoryConfirmsNoAssistantReply() =
    withFlow { flow ->
      flow.send()
      flow.historyGate = CompletableDeferred()
      flow.emit("final")
      assertNull(flow.state.replyTerminal?.history)
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNotNull(flow.state.replyTerminal?.history)
      assertTrue(flow.state.messages.isEmpty())
      assertNull(flow.state.pendingReply)
    }

  @Test
  fun emptyHistoryDoesNotForgetTheCompletedOutcomesAssistantBoundary() =
    withFlow { flow ->
      val originalHistory = """[{"id":"old-reply","role":"assistant","content":"Previous reply"}]"""
      flow.historyMessages = originalHistory
      flow.emit("error", eventRunId = "failed-run")
      flow.historyMessages = "[]"
      flow.vm.refresh()
      flow.idle()
      flow.historyMessages = originalHistory
      flow.vm.refresh()
      flow.idle()
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
    }

  @Test
  fun terminalOnlyReplyCompletionNeverSelectsAPreservedForeignFinal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.emit(
        "final",
        eventRunId = "foreign-run",
        message =
          buildJsonObject {
            put("id", "foreign-message")
            put("role", "assistant")
            put("content", "Foreign reply")
          },
      )
      assertEquals(listOf("Foreign reply"), flow.state.messages.map { it.text })
      assertTrue(flow.completedReplies.isEmpty())
      flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"}]"""
      flow.historyGate = CompletableDeferred()
      flow.emit("final")
      assertTrue("The real completion effect must await canonical history, not select the foreign final", flow.completedReplies.isEmpty())
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun foreignCanonicalHistoryCannotCompleteANewerPendingReply() =
    withFlow { flow ->
      flow.sendGate = CompletableDeferred()
      flow.send()
      flow.observeReplyCompletion()
      flow.emit(
        "final",
        eventRunId = "foreign-run",
        message =
          buildJsonObject {
            put("id", "foreign-message")
            put("role", "assistant")
            put("content", "Foreign reply")
            put("idempotencyKey", "foreign-run")
          },
      )
      flow.historyMessages = """[{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
      flow.sendGate?.complete(Unit)
      flow.idle()
      assertNotNull("A foreign assistant in the send acknowledgment snapshot cannot settle this reply", flow.state.pendingReply)
      assertTrue(flow.completedReplies.isEmpty())
      flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun uncorrelatedCanonicalHistoryCannotCompleteAPendingReply() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"unrelated","role":"assistant","content":"Uncorrelated reply"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNotNull("Changed assistant content alone does not identify the pending run", flow.state.pendingReply)
      assertTrue(flow.completedReplies.isEmpty())
      flow.emit("aborted")
      assertNull(flow.state.pendingReply)
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun terminalErrorCompletionWaitsForCanonicalHistory() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"own-partial","role":"assistant","content":"Own partial reply","idempotencyKey":"${flow.runId}"}]"""
      flow.historyGate = CompletableDeferred()
      flow.emit("error")
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertTrue("Terminal-derived errors must not bypass canonical history completion", flow.completedReplies.isEmpty())
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertEquals(listOf("Own partial reply"), flow.completedReplies.map { it?.text })
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
    }

  @Test
  fun rewrittenAssistantBoundaryDoesNotClearACompletedError() =
    withFlow { flow ->
      flow.historyMessages = """[{"id":"reply-a","role":"assistant","content":"Initial content","timestamp":1}]"""
      flow.emit("error", eventRunId = "failed-run")
      flow.historyMessages = """[{"id":"reply-a","role":"assistant","content":"Rewritten content","timestamp":1}]"""
      flow.vm.refresh()
      flow.idle()
      assertEquals("An in-place rewrite is not a later reply", WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = """[{"id":"reply-a","role":"assistant","content":"Rewritten content","timestamp":1},{"id":"reply-b","role":"assistant","content":"Rewritten content","timestamp":1}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull("A distinct later message remains a newer reply even when its text and timestamp are equal", flow.state.replyTerminal)
    }

  @Test
  fun terminalOnlyCompletionDoesNotSpeakForeignCanonicalHistory() {
    for (terminal in listOf("final", "error", "aborted")) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        flow.emit(
          "final",
          eventRunId = "foreign-run",
          message =
            buildJsonObject {
              put("id", "foreign-message")
              put("role", "assistant")
              put("content", "Foreign reply")
              put("idempotencyKey", "foreign-run")
            },
        )
        flow.historyMessages = """[{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
        flow.emit(terminal)
        assertNull(flow.state.pendingReply)
        assertEquals("A terminal with no owned assistant settles without selecting foreign text", listOf<WearChatMessage?>(null), flow.completedReplies)
      }
    }
  }

  @Test
  fun terminalCompletionSelectsItsOwnedReplyBeforeAForeignCanonicalTail() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"owned","role":"assistant","content":"Owned reply","idempotencyKey":"${flow.runId}"},{"id":"foreign","role":"assistant","content":"Foreign tail","idempotencyKey":"foreign-run"}]"""
      flow.emit("final")
      assertEquals(listOf("Owned reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun identifiedFinalMessageRemainsOwnedWithoutAHistoryKey() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.emit(
        "final",
        message =
          buildJsonObject {
            put("id", "owned-event")
            put("role", "assistant")
            put("content", "Owned event reply")
          },
      )
      assertEquals(listOf("Owned event reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun ownedCanonicalHistoryBeforeForeignTailSettlesAMissedTerminal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Owned reply","idempotencyKey":"${flow.runId}"},{"id":"foreign","role":"assistant","content":"Foreign tail","idempotencyKey":"foreign-run"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull("The owned assistant exists even when it is not the latest transcript entry", flow.state.pendingReply)
      assertEquals(listOf("Owned reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun shorterNonemptyHistoryCannotSupersedeACompletedError() =
    withFlow { flow ->
      flow.historyMessages = """[{"id":"older","role":"assistant","content":"Older reply","timestamp":1},{"id":"boundary","role":"assistant","content":"Boundary reply","timestamp":2}]"""
      flow.emit("error", eventRunId = "failed-run")
      flow.historyMessages = """[{"id":"older","role":"assistant","content":"Older reply","timestamp":1}]"""
      flow.vm.refresh()
      flow.idle()
      assertEquals("Deleting the tail does not prove a later reply", WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = """[{"id":"newer","role":"assistant","content":"Newer reply","timestamp":3}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull("A timestamp after the missing boundary still proves a later reply", flow.state.replyTerminal)
    }

  @Test
  fun settledFallbackHistoryBeforeForeignTailSettlesAMissedTerminal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:settled-finalization-fallback"},{"id":"foreign","role":"assistant","content":"Foreign fallback","idempotencyKey":"foreign-run:settled-finalization-fallback"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertEquals(
        "${flow.runId}:settled-finalization-fallback",
        flow.state.replyTerminal
          ?.message
          ?.idempotencyKey,
      )
      assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun settledFallbackTerminalCompletionSelectsOwnedTextBeforeForeignTail() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:settled-finalization-fallback"},{"id":"foreign","role":"assistant","content":"Foreign fallback","idempotencyKey":"foreign-run:settled-finalization-fallback"}]"""
      flow.emit("final")
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun foreignAndUnrecognizedFallbackKeysCannotRecoverAMissedTerminal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      for (key in listOf(
        "foreign-run:settled-finalization-fallback",
        "${flow.runId}-other:settled-finalization-fallback",
        "prefix-${flow.runId}:settled-finalization-fallback",
        "${flow.runId}:settled-finalization-fallback:extra",
        "${flow.runId}:other-fallback",
        "${flow.runId}:settled-finalization",
      )) {
        flow.historyMessages = """[{"id":"unowned","role":"assistant","content":"Unowned reply","idempotencyKey":"$key"}]"""
        flow.vm.refresh()
        flow.idle()
        assertNotNull("Only the exact runtime-owned key may settle this reply: $key", flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
        assertTrue(flow.completedReplies.isEmpty())
      }
      flow.historyMessages = """[{"id":"bare","role":"assistant","content":"Bare-key reply","idempotencyKey":"${flow.runId}"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Bare-key reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun nonAssistantFallbackKeysCannotRecoverAMissedTerminal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      for (role in listOf("user", "system")) {
        flow.historyMessages = """[{"id":"non-assistant","role":"$role","content":"Not an assistant reply","idempotencyKey":"${flow.runId}:settled-finalization-fallback"}]"""
        flow.vm.refresh()
        flow.idle()
        assertNotNull(flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
        assertTrue(flow.completedReplies.isEmpty())
      }
    }

  @Test
  fun settledFallbackHistoryDoesNotClearAnActiveHistorySnapshot() {
    for (run in listOf(null, "pending", "newer-run")) {
      for (text in listOf("New live reply", "")) {
        withFlow { flow ->
          flow.send()
          flow.observeReplyCompletion()
          flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:settled-finalization-fallback"}]"""
          val activeRun = if (run == "pending") flow.runId else run
          flow.historyRun =
            buildJsonObject {
              activeRun?.let { put("runId", it) }
              put("text", text)
            }
          flow.vm.refresh()
          flow.idle()
          assertEquals(activeRun, flow.state.activeRunId)
          assertEquals(text, flow.state.streamText)
          assertNull(flow.state.replyTerminal)
          assertTrue(flow.completedReplies.isEmpty())
        }
      }
    }
  }

  @Test
  fun settledFallbackHistoryWaitsForAConcurrentAnonymousDelta() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:settled-finalization-fallback"}]"""
      flow.historyGate = CompletableDeferred()
      flow.vm.refresh()
      flow.idle()
      flow.emit("delta", eventRunId = null, text = "Unknown live reply")
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNotNull(flow.state.pendingReply)
      assertEquals("Unknown live reply", flow.state.streamText)
      assertNull(flow.state.replyTerminal)
      assertTrue(flow.completedReplies.isEmpty())
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
    }

  private fun withFlow(block: (Flow) -> Unit) {
    val flow = Flow()
    try {
      block(flow)
    } finally {
      flow.close()
    }
  }

  private class Flow {
    private val app = RuntimeEnvironment.getApplication() as WearApplication
    private val owner =
      object : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
      }
    private val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
    private val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
    private val previousClient = clientField.get(app)
    private val previousRepository = repositoryField.get(app)
    private var sequence = 0L
    var runId = "stream-run"
    var historyRequests = 0
    var historyMessages = "[]"
    var historyRun: JsonObject? = null
    var historyGate: CompletableDeferred<Unit>? = null
    var historyFails = false
    var sendGate: CompletableDeferred<Unit>? = null
    val completedReplies = mutableListOf<WearChatMessage?>()
    private var replyObserver: ActivityController<ComponentActivity>? = null
    private val client =
      WearProxyClient.createForTests(
        nodeResolver = WearNodeResolver { "phone-a" },
        transport = WearMessageTransport { _, _, bytes -> respond(bytes) },
      )
    val vm: WearViewModel
    val state: WearUiState get() = vm.state.value

    init {
      clientField.set(app, lazyOf(client))
      repositoryField.set(app, lazyOf(WearGatewayRepository(client)))
      vm = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory(app))[WearViewModel::class.java]
      idle()
      assertTrue(state.connected)
    }

    fun send() {
      vm.sendReply("Hello")
      idle()
    }

    fun idle() = shadowOf(Looper.getMainLooper()).idle()

    fun observeReplyCompletion() {
      val sessionKey = state.selectedSession?.key
      val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
      replyObserver = controller
      controller.get().setContent {
        val current by vm.state.collectAsState()
        var awaiting by remember { mutableStateOf(true) }
        WearReplyCompletionEffect(
          state = current,
          snapshot = current.toConversationSnapshot(),
          awaitingReply = awaiting,
          awaitingReplySessionId = sessionKey,
          expectedAssistantKey = null,
        ) { reply ->
          completedReplies += reply
          awaiting = false
        }
      }
      idle()
    }

    fun transcript(
      activeRunId: String? = null,
      text: String? = null,
    ) = WearTranscript(
      sessionKey = "agent:main:proof",
      messages = emptyList(),
      activeRunId = activeRunId,
      activeText = text,
      selectedModelRef = "openai/gpt-4o",
      eventSequence = sequence,
      phoneNodeId = "phone-a",
      eventStreamId = "epoch-a",
    )

    private suspend fun respond(bytes: ByteArray) {
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val responseSequence = sequence
      val historyError = request.method == WearRpcMethod.ChatHistory && historyFails
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            Json.parseToJsonElement("""{"connected":true,"activeAgentId":"main","activeSessionKey":"agent:main:proof"}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:proof","displayName":"Test chat","hasActiveRun":false}]}""")
          }

          WearRpcMethod.ChatHistory -> {
            historyRequests += 1
            val snapshot =
              buildJsonObject {
                put("sessionKey", "agent:main:proof")
                put("messages", Json.parseToJsonElement(historyMessages))
                historyRun?.let { put("inFlightRun", it) }
              }
            historyGate?.await()
            snapshot
          }

          WearRpcMethod.ChatSend -> {
            runId =
              request.params
                .getValue("idempotencyKey")
                .jsonPrimitive.content
            sendGate?.await()
            buildJsonObject {
              put("runId", runId)
              put("status", "started")
            }
          }

          else -> {
            error("Unexpected " + request.method)
          }
        }
      client.handleMessage(
        "phone-a",
        WearProtocol.RESPONSE_PATH,
        WearProtocolCodec.encode(
          WearMessage.Response(
            requestId = request.requestId,
            ok = !historyError,
            result = result.takeUnless { historyError },
            error = WearRpcError("internal_error", "History unavailable").takeIf { historyError },
            eventStreamId = "epoch-a",
            eventSequence = responseSequence,
          ),
        ),
      )
    }

    fun emit(
      state: String,
      eventRunId: String? = runId,
      text: String? = null,
      complete: Boolean = true,
      message: JsonObject? = null,
      eventSequence: Long = sequence + 1,
      eventStreamId: String = "epoch-a",
      sourceNodeId: String = "phone-a",
      sessionKey: String = "agent:main:proof",
    ) {
      sequence = maxOf(sequence, eventSequence)
      val payload: JsonObject =
        buildJsonObject {
          put("sessionKey", sessionKey)
          eventRunId?.let { put("runId", it) }
          put("state", state)
          message?.let { put("message", it) }
          text?.let {
            put("streamText", it)
            put("streamTextComplete", complete)
          }
        }
      runBlocking {
        client.handleMessage(
          sourceNodeId,
          WearProtocol.EVENT_PATH,
          WearProtocolCodec.encode(
            WearMessage.Event(sequence = eventSequence, event = WearEventType.Chat, payload = payload, streamId = eventStreamId),
          ),
        )
      }
      idle()
    }

    fun close() {
      replyObserver?.pause()?.stop()?.destroy()
      owner.viewModelStore.clear()
      idle()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }
}
