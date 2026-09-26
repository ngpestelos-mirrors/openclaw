package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.ProviderAuthProvider
import ai.openclaw.app.ProviderAuthState
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.parseGatewayModelCatalog
import ai.openclaw.app.parseGatewayModelProviders
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ProvidersModelsScreenTest {
  @get:Rule val composeRule = createComposeRule()
  private val store = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    originalRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("providers-proof-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(true)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { store.put("providers-proof", it) }
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
    // Screenshot runtime owns in-memory state and intentionally disables network refresh.
    val catalog = parseGatewayModelCatalog(Json.parseToJsonElement(modelCatalog()).jsonObject)
    ReflectionHelpers.getField<MutableStateFlow<List<GatewayModelSummary>>>(runtime, "_providerModelCatalog").value = catalog.models
    ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_providerModelTagsDescribeDefaults").value = catalog.tagsDescribeDefaults
    val authStatus = Json.parseToJsonElement(providerCatalog).jsonObject
    ReflectionHelpers.getField<MutableStateFlow<List<GatewayModelProviderSummary>>>(runtime, "_modelAuthProviders").value =
      parseGatewayModelProviders(authStatus["providers"] as JsonArray)
    ReflectionHelpers.getField<MutableStateFlow<List<ProviderAuthProvider>>>(runtime, "modelAuthCapabilitiesState").value =
      ProviderAuthState(authStatus = authStatus).providers
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    try {
      composeRule.runOnIdle { mounted.value = false }
    } finally {
      try {
        store.clear()
      } finally {
        bindNodeRuntimeTestFixture(app, originalRuntime)
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
          AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        }
      }
    }
  }

  @Test
  fun providerExpansionAndSearchExposeAdditionalModelsWithoutSelectingThem() {
    show(dark = true)
    composeRule.onNodeWithText("OpenAI").assertIsDisplayed()
    composeRule.onNodeWithText("Anthropic").assertIsDisplayed()
    composeRule.onNodeWithText("Ollama").assertIsDisplayed()
    composeRule.onNodeWithText("GPT-4.1").assertDoesNotExist()
    capture("providers-dark")

    composeRule.onNodeWithText("OpenAI").performClick()
    composeRule.onNodeWithText("GPT-4.1").assertIsDisplayed().assertHasNoClickAction()
    composeRule.onNodeWithText("In use").assertIsDisplayed()
    composeRule.onNodeWithText("o3").assertIsDisplayed()
    composeRule.onNodeWithText("GPT-4o").assertDoesNotExist()
    composeRule.onNodeWithText("Manage sign-in").assertIsDisplayed()
    capture("providers-expanded-dark")

    composeRule.onNodeWithText("5 more models").performClick()
    composeRule
      .onNodeWithText("GPT-4o")
      .performScrollTo()
      .assertIsDisplayed()
      .assertHasNoClickAction()
    val search = composeRule.onNodeWithContentDescription("Search models")
    search.performScrollTo().performTextReplacement("nano")
    composeRule.onNodeWithText("GPT-4.1 nano").assertIsDisplayed()
    composeRule.onNodeWithText("GPT-4.1").assertDoesNotExist()
    composeRule.onNodeWithText("Anthropic").assertDoesNotExist()
    composeRule.onNodeWithText("5 more models").assertDoesNotExist()
    composeRule.onNodeWithText("Manage sign-in").assertDoesNotExist()
    composeRule.onNodeWithText("Add provider").assertDoesNotExist()
    capture("providers-search-dark")

    search.performTextReplacement("no-such-model")
    composeRule.onNodeWithText("No models match \"no-such-model\"").assertIsDisplayed()
    search.performTextReplacement("")
    composeRule.onNodeWithText("GPT-4.1").assertIsDisplayed()
    composeRule.onNodeWithText("GPT-4o").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("OpenAI").performScrollTo().performClick()
    composeRule.onNodeWithText("GPT-4.1").assertDoesNotExist()
    composeRule.onNodeWithText("GPT-4o").assertDoesNotExist()
    composeRule.onNodeWithText("OpenAI").performClick()
    composeRule.onNodeWithText("In use").assertIsDisplayed()
    composeRule.runOnIdle {
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_providerModelTagsDescribeDefaults").value = false
    }
    composeRule.onNodeWithText("In use").assertDoesNotExist()
    composeRule.onNodeWithText("GPT-4.1").assertIsDisplayed()
  }

  private fun show(dark: Boolean) {
    composeRule.setContent {
      if (mounted.value) {
        ClawDesignTheme(dark = dark) { ProvidersModelsScreen(model, onBack = {}) }
      }
    }
    composeRule.waitForIdle()
    assertEquals(19, model.providerModelCatalog.value.size)
    assertEquals(3, model.modelAuthProviders.value.size)
    assertEquals(null, model.providerModelCatalogErrorText.value)
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_PROVIDER_PROOF_DIR") ?: return
    val target = File(directory, name + ".png")
    check(!target.exists()) { "Proof captures must not overwrite earlier images" }
    requireNotNull(target.parentFile).mkdirs()
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertEquals(390, image.width)
    assertTrue(image.height > 750)
    target.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  private fun modelCatalog(): String {
    val inventory =
      listOf(
        Triple("openai", "GPT-4.1", "default"),
        Triple("openai", "GPT-4.1 mini", "configured"),
        Triple("openai", "GPT-4.1 nano", ""),
        Triple("openai", "GPT-4o", ""),
        Triple("openai", "GPT-4o mini", ""),
        Triple("openai", "o3", "configured"),
        Triple("openai", "o4 mini", ""),
        Triple("openai", "GPT-4 Turbo", ""),
        Triple("anthropic", "Claude Sonnet 4", "fallback#1"),
        Triple("anthropic", "Claude Opus 4", "configured"),
        Triple("anthropic", "Claude Sonnet 3.7", ""),
        Triple("anthropic", "Claude Sonnet 3.5", ""),
        Triple("anthropic", "Claude Haiku 3.5", ""),
        Triple("anthropic", "Claude Opus 3", ""),
        Triple("ollama", "Llama 3.3", "configured"),
        Triple("ollama", "Qwen 2.5", ""),
        Triple("ollama", "Gemma 3", ""),
        Triple("ollama", "DeepSeek R1", ""),
        Triple("ollama", "Llama 3.2", ""),
      )
    return buildJsonObject {
      put("tagsScope", "defaults")
      put(
        "models",
        JsonArray(
          inventory.map { (provider, name, tag) ->
            buildJsonObject {
              put("id", name.lowercase().replace(' ', '-'))
              put("name", name)
              put("provider", provider)
              put("available", provider != "anthropic")
              put(
                "contextTokens",
                if (provider == "openai") {
                  128_000
                } else if (provider == "anthropic") {
                  200_000
                } else {
                  32_000
                },
              )
              put("input", JsonArray(listOf(JsonPrimitive("text"), JsonPrimitive("image"))))
              put("reasoning", name == "o3" || name == "o4 mini")
              put("tags", JsonArray(if (tag.isEmpty()) emptyList() else listOf(JsonPrimitive(tag))))
            }
          },
        ),
      )
    }.toString()
  }

  private val providerCatalog = """{"ts":1790370000000,"providers":[
    {"provider":"openai","displayName":"OpenAI","status":"ok","profiles":[{"profileId":"openai:default","type":"oauth","status":"ok"}]},
    {"provider":"anthropic","displayName":"Anthropic","status":"missing","profiles":[]},
    {"provider":"ollama","displayName":"Ollama","status":"ok","profiles":[]}
  ],"providerCapabilities":[
    {"provider":"openai","apiKeySupported":true,"quickApiKeySetup":true,"loginOptions":[{"id":"openai:oauth","brandId":"openai","label":"ChatGPT sign-in","groupLabel":"OpenAI","kind":"oauth","featured":true}]},
    {"provider":"anthropic","apiKeySupported":true,"quickApiKeySetup":true,"loginOptions":[]},
    {"provider":"ollama","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[]},
    {"provider":"google","apiKeySupported":true,"quickApiKeySetup":true,"loginOptions":[]}
  ]}"""
}
