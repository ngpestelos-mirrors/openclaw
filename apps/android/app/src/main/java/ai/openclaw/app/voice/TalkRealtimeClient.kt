package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val TRANSCRIPT_REQUEST_TIMEOUT_MS = 10_000L

internal data class TalkRealtimeSnapshot(
  val provider: String,
  val model: String?,
  val authMethod: String?,
  val voice: String?,
  val transport: String,
)

/** One client-owned call, with captured gateway identity and no saved model/auth defaults. */
internal class TalkRealtimeClient(
  context: Context,
  scope: CoroutineScope,
  lease: GatewaySession.RequestLease,
  sessionKey: String,
  private val agent: RealtimeAgentCoordinator,
  private val isCurrent: () -> Boolean,
  agentId: String? = null,
  private val supportsCamera: Boolean = false,
  private val onStatus: (String) -> Unit,
  private val onTranscript: (String, String, Boolean) -> Unit,
  private val onFailure: (String) -> Unit,
  private val onRecoverableError: (String) -> Unit,
  preferredAudioInputDevice: () -> String? = { null },
  onInputRequested: (String?) -> Unit = {},
  private val wireTarget: TalkWireTarget = TalkWireTarget(lease, sessionKey, agentId),
  private val withAdmission: (() -> Unit) -> Unit,
) {
  // NodeRuntime owns an IO scope; all client response/lifecycle state belongs to Main.
  private val scope = CoroutineScope(scope.coroutineContext + Dispatchers.Main.immediate)
  private val json = Json { ignoreUnknownKeys = true }
  private val callLifecycleLock = Any()

  @Volatile private var closed = false
  private var closing: Deferred<Unit>? = null
  private var started = false
  private val responseState = TalkRealtimeResponseState()
  private var voiceSessionId: String? = null
  private var gatewayTranscripts = false
  private var camera: ai.openclaw.app.node.TalkCameraPreview? = null
  private var cameraOperation = 0L
  val cameraCallId: String? get() = voiceSessionId.takeIf { started && supportsCamera && !closed }

  private enum class OutputControl { Ga, Frameless }

  private var outputControl: OutputControl? = null
  private var nativeTranscriptSequence = 0
  private var clientEventSequence = 0
  private var outputResponseId: String? = null
  private var transcriptTail: Deferred<Unit> = CompletableDeferred(Unit)
  private val transcriptOwner = Job(this.scope.coroutineContext[Job])
  private val transcriptScope = CoroutineScope(this.scope.coroutineContext + transcriptOwner)
  private var transcriptFailureReported = false
  private val transcriptOrder: TalkRealtimeTranscriptOrder by lazy {
    TalkRealtimeTranscriptOrder { itemId, role, entryId, text, afterPrevious, written ->
      enqueueTranscript(role, entryId, text, afterPrevious, written) { transcriptOrder.release(itemId) }
    }
  }
  private val toolBatch = TalkRealtimeToolBatch()
  private val cancelledResponses = mutableSetOf<String>()

  private data class CompletedToolCall(
    val id: String,
    val name: String,
    val args: JsonElement,
  )

  private val completedResponses = mutableSetOf<String>()
  private val finalTranscripts = mutableSetOf<String>()
  private val peer = TalkRealtimePeer(context, scope, ::handleProviderEvent, ::fail, preferredAudioInputDevice, onInputRequested)
  var snapshot: TalkRealtimeSnapshot? = null
    private set

  private fun clientTransport() =
    RealtimeAgentClientTransport(
      request = { method, args, timeout ->
        // Only new agent work is fenced at the synchronous final enqueue after
        // transcript/transport waits. chat.abort/close cleanup stays unguarded.
        val guard: ((() -> Unit) -> Unit) =
          if (method != "chat.abort") {
            ::withCurrentCall
          } else {
            { it() }
          }
        if (method == "talk.client.toolCall") transcriptTail.await()
        wireTarget.request(method, args, timeout, guard)
      },
      submit = ::submitToolResult,
    )

  /** Physical connection -> parent selection/capture admission -> logical call retirement. */
  private fun withCurrentCall(enqueue: () -> Unit) =
    withAdmission {
      synchronized(callLifecycleLock) {
        // A currency callback can itself retire the call; read closed after that callback.
        if (!isCurrent() || closed) throw GatewayRequestNotEnqueued("realtime call stopped")
        enqueue()
      }
    }

  private fun retire(): Boolean =
    synchronized(callLifecycleLock) {
      if (closed) {
        false
      } else {
        closed = true
        true
      }
    }

  /** The caller publishes under its lock; rejected ownership closes outside that lock. */
  suspend fun adopt(publish: () -> Boolean): Boolean {
    val admitted =
      try {
        publish()
      } catch (error: Throwable) {
        close()
        throw error
      }
    if (!admitted) close()
    return admitted
  }

  suspend fun start() =
    withContext(Dispatchers.Main.immediate) {
      check(!closed && isCurrent()) { "Realtime call stopped" }
      val params =
        buildJsonObject {
          put("mode", "realtime")
          put("transport", "webrtc")
          put("brain", "agent-consult")
          put(
            "capabilities",
            JsonArray(
              buildList {
                add(JsonPrimitive("voice-transcript"))
                if (supportsCamera) add(JsonPrimitive("camera-frame"))
              },
            ),
          )
        }
      // An accepted create can finish after Stop; retain its bounded ACK so its allocation is closed.
      val payload =
        withContext(NonCancellable) {
          wireTarget.request("talk.client.create", params.toString(), 30_000, ::withCurrentCall)
        }
      val result = json.parseToJsonElement(payload) as? JsonObject ?: error("Invalid realtime session")
      voiceSessionId = result.string("voiceSessionId") ?: error("Gateway returned no voice session")
      try {
        check(!closed && isCurrent() && wireTarget.lease.isCurrent()) { "Realtime call stopped during setup" }
        check(result.string("transport") == "webrtc") { "Gateway returned an unsupported Talk transport" }
        check(result["clientControl"] == null) { "Client-owned Talk control was not negotiated" }
        gatewayTranscripts = result.string("transcriptOwner") == "gateway"
        outputControl =
          when (result.string("controlSource")) {
            "delegation" -> OutputControl.Frameless
            "transcript" -> OutputControl.Ga
            else -> null
          }
        val resolvedSnapshot =
          TalkRealtimeSnapshot(
            provider = result.string("provider") ?: error("Gateway returned no Talk provider"),
            model = result.string("model"),
            authMethod = result.string("authMethod"),
            voice = result.string("voice"),
            transport = "webrtc",
          )
        val secret = result.string("clientSecret") ?: error("Gateway returned no offer capability")
        val offerUrl = result.string("offerUrl") ?: error("Gateway returned no offer URL")
        val headers =
          (result["offerHeaders"] as? JsonObject)
            ?.mapValues { (_, value) ->
              (value as? JsonPrimitive)?.content ?: error("Invalid offer header")
            }.orEmpty()
        val route = wireTarget.lease.realtimeOfferRoute(offerUrl)
        val voiceId = checkNotNull(voiceSessionId)
        agent.beginSession(
          RealtimeAgentSession(
            voiceId,
            wireTarget.sessionKey,
            clientTransport(),
            agentId = wireTarget.agentId,
          ),
        )
        peer.start(::withCurrentCall) { offer -> route.exchange(secret, headers, offer, ::withCurrentCall) }
        check(!closed && isCurrent() && wireTarget.lease.isCurrent()) { "Realtime call replaced during setup" }
        if (!closed) {
          started = true
          snapshot = resolvedSnapshot
          onStatus("Listening")
        }
      } catch (error: Throwable) {
        withContext(NonCancellable) { close() }
        throw error
      }
    }

  private fun handleProviderEvent(payload: String) {
    if (!wireTarget.lease.isCurrent() || (closed && closing?.isCompleted != false) || (!closed && !isCurrent())) return
    val event = runCatching { json.parseToJsonElement(payload) as? JsonObject }.getOrNull() ?: return fail("Invalid realtime event")
    // Physical close drains accepted speech to its original target, but retired callbacks
    // must never start tools on the manager's replacement coordinator session.
    if (closed && event.string("type") !in
      setOf(
        "input_audio_buffer.committed",
        "conversation.item.added",
        "conversation.item.created",
        "conversation.item.done",
        "response.output_item.done",
        "conversation.item.input_audio_transcription.completed",
        "response.output_audio_transcript.done",
        "response.audio_transcript.done",
        "response.output_text.done",
        "turn.done",
        "conversation.item.input_audio_transcription.failed",
      )
    ) {
      return
    }
    // Older Gateways omit controlSource. Only discriminating wire events establish
    // control semantics; session.updated is shared and cannot prove GA support.
    if (outputControl == null) {
      outputControl =
        when (event.string("type")) {
          "session.started", "turn.done", "input_transcript.added", "output_transcript.added", "delegation.created", "output_audio.delta" -> OutputControl.Frameless
          "session.created", "response.created" -> OutputControl.Ga
          else -> null
        }
    }
    if (event.string("response_id") in cancelledResponses && event.string("type")?.contains("transcript") == true) return
    val itemId = event.string("item_id")
    when (event.string("type")) {
      "input_audio_buffer.committed" -> {
        val id = itemId ?: return fail("Realtime transcript item has no identity")
        reserveTranscript(id, event.string("previous_item_id"), "user", event.containsKey("previous_item_id"))
      }

      "conversation.item.added", "conversation.item.created" -> {
        val item = event["item"] as? JsonObject ?: return
        val id = item.string("id") ?: return
        val role =
          when {
            item.string("type") != "message" -> null

            item.string("role") == "assistant" -> "assistant"

            item.string("role") == "user" &&
              ((item["content"] as? JsonArray)?.any { (it as? JsonObject)?.string("type") == "input_audio" } == true) -> "user"

            else -> null
          }
        reserveTranscript(id, event.string("previous_item_id"), role, event.containsKey("previous_item_id"))
      }

      "conversation.item.done", "response.output_item.done" -> {
        val item = event["item"] as? JsonObject
        if (item?.string("type") == "message" && item.string("role") == "assistant") {
          item.string("id")?.let(transcriptOrder::settle)
        }
      }

      "conversation.item.input_audio_transcription.completed" -> {
        transcript("user", event.string("transcript"), itemId, true)
      }

      "response.output_audio_transcript.delta", "response.audio_transcript.delta", "response.output_text.delta" -> {
        transcript("assistant", event.string("delta"), itemId, false)
      }

      "response.output_audio_transcript.done", "response.audio_transcript.done", "response.output_text.done" -> {
        transcript("assistant", event.string("transcript") ?: event.string("text"), itemId, true)
      }

      "input_transcript.added", "output_transcript.added" -> {
        val item = event["item"] as? JsonObject
        transcript(if (event.string("type") == "input_transcript.added") "user" else "assistant", item?.string("text"), item?.string("id"), false)
      }

      "turn.done" -> {
        val turn = event["turn"] as? JsonObject ?: return
        // Frameless Bidi does not require a turn id. The reliable data channel owns
        // delivery order; retain one local id for each queued persistence operation.
        val entryId = "native-${++nativeTranscriptSequence}"
        transcriptFrameless(turn.string("role") ?: return, turn.string("transcript"), entryId)
      }

      "input_audio_buffer.speech_started" -> {
        onStatus("Listening")
      }

      "input_audio_buffer.speech_stopped" -> {
        // The Gateway GA policy enables VAD-created responses; they have the same
        // pre-acknowledgement cancellation window as an explicit response.create.
        responseState.requesting()
        onStatus("Thinking")
      }

      "output_audio_buffer.started" -> {
        outputResponseId = event.string("response_id") ?: return fail("Missing realtime output response id")
        onStatus("Speaking")
      }

      "output_audio_buffer.stopped", "output_audio_buffer.cleared" -> {
        if (event.string("response_id") == outputResponseId) outputResponseId = null
        publishResponseStatus()
      }

      "response.created" -> {
        val id = (event["response"] as? JsonObject)?.string("id") ?: return fail("Missing realtime response id")
        if (id.length > TALK_REALTIME_MAX_ID_CHARS) return fail("Realtime call identity limit exceeded")
        if (id in completedResponses) return
        val cancelled = responseState.created(id)
        if (cancelled != null) {
          scope.launch { cancelResponse(cancelled) }
        } else {
          onStatus("Thinking")
        }
      }

      "response.done" -> {
        val response = event["response"] as? JsonObject ?: return fail("Invalid realtime response")
        val id = response.string("id") ?: return fail("Missing realtime response id")
        if (!remember(completedResponses, id)) return
        responseState.completed(id)
        when {
          response.string("status") == "completed" && id !in cancelledResponses -> {
            val calls = mutableListOf<CompletedToolCall>()
            for (value in response["output"] as? JsonArray ?: JsonArray(emptyList())) {
              val item = value as? JsonObject ?: continue
              if (item.string("type") != "function_call" || item.string("status")?.let { it != "completed" } == true) continue
              val callId = item.string("call_id") ?: continue
              val name = item.string("name") ?: continue
              val arguments = item.string("arguments") ?: continue
              if (arguments.toByteArray().size > 256_000) return fail("Realtime tool arguments exceed limit")
              val args = runCatching { json.parseToJsonElement(arguments) }.getOrNull() ?: return fail("Invalid realtime tool arguments")
              calls.add(CompletedToolCall(callId, name, args))
            }
            val admitted = runCatching { toolBatch.admit(calls.map { it.id }).toMutableSet() }.getOrElse { return fail("Realtime tool-call limit exceeded") }
            for (call in calls) {
              if (!admitted.remove(call.id)) continue
              if (call.name == "describe_view") {
                scope.launch { describeView(call.id) }
              } else {
                agent.handleToolCall(call.id, call.name, call.args, false)
              }
            }
          }

          response.string("status") == "cancelled" || id in cancelledResponses -> {}

          else -> {
            fail("Realtime response failed or incomplete")
          }
        }
        if (responseState.responsePending && !closed) {
          scope.launch { sendResponse() }
        } else {
          publishResponseStatus()
        }
      }

      "error" -> {
        // The Realtime contract keeps most event errors recoverable. Clear only
        // our correlated rejected response.create; unrelated errors stay open.
        val error = event["error"] as? JsonObject
        val rejectedCreation = responseState.creationRejected(error?.string("event_id"))
        if (rejectedCreation && responseState.responsePending) scope.launch { sendResponse() }
        publishResponseStatus("Recoverable provider event error")
      }

      "conversation.item.input_audio_transcription.failed" -> {
        itemId?.let(transcriptOrder::settle)
        publishResponseStatus("Recoverable input transcription error")
      }
    }
  }

  /** Both generation and playback terminals must preserve newer work and audible output. */
  private fun publishResponseStatus(error: String? = null) {
    if (closed) return
    onStatus(
      when {
        outputResponseId != null -> "Speaking"
        responseState.responseId != null || responseState.createInFlight || toolBatch.hasPending || responseState.responsePending -> "Thinking"
        else -> "Listening"
      },
    )
    error?.let {
      Log.w("TalkRealtime", it)
      onRecoverableError(it)
    }
  }

  private fun remember(
    ids: MutableSet<String>,
    id: String,
    prefix: String = "",
  ): Boolean {
    if (id.length > TALK_REALTIME_MAX_ID_CHARS) {
      fail("Realtime call identity limit exceeded")
      return false
    }
    // Local role namespaces do not reduce the raw provider ID budget.
    val key = prefix + id
    if (key in ids) return false
    if (ids.size >= 1024) {
      fail("Realtime call event limit exceeded")
      return false
    }
    return ids.add(key)
  }

  private fun reserveTranscript(
    itemId: String,
    previousItemId: String?,
    role: String?,
    predecessorProvided: Boolean,
  ) {
    if (!gatewayTranscripts && !transcriptOrder.reserve(itemId, previousItemId, role, predecessorProvided)) {
      fail("Realtime transcript queue overflow")
    }
  }

  private fun transcript(
    role: String,
    text: String?,
    itemId: String?,
    final: Boolean,
  ) {
    if (role !in listOf("user", "assistant")) return
    if (!final && itemId != null && "$role:$itemId" in finalTranscripts) return
    if (final) {
      if (itemId == null) return fail("Realtime transcript has no item identity")
      if (!remember(finalTranscripts, itemId, "$role:")) return
      if (!gatewayTranscripts && !transcriptOrder.settle(itemId, role, text)) {
        return fail("Realtime transcript final has no reserved item")
      }
    }
    if (!text.isNullOrEmpty()) onTranscript(role, text, final)
  }

  private fun transcriptFrameless(
    role: String,
    text: String?,
    entryId: String,
  ) {
    if (role !in listOf("user", "assistant") || text.isNullOrEmpty()) return
    if (!remember(finalTranscripts, entryId, "$role:")) return
    if (!gatewayTranscripts) {
      enqueueTranscript(
        role,
        CompletableDeferred(entryId),
        CompletableDeferred(text),
        // A Deferred is also a Job: name the value to avoid adopting a completed parent.
        CompletableDeferred(value = CompletableDeferred(Unit)),
        CompletableDeferred(),
      ) {}
    }
    onTranscript(role, text, true)
  }

  private fun enqueueTranscript(
    role: String,
    entryId: Deferred<String>,
    text: Deferred<String?>,
    afterPrevious: Deferred<Deferred<Unit>>,
    written: CompletableDeferred<Unit>,
    release: () -> Unit,
  ) {
    val voiceId = voiceSessionId ?: return
    val job =
      transcriptScope.async<Unit> {
        try {
          afterPrevious.await().await()
          val orderedEntryId = entryId.await()
          val finalText = text.await() ?: return@async
          wireTarget.request(
            "talk.client.transcript",
            buildJsonObject {
              put("voiceSessionId", voiceId)
              put("entryId", orderedEntryId)
              put("role", role)
              put("text", finalText)
            }.toString(),
            TRANSCRIPT_REQUEST_TIMEOUT_MS,
          ) { enqueue ->
            // A transport wait cannot revive a drain whose owner has expired.
            transcriptOwner.ensureActive()
            enqueue()
          }
        } catch (_: Exception) {
          // The failure callback closes the call; keep the queue tail completed so
          // retirement can still issue the logical session close exactly once.
          reportTranscriptFailure()
        } finally {
          written.complete(Unit)
          release()
        }
      }
    val previous = transcriptTail
    transcriptTail =
      transcriptScope.async {
        previous.await()
        job.await()
      }
  }

  suspend fun openCamera(
    manager: ai.openclaw.app.node.CameraCaptureManager,
    view: androidx.camera.view.PreviewView,
    facing: String,
  ): AutoCloseable =
    withContext(Dispatchers.Main.immediate) {
      check(cameraCallId != null && isCurrent()) { "This Talk call does not support camera input" }
      val operation = ++cameraOperation
      camera?.close()
      camera = null
      val acquired = manager.openTalkPreview(view, facing) { !closed && isCurrent() && cameraOperation == operation }
      if (closed || !isCurrent() || cameraOperation != operation) {
        acquired.close()
        error("Talk camera request expired")
      }
      camera = acquired
      AutoCloseable {
        if (camera === acquired) {
          cameraOperation++
          camera = null
        }
        acquired.close()
      }
    }

  private suspend fun describeView(callId: String) {
    val current = camera
    val operation = cameraOperation
    val result =
      try {
        check(supportsCamera && current != null) { "Camera is off; enable it in Talk first" }
        val message = current.captureMessage(peer.maxMessageBytes)
        peer.send(message) { send ->
          withCurrentCall {
            // Camera mutations and this final SDK call are Main-confined. Check
            // the sampled preview after admission callbacks, with no intervening await.
            check(camera === current && cameraOperation == operation) { "Camera changed before the image could be sent" }
            send()
          }
        }
        buildJsonObject { put("text", "One current camera image was attached.") }
      } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
      } catch (_: Exception) {
        buildJsonObject { put("error", "Camera image unavailable. Enable the camera and wait for its preview, then try again.") }
      }
    if (!closed && isCurrent()) submitToolResult(callId, result)
  }

  private suspend fun submitToolResult(
    callId: String,
    result: JsonObject,
  ) = withContext(Dispatchers.Main.immediate) {
    if (closed || !isCurrent() || !toolBatch.beginSend(callId)) return@withContext

    fun encode(value: JsonObject) =
      buildJsonObject {
        put("type", "conversation.item.create")
        put(
          "item",
          buildJsonObject {
            put("type", "function_call_output")
            put("call_id", callId)
            put("output", value.toString())
          },
        )
      }.toString()
    try {
      val output =
        encode(result).let { message ->
          if (message.toByteArray(Charsets.UTF_8).size <= peer.maxMessageBytes) {
            message
          } else {
            encode(buildJsonObject { put("error", "Tool result exceeds the Realtime message budget") })
          }
        }
      peer.send(output, ::withCurrentCall)
      if (toolBatch.complete(callId) == true) sendResponse()
    } catch (error: kotlinx.coroutines.CancellationException) {
      throw error
    } catch (_: Exception) {
      fail("Realtime tool result could not be sent")
    }
  }

  private suspend fun sendResponse() {
    val eventId = "android-response-${++clientEventSequence}"
    if (!closed && responseState.requestResponse(toolBatch.hasPending, eventId)) {
      try {
        peer.send(
          buildJsonObject {
            put("type", "response.create")
            put("event_id", eventId)
          }.toString(),
          ::withCurrentCall,
        )
      } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
      } catch (_: Exception) {
        responseState.creationRejected(eventId)
        fail("Realtime response could not be started")
      }
    }
  }

  private suspend fun cancelResponse(id: String) {
    if (closed || !remember(cancelledResponses, id)) return
    try {
      // These controls cancel only this peer's already-owned output. Selection
      // retirement must not suppress cleanup; the peer still fences physical close.
      peer.send(
        buildJsonObject {
          put("type", "response.cancel")
          put("response_id", id)
        }.toString(),
        withSend = { it() },
      )
      peer.send("{\"type\":\"output_audio_buffer.clear\"}", withSend = { it() })
    } catch (error: kotlinx.coroutines.CancellationException) {
      throw error
    } catch (_: Exception) {
      fail("Realtime response cancellation could not be sent")
    }
  }

  suspend fun setCaptureEnabled(enabled: Boolean) =
    withContext(Dispatchers.Main.immediate) {
      peer.setCaptureEnabled(enabled)
      if (enabled && !closed) {
        if (started) publishResponseStatus() else onStatus("Connecting")
      }
    }

  suspend fun setPlaybackEnabled(enabled: Boolean) = peer.setPlaybackEnabled(enabled)

  suspend fun cancelOutput() =
    withContext(Dispatchers.Main.immediate) {
      if (closed || !started) return@withContext
      if (outputControl != OutputControl.Ga) {
        // Native and still-unknown sessions end explicitly rather than borrowing
        // GA controls that their wire contract has not established.
        fail("Realtime response cancellation ended the call")
        return@withContext
      }
      val id = responseState.cancel()
      if (id != null) cancelResponse(id)
      if (id == null && responseState.responseId == null && !responseState.createInFlight && !gatewayTranscripts) {
        peer.send("{\"type\":\"output_audio_buffer.clear\"}", withSend = { it() })
      }
    }

  suspend fun close() =
    withContext(NonCancellable + Dispatchers.Main.immediate) {
      // Concurrent callers join physical retirement and the same logical ACK.
      // A create accepted before Stop can return a late allocation after cleanup.
      val cleanup =
        closing?.takeUnless { it.isCompleted && voiceSessionId != null } ?: async<Unit>(start = CoroutineStart.LAZY) {
          retire()
          snapshot = null
          cameraOperation++
          camera?.close()
          camera = null
          voiceSessionId?.let { agent.endSession(it) }
          try {
            peer.close()
          } catch (error: Throwable) {
            transcriptOwner.cancelAndJoin()
            throw error
          } finally {
            transcriptOrder.close()
          }
          val voiceId = voiceSessionId
          voiceSessionId = null
          try {
            // Accepted finals share one request budget after physical retirement,
            // not a fresh budget per queued item. Completed failures were reported.
            if (withTimeoutOrNull(TRANSCRIPT_REQUEST_TIMEOUT_MS) { transcriptTail.join() } == null) reportTranscriptFailure()
          } finally {
            // Cancel the actual RPC jobs, not just their join chain, before logical close.
            transcriptOwner.cancelAndJoin()
            if (voiceId != null) {
              runCatching {
                wireTarget.request(
                  "talk.client.close",
                  buildJsonObject {
                    put("voiceSessionId", voiceId)
                  }.toString(),
                  5_000,
                )
              }.onFailure { onFailure("Realtime session close could not be confirmed") }
            }
          }
        }.also { closing = it }
      cleanup.await()
    }

  private fun reportTranscriptFailure() {
    retire()
    if (!transcriptFailureReported) {
      transcriptFailureReported = true
      // Retired clients cannot overwrite a replacement UI; keep their loss diagnostic.
      Log.w("TalkRealtime", "Voice transcript could not be saved")
      onFailure("Voice transcript could not be saved")
    }
  }

  private fun fail(message: String) {
    if (!retire()) return
    onFailure(message)
    scope.launch { close() }
  }
}

private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

/** Only the committed call supplies identity; connecting never reuses an earlier call's values. */
internal fun talkRealtimeStatusText(
  state: String,
  snapshot: TalkRealtimeSnapshot?,
): NativeText {
  if (snapshot == null) return nativeText("Connecting…")
  val details = listOf(snapshot.provider, snapshot.model ?: "Unknown", snapshot.authMethod ?: "Unknown", snapshot.voice ?: "Unknown", snapshot.transport).joinToString(" / ")
  return nativeText("Talk: \$state — \$details", state, verbatimText(details))
}
