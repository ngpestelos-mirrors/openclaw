package ai.openclaw.app.voice

import ai.openclaw.app.isAndroidRealtimeRelayModelSupported
import ai.openclaw.app.normalizeMainKey
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.Locale

internal data class TalkModeGatewayConfigState(
  val mainSessionKey: String,
  val speechLocale: String?,
  val interruptOnSpeech: Boolean?,
  val silenceTimeoutMs: Long,
  val realtimeRelayModelSupported: Boolean,
  val realtimeTransport: String? = null,
  val realtimeMode: String? = null,
)

internal object TalkModeGatewayConfigParser {
  /** Reads gateway talk/session config into the runtime state TalkMode needs. */
  fun parse(config: JsonObject?): TalkModeGatewayConfigState {
    val talk = config?.get("talk").asObjectOrNull()
    // talk.config carries the top-level model (plus voice-model default) in
    // realtime.model, but a provider-level providers.<id>.model is NOT promoted
    // into it — read the selected provider entry too so relay-recovery eligibility
    // reflects that model. This hint does not select native STT/TTS.
    val realtime = talk?.get("realtime").asObjectOrNull()
    val realtimeProvider = realtime?.get("provider").asStringOrNull()
    val realtimeClientHints =
      config
        ?.get("clientHints")
        .asObjectOrNull()
        ?.get("realtime")
        .asObjectOrNull()
    val realtimeModel =
      realtime?.get("model").asStringOrNull()
        ?: realtimeProvider?.let { provider ->
          realtime
            ?.get("providers")
            .asObjectOrNull()
            ?.get(provider)
            .asObjectOrNull()
            ?.get("model")
            .asStringOrNull()
        }
    val sessionCfg = config?.get("session").asObjectOrNull()
    return TalkModeGatewayConfigState(
      mainSessionKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull()),
      speechLocale = normalizeSpeechLocaleTag(talk?.get("speechLocale").asStringOrNull()),
      interruptOnSpeech = talk?.get("interruptOnSpeech").asBooleanOrNull(),
      silenceTimeoutMs = resolvedSilenceTimeoutMs(talk),
      realtimeTransport = realtime?.get("transport").asStringOrNull(),
      realtimeMode = realtime?.get("mode").asStringOrNull(),
      realtimeRelayModelSupported =
        realtimeClientHints?.get("gatewayRelaySupported").asBooleanOrNull()
          ?: isAndroidRealtimeRelayModelSupported(realtimeModel),
    )
  }

  /** Accepts only numeric whole-millisecond silence timeouts; malformed config uses defaults. */
  fun resolvedSilenceTimeoutMs(talk: JsonObject?): Long {
    val fallback = TalkDefaults.defaultSilenceTimeoutMs
    val primitive = talk?.get("silenceTimeoutMs") as? JsonPrimitive ?: return fallback
    if (primitive.isString) return fallback
    val timeout = primitive.content.toDoubleOrNull() ?: return fallback
    if (timeout <= 0 || timeout % 1.0 != 0.0 || timeout > Long.MAX_VALUE.toDouble()) {
      return fallback
    }
    return timeout.toLong()
  }
}

/** One immutable Talk wire target; capability is captured by the physical request lease. */
internal class TalkWireTarget(
  val lease: ai.openclaw.app.gateway.GatewaySession.RequestLease,
  val sessionKey: String,
  val agentId: String?,
) {
  private val fields: JsonObject by lazy {
    require(sessionKey.isNotBlank() && (agentId == null || agentId.isNotBlank())) { "Talk target is empty" }
    val parts = sessionKey.split(':', limit = 3)
    val scoped =
      parts.size == 3 && parts[0] == "agent" &&
        Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,63}").matches(parts[1]) && parts[2].isNotBlank()
    require(!sessionKey.startsWith("agent:") || scoped) { "Talk session key is malformed" }
    require(!scoped || agentId == null || parts[1].equals(agentId, ignoreCase = true)) { "Talk session owner does not match the selected agent" }
    require(lease.supportsTalkSessionTarget || agentId == null || scoped) { "This Gateway cannot safely target this chat; select an agent-scoped chat or update the Gateway" }
    buildJsonObject {
      put("sessionKey", sessionKey)
      if (lease.supportsTalkSessionTarget) agentId?.let { put("agentId", it) }
    }
  }

  fun parameters(
    method: String,
    raw: String?,
  ): String? {
    if (method !in keyedMethods) return raw
    val body =
      kotlinx.serialization.json.Json
        .parseToJsonElement(raw ?: "{}") as? JsonObject ?: error("Invalid Talk request")
    require(body["sessionKey"] == null || body["sessionKey"] == JsonPrimitive(sessionKey)) { "Talk request changed its captured chat" }
    require(body["agentId"] == null || (agentId != null && body["agentId"] == JsonPrimitive(agentId))) { "Talk request changed its captured agent" }
    if (method == "talk.catalog" && !lease.supportsTalkSessionTarget) return "{}"
    return JsonObject(body.filterKeys { it != "sessionKey" && it != "agentId" } + fields).toString()
  }

  suspend fun request(
    method: String,
    raw: String?,
    timeoutMs: Long = 15_000,
    withEnqueue: (() -> Unit) -> Unit = { it() },
  ): String = lease.request(method, parameters(method, raw), timeoutMs, withEnqueue)

  private companion object {
    val keyedMethods = setOf("talk.catalog", "talk.client.create", "talk.session.create", "talk.client.toolCall", "talk.client.transcript", "talk.client.close", "talk.client.steer")
  }
}

internal enum class AndroidRealtimeRoute { WebRtc, WebRtcWithRelayRecovery, GatewayRelay }

/** Transport capabilities belong to the Gateway; auth choice never locks a provider or model here. */
internal fun resolveAndroidRealtimeRoute(
  configured: String?,
  catalog: JsonObject?,
  relaySupported: Boolean,
): AndroidRealtimeRoute {
  when (configured) {
    "webrtc" -> return AndroidRealtimeRoute.WebRtc
    "gateway-relay", "provider-websocket" -> return AndroidRealtimeRoute.GatewayRelay
    null -> Unit
    else -> error("Configured Talk transport is not supported on Android")
  }
  val selected = selectedAndroidRealtimeProvider(catalog)
  val transports = (selected["transports"] as? JsonArray)?.mapNotNull { it.asStringOrNull() }.orEmpty()
  return when {
    "webrtc" in transports -> if (relaySupported && "gateway-relay" in transports) AndroidRealtimeRoute.WebRtcWithRelayRecovery else AndroidRealtimeRoute.WebRtc
    "gateway-relay" in transports || "provider-websocket" in transports -> AndroidRealtimeRoute.GatewayRelay
    else -> error("Selected Talk provider has no supported Android transport")
  }
}

internal fun selectedAndroidRealtimeProvider(catalog: JsonObject?): JsonObject {
  val group = catalog?.get("realtime").asObjectOrNull() ?: error("Gateway did not return realtime Talk capabilities")
  val active = group["activeProvider"].asStringOrNull() ?: error("No realtime Talk provider is selected")
  val selected =
    (group["providers"] as? JsonArray)?.mapNotNull { it.asObjectOrNull() }?.firstOrNull { provider ->
      provider["id"].asStringOrNull() == active ||
        (provider["aliases"] as? JsonArray)?.any { it.asStringOrNull() == active } == true
    } ?: error("Gateway selected an unavailable Talk provider")
  return selected
}

private fun JsonElement?.asStringOrNull(): String? =
  this
    ?.let { element ->
      element as? JsonPrimitive
    }?.contentOrNull

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.booleanOrNull
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

internal fun normalizeSpeechLocaleTag(value: String?): String? {
  val candidate =
    value
      ?.trim()
      ?.replace('_', '-')
      ?.takeIf(String::isNotEmpty)
      ?: return null
  val locale = Locale.forLanguageTag(candidate)
  return locale
    .toLanguageTag()
    .takeIf { tag -> locale.language.isNotBlank() && tag != "und" }
}

internal fun realtimeTranscriptionLanguage(localeTag: String?): String? =
  localeTag
    ?.let(Locale::forLanguageTag)
    ?.language
    ?.lowercase(Locale.ROOT)
    ?.takeIf { language ->
      language.length == ISO_639_1_LANGUAGE_LENGTH &&
        language.all { character -> character in 'a'..'z' }
    }

internal fun resolveRealtimeTranscriptionLanguageHint(
  configuredLocaleTag: String?,
  requestedLanguage: String?,
  deviceLocaleTag: String?,
): String? =
  realtimeTranscriptionLanguage(
    configuredLocaleTag
      ?: requestedLanguage
      ?: deviceLocaleTag,
  )

private const val ISO_639_1_LANGUAGE_LENGTH = 2
