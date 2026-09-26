package ai.openclaw.app

import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.chat.ChatThinkingLevelOption
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

data class GatewayModelSummary(
  val id: String,
  val name: String,
  val provider: String,
  val available: Boolean?,
  val unavailableReason: GatewayModelUnavailableReason? = null,
  val supportsVision: Boolean,
  val supportsAudio: Boolean,
  val supportsVideo: Boolean,
  val supportsDocuments: Boolean,
  val supportsReasoning: Boolean,
  val contextTokens: Long?,
  val supportsFastMode: Boolean? = null,
  val manualSelectionAllowed: Boolean? = null,
  val effectiveFastMode: ChatFastMode? = null,
  val thinkingLevels: List<ChatThinkingLevelOption>? = null,
  val thinkingDefault: String? = null,
  val supportsTools: Boolean? = null,
  val agentRuntime: JsonObject? = null,
  val unavailableUntil: Long? = null,
  val tags: Set<String> = emptySet(),
) {
  val runtimeName: String?
    get() =
      if (agentRuntime?.get("source")?.jsonPrimitive?.content in setOf("model", "provider")) {
        when (agentRuntime?.get("id")?.jsonPrimitive?.content) {
          "codex", "codex-cli" -> "Codex"
          "claude-cli" -> "Claude CLI"
          "google-gemini-cli" -> "Gemini CLI"
          "openclaw" -> "OpenClaw"
          else -> null
        }
      } else {
        null
      }
}

enum class GatewayModelUnavailableReason {
  MissingAuth,
  AuthFailed,
  Cooldown,
}

internal data class GatewayModelCatalogResult(
  val models: List<GatewayModelSummary>,
  val refreshFailed: Boolean,
  val tagsDescribeDefaults: Boolean,
)

internal fun parseGatewayModelCatalog(root: JsonObject?): GatewayModelCatalogResult =
  GatewayModelCatalogResult(
    models = parseGatewayModels(root?.get("models") as? JsonArray),
    refreshFailed = root?.get("refreshFailed")?.jsonPrimitive?.booleanOrNull == true,
    tagsDescribeDefaults = root?.get("tagsScope")?.jsonPrimitive?.content == "defaults",
  )

internal fun parseGatewayModels(models: JsonArray?): List<GatewayModelSummary> =
  models.orEmpty().map { item ->
    val row = item.jsonObject
    val input = (row["input"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet()
    GatewayModelSummary(
      id = row.getValue("id").jsonPrimitive.content,
      name = row.getValue("name").jsonPrimitive.content,
      provider = row.getValue("provider").jsonPrimitive.content,
      available = row["available"]?.jsonPrimitive?.booleanOrNull,
      unavailableReason =
        when (row["unavailableReason"]?.jsonPrimitive?.content) {
          "missing-auth" -> GatewayModelUnavailableReason.MissingAuth
          "auth-failed" -> GatewayModelUnavailableReason.AuthFailed
          "cooldown" -> GatewayModelUnavailableReason.Cooldown
          else -> null
        },
      supportsVision = "image" in input,
      supportsAudio = "audio" in input,
      supportsVideo = "video" in input,
      supportsDocuments = "document" in input,
      supportsReasoning = row["reasoning"]?.jsonPrimitive?.booleanOrNull == true,
      contextTokens = row["contextTokens"]?.jsonPrimitive?.longOrNull ?: row["contextWindow"]?.jsonPrimitive?.longOrNull,
      supportsFastMode = row["supportsFastMode"]?.jsonPrimitive?.booleanOrNull,
      manualSelectionAllowed = row["manualSelectionAllowed"]?.jsonPrimitive?.booleanOrNull,
      effectiveFastMode = ChatFastMode.fromWireValue(row["effectiveFastMode"]?.jsonPrimitive?.content),
      thinkingLevels =
        (row["thinkingLevels"] as? JsonArray)?.map {
          val option = it.jsonObject
          ChatThinkingLevelOption(option.getValue("id").jsonPrimitive.content, option.getValue("label").jsonPrimitive.content)
        },
      thinkingDefault = row["thinkingDefault"]?.jsonPrimitive?.content,
      supportsTools = row["supportsTools"]?.jsonPrimitive?.booleanOrNull,
      agentRuntime = row["agentRuntime"]?.jsonObject,
      unavailableUntil = row["unavailableUntil"]?.jsonPrimitive?.longOrNull,
      tags = (row["tags"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet(),
    )
  }

data class GatewayModelProviderSummary(
  val id: String,
  val displayName: String,
  val status: String,
  val authType: String? = null,
  val renewalFailed: Boolean = false,
  val authProviderId: String = id,
)

internal fun parseGatewayModelProviders(providers: JsonArray?): List<GatewayModelProviderSummary> =
  providers.orEmpty().mapNotNull { item ->
    val row = item as? JsonObject ?: return@mapNotNull null
    val id =
      row["provider"]
        ?.jsonPrimitive
        ?.content
        ?.trim()
        ?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
    val profiles = (row["profiles"] as? JsonArray).orEmpty().map { it.jsonObject }
    val order = (row["profileOrder"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet()
    val activeProfiles = profiles.filter { it["reasonCode"]?.jsonPrimitive?.content != "setup_inactive" && (order == null || it["profileId"]?.jsonPrimitive?.content in order) }
    val types = activeProfiles.mapNotNull { it["type"]?.jsonPrimitive?.content }
    val status =
      row["status"]
        ?.jsonPrimitive
        ?.content
        ?.trim()
        ?.takeIf(String::isNotEmpty) ?: "unknown"
    GatewayModelProviderSummary(
      id = id,
      displayName =
        row["displayName"]
          ?.jsonPrimitive
          ?.content
          ?.trim()
          ?.takeIf(String::isNotEmpty) ?: providerDisplayName(id),
      status = status,
      authType =
        if ("oauth" in types) {
          "oauth"
        } else if ("api_key" in types || row["apiKey"] is JsonObject) {
          "api_key"
        } else {
          types.firstOrNull()
        },
      renewalFailed = status == "expired" && activeProfiles.any { it["renewalFailed"]?.jsonPrimitive?.booleanOrNull == true },
      authProviderId = row["authProvider"]?.jsonPrimitive?.content ?: id,
    )
  }
