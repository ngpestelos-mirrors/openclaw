package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelCatalogRequestTest {
  @Test
  fun providerAuthProjectionOnlyReportsOwnerConfirmedRenewalFailure() {
    val payload =
      Json
        .parseToJsonElement(
          """[
        {"provider":"expired","status":"expired","profiles":[{"profileId":"expired:main","type":"oauth","status":"expired"}]},
        {"provider":"pending","status":"expired","profiles":[{"profileId":"pending:main","type":"oauth","status":"expired","reasonCode":"expired"}]},
        {"provider":"failed","status":"expired","profiles":[{"profileId":"failed:main","type":"oauth","status":"expired","renewalFailed":true}]},
        {"provider":"excluded","status":"ok","profileOrder":["excluded:active"],"profiles":[{"profileId":"excluded:inactive","type":"oauth","renewalFailed":true},{"profileId":"excluded:active","type":"api_key","status":"static"}]},
        {"provider":"healthy-sibling","status":"ok","profiles":[{"profileId":"healthy-sibling:failed","type":"oauth","renewalFailed":true},{"profileId":"healthy-sibling:active","type":"oauth","status":"ok"}]},
        {"provider":"alias","authProvider":"canonical","status":"static","apiKey":{"configured":true},"profiles":[]}
      ]""",
        ).jsonArray
    val providers = parseGatewayModelProviders(payload)

    assertEquals(listOf(false, false, true, false, false, false), providers.map { it.renewalFailed })
    assertEquals(listOf("oauth", "oauth", "oauth", "api_key", "oauth", "api_key"), providers.map { it.authType })
    assertEquals("canonical", providers.last().authProviderId)
  }

  @Test
  fun prefersEffectiveContextCapOverNativeWindow() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[{"id":"model","name":"Model","provider":"example","contextWindow":128000,"contextTokens":96000}]""",
          ).jsonArray,
      )

    assertEquals(96_000L, models.single().contextTokens)
  }

  @Test
  fun preservesKnownAvailabilityReasonsAndFailsOpenForUnknownReasons() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """
            [
              {"id":"missing","name":"Missing","provider":"synthetic","available":false,"unavailableReason":"missing-auth"},
              {"id":"failed","name":"Failed","provider":"synthetic","available":false,"unavailableReason":"auth-failed"},
              {"id":"cooling","name":"Cooling","provider":"synthetic","available":false,"unavailableReason":"cooldown"},
              {"id":"future","name":"Future","provider":"synthetic","available":false,"unavailableReason":"future-reason"}
            ]
            """.trimIndent(),
          ).jsonArray,
      )

    assertEquals(GatewayModelUnavailableReason.MissingAuth, models[0].unavailableReason)
    assertEquals(GatewayModelUnavailableReason.AuthFailed, models[1].unavailableReason)
    assertEquals(GatewayModelUnavailableReason.Cooldown, models[2].unavailableReason)
    assertEquals(null, models[3].unavailableReason)
  }

  @Test
  fun reportsProviderConfigUnsupportedWithoutSubstitutingConfiguredView() =
    runBlocking {
      val requests = mutableListOf<String>()
      var actual: Throwable? = null

      try {
        requestProviderModelConfig(agentId = "beta", refresh = true) { paramsJson ->
          requests += paramsJson
          throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unsupported view"))
        }
      } catch (err: Throwable) {
        actual = err
      }

      assertTrue(actual is ProviderModelConfigUnsupported)
      assertEquals(
        listOf(Json.parseToJsonElement("""{"view":"provider-config","agentId":"beta","refresh":true}""")),
        requests.map(Json::parseToJsonElement),
      )
    }

  @Test
  fun preservesNonCompatibilityGatewayFailures() =
    runBlocking {
      val expected = GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "gateway busy"))
      var actual: Throwable? = null

      try {
        requestProviderModelConfig(agentId = "beta") { throw expected }
      } catch (err: Throwable) {
        actual = err
      }

      assertSame(expected, actual)
    }
}
