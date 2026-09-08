package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.coroutines.CoroutineScope

internal fun createTestTalkRealtimeClient(
  context: Context,
  scope: CoroutineScope,
  lease: GatewaySession.RequestLease,
  sessionKey: String,
  onStatus: (String) -> Unit,
  onTranscript: (String, String, Boolean) -> Unit,
  onFailure: (String) -> Unit,
  preferredAudioInputDevice: () -> String? = { null },
  onInputRequested: (String?) -> Unit = {},
  coordinator: RealtimeAgentCoordinator = RealtimeAgentCoordinator(scope, { method, params, timeout -> lease.request(method, params, timeout) }),
  isCurrent: () -> Boolean = { true },
  supportsCamera: Boolean = false,
  onRecoverableError: (String) -> Unit = {},
): TalkRealtimeClient =
  TalkRealtimeClient(
    context,
    scope,
    lease,
    sessionKey,
    coordinator,
    isCurrent,
    supportsCamera = supportsCamera,
    onStatus = onStatus,
    onTranscript = onTranscript,
    onFailure = onFailure,
    onRecoverableError = onRecoverableError,
    preferredAudioInputDevice = preferredAudioInputDevice,
    onInputRequested = onInputRequested,
    withAdmission = { it() },
  )
