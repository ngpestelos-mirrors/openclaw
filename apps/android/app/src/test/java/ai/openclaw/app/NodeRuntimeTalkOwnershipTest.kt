package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.VoiceWakeManager
import ai.openclaw.app.voice.VoiceWakeSuppressionReason
import android.Manifest
import android.content.Context
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeTalkOwnershipTest {
  @Test
  fun reassertingActiveTalkDoesNotInvalidateItsTerminalOwner() =
    runBlocking {
      withRuntime { runtime, manager, frames ->
        runtime.setTalkModeEnabled(true)
        awaitState { manager.isListening.value }
        val owner = field<java.util.concurrent.atomic.AtomicLong>(runtime, "voiceCaptureOwnershipEpoch").get()
        runtime.setTalkModeEnabled(true)
        assertEquals(owner, field<java.util.concurrent.atomic.AtomicLong>(runtime, "voiceCaptureOwnershipEpoch").get())
        assertEquals(1, frames.count { it["method"]?.jsonPrimitive?.content == "talk.session.create" })
        manager.handleGatewayEvent("talk.event", """{"relaySessionId":"owned-runtime-relay","type":"close","reason":"completed"}""")
        awaitState { runtime.voiceCaptureMode.value == VoiceCaptureMode.Off }
        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
        assertFalse(manager.ttsOnAllResponses)
      }
    }

  @Test
  fun explicitStartForNewSelectionIsNotDroppedAsAlreadyActive() =
    runBlocking {
      withRuntime { runtime, manager, frames ->
        runtime.setTalkModeEnabled(true)
        awaitState { manager.isListening.value }
        // Hold the real outer owner so the asynchronous navigation collector cannot retire A first.
        synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
          runtime.switchChatSession("agent:work:b", "work")
          runtime.setTalkModeEnabled(true)
        }
        awaitState { runtime.voiceCaptureMode.value == VoiceCaptureMode.Off || frames.count { it["method"]?.jsonPrimitive?.content == "talk.session.create" } == 2 }
        val targets = frames.filter { it["method"]?.jsonPrimitive?.content == "talk.session.create" }.map { it["params"]!!.jsonObject["sessionKey"]!!.jsonPrimitive.content }
        println("runtime-explicit-replacement targets=$targets mode=" + runtime.voiceCaptureMode.value)
        assertEquals(listOf("agent:work:a", "agent:work:b"), targets)
      }
    }

  @Test
  fun activationCannotMoveToAnotherChatWhileAudioRetires() =
    runBlocking {
      withRuntime { runtime, manager, frames ->
        val held = CompletableDeferred<Unit>()
        manager.audioRetirement.retire(cleanup = held)
        val owner = field<CoroutineScope>(runtime, "scope").coroutineContext[Job]!!
        val existing = owner.children.toSet()
        try {
          runtime.setTalkModeEnabled(true)
          val starts = owner.children.filter { it !in existing }.toList()
          assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
          assertFalse(manager.isEnabled.value)
          runtime.switchChatSession("agent:work:b", "work")
          awaitState {
            frames.any {
              it["method"]?.jsonPrimitive?.content == "talk.catalog" && it["params"]
                ?.jsonObject
                ?.get("sessionKey")
                ?.jsonPrimitive
                ?.content == "agent:work:b"
            }
          }
          held.complete(Unit)
          withTimeout(8_000) { starts.forEach { it.join() } }
          awaitState { runtime.voiceCaptureMode.value == VoiceCaptureMode.Off || frames.any { it["method"]?.jsonPrimitive?.content == "talk.session.create" } }
          val creates = frames.filter { it["method"]?.jsonPrimitive?.content == "talk.session.create" }
          println("runtime-start retired-chat=true creates=" + creates.size + " mode=" + runtime.voiceCaptureMode.value)
          assertTrue("An action in A must not create a call in B", creates.isEmpty())
          assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
          assertFalse(manager.isEnabled.value)
        } finally {
          held.complete(Unit)
        }
      }
    }

  @Test
  fun navigationRetiresTheOuterCaptureOwnerAsWellAsTheManager() =
    runBlocking {
      withRuntime { runtime, manager, frames ->
        runtime.setTalkModeEnabled(true)
        awaitState { manager.isListening.value }
        val creates = frames.filter { it["method"]?.jsonPrimitive?.content == "talk.session.create" }
        assertEquals(1, creates.size)
        assertEquals(
          "agent:work:a",
          creates
            .single()["params"]!!
            .jsonObject["sessionKey"]!!
            .jsonPrimitive.content,
        )
        assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
        assertTrue(manager.ttsOnAllResponses)
        runtime.switchChatSession("agent:work:b", "work")
        awaitState {
          !manager.isEnabled.value &&
            frames.any {
              it["method"]?.jsonPrimitive?.content == "talk.catalog" && it["params"]
                ?.jsonObject
                ?.get("sessionKey")
                ?.jsonPrimitive
                ?.content == "agent:work:b"
            }
        }
        withTimeout(8_000) { manager.audioRetirement.await() }
        val external = field<StateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value
        val wake = field<VoiceWakeManager>(runtime, "voiceWakeManager")
        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
        awaitState { !field<Set<VoiceWakeSuppressionReason>>(wake, "suppressionReasons").contains(VoiceWakeSuppressionReason.VoiceCapture) }
        val suppressed = field<Set<VoiceWakeSuppressionReason>>(wake, "suppressionReasons").contains(VoiceWakeSuppressionReason.VoiceCapture)
        println("runtime-navigation mode=" + runtime.voiceCaptureMode.value + " tts=" + manager.ttsOnAllResponses + " external=" + external + " wakeSuppressed=" + suppressed)
        assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
        assertFalse(manager.ttsOnAllResponses)
        assertFalse(external)
        assertFalse(suppressed)
      }
    }

  private suspend fun withRuntime(block: suspend (NodeRuntime, TalkModeManager, ConcurrentLinkedQueue<JsonObject>) -> Unit) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    val prefs = SecurePrefs(app, app.getSharedPreferences("talk-owner-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    val frames = ConcurrentLinkedQueue<JsonObject>()
    val server = MockWebServer()
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          MockResponse().withWebSocketUpgrade(
            object : WebSocketListener() {
              override fun onOpen(
                webSocket: WebSocket,
                response: Response,
              ) {
                webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"runtime-talk-fixture","ts":1700000000123}}""")
              }

              override fun onMessage(
                webSocket: WebSocket,
                text: String,
              ) {
                val request = Json.parseToJsonElement(text).jsonObject
                if (request["type"]?.jsonPrimitive?.content != "req") return
                frames.add(request)
                val id = request.getValue("id").jsonPrimitive.content
                val payload =
                  when (request["method"]?.jsonPrimitive?.content) {
                    "connect" -> """{"features":{"methods":[],"capabilities":["talk-session-target-v1"]},"auth":{"scopes":["operator.admin","operator.read","operator.write"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:work:main","mainKey":"main"}}}"""
                    "talk.config" -> """{"config":{"talk":{"realtime":{"mode":"realtime","transport":"gateway-relay"}}}}"""
                    "talk.catalog" -> """{"realtime":{"activeProvider":"openai","providers":[{"id":"openai","transports":["gateway-relay"]}]}}"""
                    "talk.session.create" -> """{"relaySessionId":"owned-runtime-relay"}"""
                    "chat.history" -> """{"messages":[]}"""
                    "sessions.list" -> """{"sessions":[]}"""
                    else -> "{}"
                  }
                webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":$payload}""")
              }

              override fun onClosing(
                webSocket: WebSocket,
                code: Int,
                reason: String,
              ) {
                webSocket.close(code, reason)
              }
            },
          )
      }
    server.start()
    try {
      // Reuse the established runtime/operator-session seam; TLS discovery is not this test's owner.
      // Keep the real selection collector running (unlike auth fixtures that stop all startup jobs).
      val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
      ReflectionHelpers.setField(runtime, "didAutoConnect", true)
      ReflectionHelpers.setField(runtime, "connectedEndpoint", endpoint)
      val session = field<GatewaySession>(runtime, "operatorSession")
      val connection = field<ai.openclaw.app.node.ConnectionManager>(runtime, "connectionManager")
      session.connect(endpoint, "synthetic-runtime-token", null, null, connection.buildOperatorConnectOptions())
      awaitState { field<Boolean>(runtime, "operatorConnected") }
      runtime.switchChatSession("agent:work:a", "work")
      awaitState { runtime.chatSessionKey.value == "agent:work:a" }
      val manager =
        runtime.javaClass
          .getDeclaredMethod("getTalkMode")
          .apply { isAccessible = true }
          .invoke(runtime) as TalkModeManager
      block(runtime, manager, frames)
    } finally {
      runtime.setTalkModeEnabled(false)
      closeNodeRuntimeTestFixture(runtime)
      bindNodeRuntimeTestFixture(app, null)
      server.shutdown()
    }
  }

  private suspend fun awaitState(ready: () -> Boolean) =
    withTimeout(8_000) {
      while (!ready()) {
        shadowOf(Looper.getMainLooper()).idle()
        yield()
      }
    }

  private fun <T> field(
    target: Any,
    name: String,
  ): T = ReflectionHelpers.getField(target, name)
}
