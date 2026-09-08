package ai.openclaw.app

import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.TalkCameraPreview
import ai.openclaw.app.node.TalkPreviewViewShadow
import ai.openclaw.app.voice.RealtimeAgentCoordinator
import ai.openclaw.app.voice.RealtimeAgentSession
import ai.openclaw.app.voice.StartupDataChannel
import ai.openclaw.app.voice.StartupMediaSource
import ai.openclaw.app.voice.StartupMediaTrack
import ai.openclaw.app.voice.StartupPeerConnection
import ai.openclaw.app.voice.StartupPeerFactory
import ai.openclaw.app.voice.StartupPeerFactoryBuilder
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.TalkRealtimeClient
import ai.openclaw.app.voice.VoiceWakeManager
import ai.openclaw.app.voice.VoiceWakeSuppressionReason
import android.Manifest
import android.content.Context
import android.graphics.Bitmap
import android.os.Looper
import androidx.camera.view.PreviewView
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
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers
import org.webrtc.SessionDescription
import java.lang.management.ManagementFactory
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [TalkPreviewViewShadow::class, StartupPeerFactory::class, StartupPeerFactoryBuilder::class, StartupPeerConnection::class, StartupDataChannel::class, StartupMediaTrack::class, StartupMediaSource::class])
class NodeRuntimeTalkOwnershipTest {
  @Test fun cameraFinalAdmissionAllowsCurrentImage() = assertCameraFinalAdmission("allowed")

  @Test fun cameraFinalAdmissionRejectsRetiredSelection() = assertCameraFinalAdmission("selection")

  @Test fun cameraFinalAdmissionRejectsRetiredGateway() = assertCameraFinalAdmission("gateway")

  @Test fun cameraFinalAdmissionRejectsRetiredCapture() = assertCameraFinalAdmission("capture")

  @Test fun cameraFinalAdmissionRejectsRetiredLogicalCall() = assertCameraFinalAdmission("logical")

  @Test fun cameraFinalAdmissionRejectsReplacedPreview() = assertCameraFinalAdmission("camera")

  @Test fun cameraFinalAdmissionRejectsReplacedOperation() = assertCameraFinalAdmission("camera-operation")

  @Test fun cameraFinalAdmissionSerializesPhysicalRetirement() = assertCameraFinalAdmission("gateway-during-send")

  @Test fun cameraFinalAdmissionRejectsRetiredToolOutput() = assertCameraFinalAdmission("tool-output")

  @Test fun cameraFinalAdmissionRejectsRetiredResponse() = assertCameraFinalAdmission("response")

  private fun assertCameraFinalAdmission(schedule: String) =
    runBlocking {
      withRuntime(webRtc = true) { runtime, manager, _ ->
        StartupPeerConnection.reset()
        StartupDataChannel.reset()
        runtime.setTalkModeEnabled(true)
        awaitState { StartupPeerConnection.offerCreated.isCompleted }
        StartupPeerConnection.offerCreated.await().onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
        StartupDataChannel.open()
        awaitState { manager.isListening.value }
        val client = field<TalkRealtimeClient>(manager, "realtimeClient")
        val gateway = field<GatewaySession>(runtime, "operatorSession")
        val lease = checkNotNull(gateway.captureRequestLease())
        val connection = field<Any>(gateway, "currentConnection")
        val chat = field<ChatController>(runtime, "chat")
        val locks = listOf(field<Any>(gateway, "lifecycleLock"), field<Any>(chat, "gatewayScopeApplyLock"), field<Any>(manager, "realtimeCapturePauseLock"), field<Any>(client, "callLifecycleLock"))
        val view = Shadow.newInstanceOf(PreviewView::class.java)
        val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
        Shadow.extract<TalkPreviewViewShadow>(view).frame = bitmap
        val camera = TalkCameraPreview(view, AutoCloseable {}) { true }
        ReflectionHelpers.setField(client, "camera", camera)
        var stateRead = false
        var stateReads = 0
        val retireAtRead =
          when (schedule) {
            "tool-output" -> 2
            "response" -> 3
            else -> 1
          }
        val admissionAtSend = mutableListOf<Boolean>()
        var readyDuringSend: Boolean? = null
        var retirement: Thread? = null
        val retirementDone = CountDownLatch(1)
        val retirementError = AtomicReference<Throwable>()

        fun retireGateway() {
          val socket = field<WebSocket?>(connection, "socket")
          connection.javaClass
            .getDeclaredMethod("finishTransport", String::class.java, Throwable::class.java)
            .apply { isAccessible = true }
            .invoke(connection, "fixture retirement", IllegalStateException("fixture retirement"))
          socket?.cancel()
        }
        StartupDataChannel.onStateRead = {
          stateRead = true
          stateReads++
          if (stateReads == retireAtRead) {
            // The last SDK readiness read is after capture and the old caller currency check.
            // These invoke actual retirement producers; normal runtime cleanup is held below.
            when (schedule) {
              "selection", "tool-output", "response" -> {
                chat.switchSession("agent:work:b", "work")
              }

              "gateway" -> {
                retireGateway()
              }

              "capture" -> {
                manager.setEnabled(false)
              }

              "logical" -> {
                client.javaClass
                  .getDeclaredMethod("retire")
                  .apply { isAccessible = true }
                  .invoke(client)
              }

              "camera" -> {
                ReflectionHelpers.setField(client, "camera", null)
              }

              "camera-operation" -> {
                ReflectionHelpers.setField(client, "cameraOperation", field<Long>(client, "cameraOperation") + 1)
              }
            }
          }
        }
        StartupDataChannel.onSend = { message ->
          admissionAtSend.add(locks.all(Thread::holdsLock))
          if (schedule == "gateway-during-send" && message.contains("input_image")) {
            retirement =
              Thread {
                try {
                  retireGateway()
                } catch (error: Throwable) {
                  retirementError.set(error)
                } finally {
                  retirementDone.countDown()
                }
              }.also { it.start() }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
            while (retirementDone.count != 0L) {
              val info = ManagementFactory.getThreadMXBean().getThreadInfo(retirement.threadId())
              if (info?.lockInfo?.identityHashCode == System.identityHashCode(locks.first()) && info.threadState == Thread.State.BLOCKED) break
              check(System.nanoTime() < deadline) { "Physical retirement neither finished nor waited for admission" }
              Thread.yield()
            }
            readyDuringSend = lease.isCurrent()
          }
        }
        try {
          synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
            StartupDataChannel.message("""{"type":"response.done","response":{"id":"camera-final","status":"completed","output":[{"type":"function_call","status":"completed","call_id":"view-final","name":"describe_view","arguments":"{}"}]}}""")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
            while (!stateRead) {
              shadowOf(Looper.getMainLooper()).idle()
              check(System.nanoTime() < deadline) { "Camera never reached final SDK readiness" }
              Thread.yield()
            }
            // Main has drained the image coroutine; no wall-clock guess is used for absence.
            shadowOf(Looper.getMainLooper()).idle()
            retirement?.join(8_000)
            assertFalse(retirement?.isAlive == true)
            retirementError.get()?.let { throw it }
            val images = StartupDataChannel.sent.count { it.contains("input_image") }
            val expected = if (schedule in listOf("allowed", "gateway-during-send", "tool-output", "response")) 1 else 0
            println("camera-final schedule=$schedule images=$images locked=$admissionAtSend readyDuringSend=$readyDuringSend")
            assertTrue(bitmap.isRecycled)
            assertEquals("Captured image must respect final $schedule admission", expected, images)
            assertTrue("Every new DataChannel effect must retain physical/selection/capture/call locks", admissionAtSend.all { it })
            if (schedule == "allowed") {
              assertEquals(1, StartupDataChannel.sent.count { it.contains("function_call_output") })
              assertEquals(1, StartupDataChannel.sent.count { it.contains("response.create") })
            }
            if (schedule == "gateway-during-send") assertEquals(true, readyDuringSend)
            if (schedule in listOf("tool-output", "response")) {
              assertEquals(if (schedule == "response") 1 else 0, StartupDataChannel.sent.count { it.contains("function_call_output") })
              assertEquals(0, StartupDataChannel.sent.count { it.contains("response.create") })
            }
          }
        } finally {
          StartupDataChannel.onStateRead = null
          StartupDataChannel.onSend = null
          retirement?.join(8_000)
          camera.close()
        }
      }
    }

  @Test
  fun startupSdpContinuationsRequireCurrentSelection() =
    runBlocking {
      val violations = mutableListOf<String>()
      for (retirement in listOf("none", "offer", "answer")) {
        val offered = CountDownLatch(1)
        val releaseAnswer = CountDownLatch(1)
        val localOwners = mutableListOf<Boolean>()
        val remoteOwners = mutableListOf<Boolean>()
        val nativeAdmission = mutableListOf<Boolean>()
        try {
          withRuntime(webRtc = true, beforeOfferResponse = {
            offered.countDown()
            check(releaseAnswer.await(8, TimeUnit.SECONDS)) { "HTTP answer was not released" }
          }) { runtime, manager, frames ->
            StartupPeerConnection.reset()
            StartupDataChannel.reset()
            runtime.setTalkModeEnabled(true)
            awaitState { StartupPeerConnection.offerCreated.isCompleted }
            val client = field<TalkRealtimeClient>(manager, "realtimeClient")
            val peer = field<Any>(client, "peer")
            val setup = field<CompletableDeferred<Unit>>(peer, "startup")
            val chat = field<ChatController>(runtime, "chat")
            val selection = chat.selectionGeneration.value
            val gateway = field<GatewaySession>(runtime, "operatorSession")
            val locks = listOf(field<Any>(gateway, "lifecycleLock"), field<Any>(chat, "gatewayScopeApplyLock"), field<Any>(manager, "realtimeCapturePauseLock"), field<Any>(client, "callLifecycleLock"))
            StartupPeerConnection.onLocalDescription = {
              localOwners += chat.selectionGeneration.value == selection
              nativeAdmission += locks.all(Thread::holdsLock)
            }
            StartupPeerConnection.onRemoteDescription = {
              remoteOwners += chat.selectionGeneration.value == selection
              nativeAdmission += locks.all(Thread::holdsLock)
            }
            synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
              if (retirement == "offer") chat.switchSession("agent:work:b", "work")
              StartupPeerConnection.offer!!.onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
              if (retirement != "offer") {
                runBlocking { awaitState { offered.count == 0L } }
                assertEquals(listOf(true), localOwners)
                assertTrue(remoteOwners.isEmpty())
                if (retirement == "answer") chat.switchSession("agent:work:b", "work")
              }
              assertTrue("Physical connection remains current", gateway.captureRequestLease()!!.isCurrent())
              assertFalse("Runtime cleanup remains held", field<Boolean>(client, "closed"))
              releaseAnswer.countDown()
              StartupDataChannel.open()
              runBlocking { awaitState { setup.isCompleted } }
              println("startup-sdp retirement=$retirement httpEnqueued=" + (offered.count == 0L) + " localOwners=$localOwners remoteOwners=$remoteOwners admission=$nativeAdmission")
              if (nativeAdmission.any { !it }) violations += "$retirement native submission lacked owner locks"
              if (localOwners != if (retirement == "offer") emptyList<Boolean>() else listOf(true)) violations += "$retirement localOwners=$localOwners"
              if (remoteOwners != if (retirement == "none") listOf(true) else emptyList<Boolean>()) violations += "$retirement remoteOwners=$remoteOwners"
            }
            if (retirement != "none") {
              awaitState { frames.any { it["method"]?.jsonPrimitive?.content == "talk.client.close" } }
              assertEquals(1, frames.count { it["method"]?.jsonPrimitive?.content == "talk.client.close" })
              assertTrue(StartupPeerConnection.disposed)
            }
          }
        } finally {
          releaseAnswer.countDown()
          StartupPeerConnection.onLocalDescription = null
          StartupPeerConnection.onRemoteDescription = null
        }
      }
      assertTrue(violations.joinToString(), violations.isEmpty())
    }

  @Test
  fun delayedOfferRequiresCurrentChatSelection() =
    runBlocking {
      val violations = mutableListOf<String>()
      for (retire in listOf(false, true)) {
        val offers =
          java.util.concurrent.atomic
            .AtomicInteger()
        withRuntime(webRtc = true, httpOffers = offers) { runtime, manager, frames ->
          StartupPeerConnection.reset()
          StartupDataChannel.reset()
          runtime.setTalkModeEnabled(true)
          awaitState { StartupPeerConnection.offerCreated.isCompleted }
          val client = field<TalkRealtimeClient>(manager, "realtimeClient")
          val peer = field<Any>(client, "peer")
          val setup = field<CompletableDeferred<Unit>>(peer, "startup")
          val chat = field<ChatController>(runtime, "chat")
          val gateway = field<GatewaySession>(runtime, "operatorSession")
          synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
            if (retire) chat.switchSession("agent:work:b", "work")
            assertTrue("Physical Gateway remains current while selection cleanup is held", gateway.captureRequestLease()!!.isCurrent())
            StartupPeerConnection.offer!!.onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
            StartupDataChannel.open()
            runBlocking { awaitState { setup.isCompleted } }
            println("offer-admission retired=$retire httpOffers=" + offers.get())
            if (offers.get() != if (retire) 0 else 1) violations += "retired=$retire httpOffers=" + offers.get()
          }
          if (retire) {
            awaitState { frames.any { it["method"]?.jsonPrimitive?.content == "talk.client.close" } }
            assertEquals(1, frames.count { it["method"]?.jsonPrimitive?.content == "talk.client.close" })
          }
        }
      }
      assertTrue(violations.joinToString(), violations.isEmpty())
    }

  @Test fun dataChannelFinalAdmissionAllowsCurrentOutput() = assertDataChannelFinalAdmission("allowed")

  @Test fun dataChannelFinalAdmissionRejectsRetiredSelection() = assertDataChannelFinalAdmission("selection")

  @Test fun dataChannelFinalAdmissionRejectsRetiredGateway() = assertDataChannelFinalAdmission("gateway")

  @Test fun dataChannelFinalAdmissionRejectsRetiredCapture() = assertDataChannelFinalAdmission("capture")

  @Test fun dataChannelFinalAdmissionRejectsRetiredLogicalCall() = assertDataChannelFinalAdmission("logical")

  @Test fun dataChannelFinalAdmissionSerializesPhysicalRetirement() = assertDataChannelFinalAdmission("gateway-during-send")

  @Test fun dataChannelFinalAdmissionRejectsRetiredResponse() = assertDataChannelFinalAdmission("response")

  private fun assertDataChannelFinalAdmission(schedule: String) =
    runBlocking {
      withRuntime(webRtc = true) { runtime, manager, _ ->
        StartupPeerConnection.reset()
        StartupDataChannel.reset()
        runtime.setTalkModeEnabled(true)
        awaitState { StartupPeerConnection.offerCreated.isCompleted }
        StartupPeerConnection.offerCreated.await().onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
        StartupDataChannel.open()
        awaitState { manager.isListening.value }
        val client = field<TalkRealtimeClient>(manager, "realtimeClient")
        val gateway = field<GatewaySession>(runtime, "operatorSession")
        val lease = checkNotNull(gateway.captureRequestLease())
        val connection = field<Any>(gateway, "currentConnection")
        val chat = field<ChatController>(runtime, "chat")
        val locks = listOf(field<Any>(gateway, "lifecycleLock"), field<Any>(chat, "gatewayScopeApplyLock"), field<Any>(manager, "realtimeCapturePauseLock"), field<Any>(client, "callLifecycleLock"))
        var stateRead = false
        var stateReads = 0
        val retireAtRead = if (schedule == "response") 2 else 1
        val admissionAtSend = mutableListOf<Boolean>()
        var readyDuringSend: Boolean? = null
        var retirement: Thread? = null
        val retirementDone = CountDownLatch(1)
        val retirementError = AtomicReference<Throwable>()

        fun retireGateway() {
          val socket = field<WebSocket?>(connection, "socket")
          connection.javaClass
            .getDeclaredMethod("finishTransport", String::class.java, Throwable::class.java)
            .apply { isAccessible = true }
            .invoke(connection, "fixture retirement", IllegalStateException("fixture retirement"))
          socket?.cancel()
        }
        StartupDataChannel.onStateRead = {
          stateRead = true
          stateReads++
          if (schedule == "gateway-during-send" && stateReads > 1) {
            // The next effect runs only after the already-started physical retirement.
            check(retirementDone.await(8, TimeUnit.SECONDS))
          }
          if (stateReads == retireAtRead) {
            // The last SDK readiness read is after the old caller currency check.
            // These invoke actual retirement producers; normal runtime cleanup is held below.
            when (schedule) {
              "selection", "response" -> {
                chat.switchSession("agent:work:b", "work")
              }

              "gateway" -> {
                retireGateway()
              }

              "capture" -> {
                manager.setEnabled(false)
              }

              "logical" -> {
                client.javaClass
                  .getDeclaredMethod("retire")
                  .apply { isAccessible = true }
                  .invoke(client)
              }
            }
          }
        }
        StartupDataChannel.onSend = { message ->
          admissionAtSend.add(locks.all(Thread::holdsLock))
          if (schedule == "gateway-during-send" && message.contains("function_call_output")) {
            retirement =
              Thread {
                try {
                  retireGateway()
                } catch (error: Throwable) {
                  retirementError.set(error)
                } finally {
                  retirementDone.countDown()
                }
              }.also { it.start() }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
            while (retirementDone.count != 0L) {
              val info = ManagementFactory.getThreadMXBean().getThreadInfo(retirement.threadId())
              if (info?.lockInfo?.identityHashCode == System.identityHashCode(locks.first()) && info.threadState == Thread.State.BLOCKED) break
              check(System.nanoTime() < deadline) { "Physical retirement neither finished nor waited for admission" }
              Thread.yield()
            }
            readyDuringSend = lease.isCurrent()
          }
        }
        try {
          synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
            StartupDataChannel.message("""{"type":"response.done","response":{"id":"tool-final","status":"completed","output":[{"type":"function_call","status":"completed","call_id":"output-final","name":"unsupported_test_tool","arguments":"{}"}]}}""")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
            while (!stateRead) {
              shadowOf(Looper.getMainLooper()).idle()
              check(System.nanoTime() < deadline) { "Tool output never reached final SDK readiness" }
              Thread.yield()
            }
            // Main has drained the tool coroutine; no wall-clock guess is used for absence.
            shadowOf(Looper.getMainLooper()).idle()
            retirement?.join(8_000)
            assertFalse(retirement?.isAlive == true)
            retirementError.get()?.let { throw it }
            val outputs = StartupDataChannel.sent.count { it.contains("function_call_output") }
            val responses = StartupDataChannel.sent.count { it.contains("response.create") }
            val expected = if (schedule in listOf("allowed", "gateway-during-send", "response")) 1 else 0
            println("data-channel-final schedule=$schedule outputs=$outputs responses=$responses locked=$admissionAtSend readyDuringSend=$readyDuringSend")
            assertEquals("Tool output must respect final $schedule admission", expected, outputs)
            assertEquals(if (schedule == "allowed") 1 else 0, responses)
            assertTrue("Every new DataChannel effect must retain physical/selection/capture/call locks", admissionAtSend.all { it })
            if (schedule == "gateway-during-send") assertEquals(true, readyDuringSend)
          }
        } finally {
          StartupDataChannel.onStateRead = null
          StartupDataChannel.onSend = null
          retirement?.join(8_000)
        }
      }
    }

  @Test
  fun relayConsultSelectionAdmission() =
    runBlocking {
      assertRelaySelectionAdmission("talk.client.toolCall", "openclaw_agent_consult")
    }

  @Test
  fun relayControlSelectionAdmission() =
    runBlocking {
      assertRelaySelectionAdmission("talk.session.steer", "openclaw_agent_control")
    }

  private suspend fun assertRelaySelectionAdmission(
    method: String,
    tool: String,
  ) {
    val violations = mutableListOf<String>()
    for (schedule in listOf("allowed", "selection-first", "concurrent")) {
      withRuntime { runtime, manager, frames ->
        runtime.setTalkModeEnabled(true)
        awaitState { manager.isListening.value }
        val coordinator = field<RealtimeAgentCoordinator>(manager, "realtimeAgentCoordinator")
        val session = field<RealtimeAgentSession>(coordinator, "activeSession")
        val request = session.requestGateway!!
        val done = CountDownLatch(1)
        val outcome = AtomicReference<Result<String>>()
        val observed: suspend (String, String?, Long) -> String = { name, params, timeout ->
          if (name == method) {
            val result = runCatching { request(name, params, timeout) }
            outcome.set(result)
            done.countDown()
            result.getOrThrow()
          } else {
            request(name, params, timeout)
          }
        }
        ReflectionHelpers.setField(session, "requestGateway", observed)
        val gateway = field<GatewaySession>(runtime, "operatorSession")
        val connection = field<Any>(gateway, "currentConnection")
        val socket = field<WebSocket>(connection, "socket")
        val atSend = CountDownLatch(1)
        val release = CountDownLatch(1)
        // Delegate to the actual OkHttp socket. Stop at send, after any admission reads,
        // without replacing the selection owner, coordinator or Gateway transport.
        ReflectionHelpers.setField(
          connection,
          "socket",
          object : WebSocket by socket {
            override fun send(text: String): Boolean {
              if (schedule == "concurrent" && Json
                  .parseToJsonElement(text)
                  .jsonObject["method"]
                  ?.jsonPrimitive
                  ?.content == method
              ) {
                atSend.countDown()
                check(release.await(8, TimeUnit.SECONDS)) { "Relay final enqueue was not released" }
              }
              return socket.send(text)
            }
          },
        )
        val chat = field<ChatController>(runtime, "chat")
        val selectionLock = field<Any>(chat, "gatewayScopeApplyLock")
        val generation = chat.selectionGeneration.value
        val navigationDone = CountDownLatch(1)
        val navigationError = AtomicReference<Throwable>()
        var navigation: Thread? = null
        try {
          synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
            if (schedule == "selection-first") chat.switchSession("agent:work:b", "work")
            assertTrue(coordinator.handleToolCall("relay-race", tool, Json.parseToJsonElement("""{"text":"status"}"""), false))
            if (schedule == "concurrent") {
              assertTrue("Actual coordinator request must reach socket send", atSend.await(8, TimeUnit.SECONDS))
              navigation =
                Thread {
                  try {
                    chat.switchSession("agent:work:b", "work")
                  } catch (error: Throwable) {
                    navigationError.set(error)
                  } finally {
                    navigationDone.countDown()
                  }
                }.also { it.start() }
              val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
              while (navigationDone.count != 0L) {
                val info = ManagementFactory.getThreadMXBean().getThreadInfo(navigation.threadId())
                if (info?.lockInfo?.identityHashCode == System.identityHashCode(selectionLock) && info.threadState == Thread.State.BLOCKED) break
                check(System.nanoTime() < deadline) { "Navigation reached neither retirement nor its selection lock" }
                Thread.yield()
              }
            }
            val retired = chat.selectionGeneration.value != generation
            release.countDown()
            assertTrue("Coordinator request must settle", done.await(8, TimeUnit.SECONDS))
            navigation?.join(8_000)
            assertFalse("Navigation must finish", navigation?.isAlive == true)
            navigationError.get()?.let { throw it }
            runBlocking { withTimeout(8_000) { gateway.request("test.barrier", "{}") } }
            val sent = frames.count { it["method"]?.jsonPrimitive?.content == method }
            println("selection-relay method=$method schedule=$schedule retiredBeforeEnqueue=$retired frames=$sent success=" + outcome.get().isSuccess)
            if (sent != if (retired) 0 else 1) violations += "$method/$schedule retired=$retired frames=$sent"
            if (outcome.get().isSuccess == retired) violations += "$method/$schedule wrong outcome"
            assertTrue("Physical lease remains current", gateway.captureRequestLease()!!.isCurrent())
            assertTrue("Asynchronous cleanup is held, not substituted for selection retirement", field<RealtimeAgentSession>(coordinator, "activeSession") === session)
            assertEquals("owned-runtime-relay", field<String>(manager, "realtimeSessionId"))
          }
        } finally {
          release.countDown()
          navigation?.join(8_000)
          ReflectionHelpers.setField(connection, "socket", socket)
          ReflectionHelpers.setField(session, "requestGateway", request)
        }
      }
    }
    assertTrue(violations.joinToString(), violations.isEmpty())
  }

  @Test
  fun relayAcceptedResultAndCloseSurviveSelectionRetirement() =
    runBlocking {
      withRuntime { runtime, manager, frames ->
        runtime.setTalkModeEnabled(true)
        awaitState { manager.isListening.value }
        val coordinator = field<RealtimeAgentCoordinator>(manager, "realtimeAgentCoordinator")
        val chat = field<ChatController>(runtime, "chat")
        assertTrue(coordinator.handleToolCall("accepted-relay", "openclaw_agent_consult", Json.parseToJsonElement("{}"), false))
        awaitState {
          synchronized(field<Any>(coordinator, "lock")) {
            field<Map<String, Any>>(coordinator, "runs").containsKey("runtime-run")
          }
        }
        synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
          chat.switchSession("agent:work:b", "work")
          assertTrue(coordinator.handleChatEvent("agent:work:a", "runtime-run", "final", Json.parseToJsonElement("""{"role":"assistant","content":"accepted result"}""")))
          runBlocking {
            awaitState { frames.any { it["method"]?.jsonPrimitive?.content == "talk.session.submitToolResult" } }
          }
          val result = frames.single { it["method"]?.jsonPrimitive?.content == "talk.session.submitToolResult" }["params"]!!.jsonObject
          assertEquals("accepted-relay", result["callId"]!!.jsonPrimitive.content)
          assertEquals("owned-runtime-relay", result["sessionId"]!!.jsonPrimitive.content)
          assertEquals("accepted result", result["result"]!!.jsonObject["text"]!!.jsonPrimitive.content)
        }
        awaitState { frames.any { it["method"]?.jsonPrimitive?.content == "talk.session.close" } }
        assertEquals(
          "owned-runtime-relay",
          frames
            .single { it["method"]?.jsonPrimitive?.content == "talk.session.close" }["params"]!!
            .jsonObject["sessionId"]!!
            .jsonPrimitive.content,
        )
        // Relay run cancellation belongs to server-side close, not client chat.abort.
        assertFalse(frames.any { it["method"]?.jsonPrimitive?.content == "chat.abort" })
        println("selection-relay acceptedResult=1 close=1 clientAbort=0")
      }
    }

  @Test
  fun chatSelectionRetirementSerializesClientConsultFinalAdmission() =
    runBlocking {
      for (schedule in listOf("allowed", "selection-first", "concurrent")) {
        withRuntime(webRtc = true) { runtime, manager, frames ->
          StartupPeerConnection.reset()
          StartupDataChannel.reset()
          runtime.setTalkModeEnabled(true)
          awaitState { StartupPeerConnection.offerCreated.isCompleted }
          StartupPeerConnection.offerCreated.await().onCreateSuccess(SessionDescription(SessionDescription.Type.OFFER, "v=0"))
          StartupDataChannel.open()
          awaitState { manager.isListening.value }
          val client = field<TalkRealtimeClient>(manager, "realtimeClient")
          val coordinator = field<Any>(manager, "realtimeAgentCoordinator")
          val transport = field<RealtimeAgentSession>(coordinator, "activeSession").clientTransport!!
          val chat = field<ChatController>(runtime, "chat")
          val selectionLock = field<Any>(chat, "gatewayScopeApplyLock")
          val generation = chat.selectionGeneration.value
          val checked = CountDownLatch(1)
          val release = CountDownLatch(1)
          val navigationDone = CountDownLatch(1)
          val outcome = AtomicReference<Result<String>>()
          val navigationError = AtomicReference<Throwable>()
          val original = field<() -> Boolean>(client, "isCurrent")
          val consult =
            Thread {
              outcome.set(runCatching { runBlocking { transport.request("talk.client.toolCall", """{"voiceSessionId":"owned-runtime-client","callId":"race","name":"openclaw_agent_consult","args":{}}""", 8_000) } })
            }
          var navigation: Thread? = null
          try {
            // Delay the normal asynchronous collector, not the selection producer.
            synchronized(field<Any>(runtime, "voiceCaptureOwnershipLock")) {
              if (schedule == "selection-first") chat.switchSession("agent:work:b", "work")
              ReflectionHelpers.setField(client, "isCurrent", {
                val current = original()
                if (schedule == "concurrent" && Thread.currentThread() === consult) {
                  checked.countDown()
                  check(release.await(8, TimeUnit.SECONDS)) { "Final admission was not released" }
                }
                current
              })
              consult.start()
              if (schedule == "concurrent") {
                assertTrue("Consult must reach its final currency read", checked.await(8, TimeUnit.SECONDS))
                navigation =
                  Thread {
                    try {
                      chat.switchSession("agent:work:b", "work")
                    } catch (error: Throwable) {
                      navigationError.set(error)
                    } finally {
                      navigationDone.countDown()
                    }
                  }.also { it.start() }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
                while (navigationDone.count != 0L) {
                  val info = ManagementFactory.getThreadMXBean().getThreadInfo(navigation.threadId())
                  if (info?.lockInfo?.identityHashCode == System.identityHashCode(selectionLock) && info.threadState == Thread.State.BLOCKED) break
                  check(System.nanoTime() < deadline) { "Navigation reached neither retirement nor its selection lock" }
                  Thread.yield()
                }
              }
              val retiredBeforeRelease = chat.selectionGeneration.value != generation
              release.countDown()
              consult.join(8_000)
              assertFalse("Consult worker must finish", consult.isAlive)
              navigation?.join(8_000)
              assertFalse("Navigation worker must finish", navigation?.isAlive == true)
              navigationError.get()?.let { throw it }
              val gateway = field<GatewaySession>(runtime, "operatorSession")
              runBlocking { withTimeout(8_000) { gateway.request("test.barrier", "{}") } }
              val consultations = frames.filter { it["method"]?.jsonPrimitive?.content == "talk.client.toolCall" }
              println("selection-client schedule=$schedule retiredBeforeAdmission=$retiredBeforeRelease consultFrames=" + consultations.size)
              assertEquals(if (retiredBeforeRelease) 0 else 1, consultations.size)
              assertEquals(!retiredBeforeRelease, outcome.get().isSuccess)
              if (schedule != "allowed") {
                assertTrue(chat.selectionGeneration.value > generation)
                assertFalse("The normal collector is still held; this is not a call.close test", field<Boolean>(client, "closed"))
                ReflectionHelpers.setField(client, "isCurrent", original)
                val stale = runCatching { runBlocking { transport.request("talk.client.toolCall", """{"voiceSessionId":"owned-runtime-client","callId":"stale","name":"openclaw_agent_consult","args":{}}""", 8_000) } }
                assertTrue(stale.isFailure)
                runBlocking { withTimeout(8_000) { gateway.request("test.barrier", "{}") } }
                assertFalse(
                  frames.any {
                    it["method"]?.jsonPrimitive?.content == "talk.client.toolCall" && it["params"]
                      ?.jsonObject
                      ?.get("callId")
                      ?.jsonPrimitive
                      ?.content == "stale"
                  },
                )
              }
            }
          } finally {
            release.countDown()
            consult.join(8_000)
            navigation?.join(8_000)
            ReflectionHelpers.setField(client, "isCurrent", original)
          }
        }
      }
    }

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

  private suspend fun withRuntime(
    webRtc: Boolean = false,
    httpOffers: java.util.concurrent.atomic.AtomicInteger? = null,
    beforeOfferResponse: (() -> Unit)? = null,
    block: suspend (NodeRuntime, TalkModeManager, ConcurrentLinkedQueue<JsonObject>) -> Unit,
  ) {
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
          if (request.path == "/plugins/openai/realtime/calls") {
            httpOffers?.incrementAndGet()
            beforeOfferResponse?.invoke()
            MockResponse().setBody("v=0")
          } else {
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
                      "talk.config" -> if (webRtc) """{"config":{"talk":{"realtime":{"mode":"realtime","transport":"webrtc"}}}}""" else """{"config":{"talk":{"realtime":{"mode":"realtime","transport":"gateway-relay"}}}}"""
                      "talk.catalog" -> if (webRtc) """{"realtime":{"activeProvider":"openai","providers":[{"id":"openai","transports":["webrtc"],"supportsVideoFrames":true}]}}""" else """{"realtime":{"activeProvider":"openai","providers":[{"id":"openai","transports":["gateway-relay"]}]}}"""
                      "talk.client.create" -> """{"provider":"openai","transport":"webrtc","voiceSessionId":"owned-runtime-client","clientSecret":"synthetic-offer","offerUrl":"/plugins/openai/realtime/calls","model":"synthetic-voice-model","voice":"synthetic-voice","controlSource":"transcript"}"""
                      "talk.session.create" -> """{"relaySessionId":"owned-runtime-relay"}"""
                      "talk.client.toolCall" -> if (webRtc) "{}" else """{"runId":"runtime-run","agentSessionKey":"agent:work:a"}"""
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
