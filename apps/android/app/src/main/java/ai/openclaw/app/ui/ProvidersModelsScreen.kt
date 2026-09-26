package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.ProviderAuthProvider
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Provider inventory and sign-in; model selection remains in agent settings. */
@Composable
internal fun ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val gatewayId by viewModel.activeGatewayStableId.collectAsState()
  val selectionGeneration by viewModel.chatSelectionGeneration.collectAsState()
  val models by viewModel.providerModelCatalog.collectAsState()
  val tagsDescribeDefaults by viewModel.providerModelTagsDescribeDefaults.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val capabilities by viewModel.modelAuthCapabilities.collectAsState()
  val refreshing by viewModel.providerModelCatalogRefreshing.collectAsState()
  val errorText by viewModel.providerModelCatalogErrorText.collectAsState()
  var query by rememberSaveable(gatewayId) { mutableStateOf("") }
  var expandedProviders by rememberSaveable(gatewayId) { mutableStateOf(emptyList<String>()) }
  var expandedMore by rememberSaveable(gatewayId) { mutableStateOf(emptyList<String>()) }
  var signIn by remember { mutableStateOf<ProviderAuthController?>(null) }
  var signInProvider by remember { mutableStateOf<String?>(null) }
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  val rows = providerRows(providers, models)
  val search = query.trim()
  val searching = search.isNotEmpty()
  val visibleRows =
    if (!searching) {
      rows
    } else {
      rows.mapNotNull { row ->
        val matches = row.models.filter { it.name.contains(search, ignoreCase = true) || it.id.contains(search, ignoreCase = true) }
        if (matches.isEmpty()) null else row.copy(models = matches)
      }
    }

  fun openSignIn(provider: String?) {
    val controller = viewModel.createProviderAuthController(viewModel.captureChatShareOwner())
    if (controller == null) {
      scope.launch { snackbar.showSnackbar(nativeString("Sign-in is unavailable. Reconnect with administrator access and try again.")) }
      return
    }
    signIn?.close()
    signInProvider = provider
    signIn = controller
  }

  LaunchedEffect(isConnected, gatewayId, selectionGeneration) {
    signIn?.close()
    signIn = null
    if (isConnected) viewModel.refreshProviderModels()
  }

  signIn?.let { controller ->
    ProviderSignInDialog(
      controller = controller,
      initialProviderId = signInProvider,
      onConnected = { provider ->
        expandedProviders = (expandedProviders + provider + rows.filter { it.auth?.authProviderId == provider }.map { it.id }).distinct()
        scope.launch { snackbar.showSnackbar(nativeString("\$provider connected", providerDisplayName(provider))) }
      },
      onDismiss = { signIn = null },
    )
  }

  ClawScaffold(
    contentPadding = PaddingValues(horizontal = ClawTheme.spacing.sm, vertical = ClawTheme.spacing.xxs),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    Box(Modifier.fillMaxSize()) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs),
        contentPadding = PaddingValues(bottom = ClawTheme.spacing.sm),
      ) {
        item(key = "header") {
          Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
              Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back"), tint = ClawTheme.colors.text)
            }
            Text(
              nativeString("Providers and models"),
              modifier = Modifier.weight(1f),
              style = ClawTheme.type.title,
              color = ClawTheme.colors.text,
            )
            IconButton(onClick = { viewModel.refreshProviderModels(refresh = true) }, enabled = isConnected && !refreshing) {
              Icon(Icons.Default.Refresh, contentDescription = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"), tint = ClawTheme.colors.textMuted)
            }
          }
        }
        item(key = "search") {
          ClawTextField(value = query, onValueChange = { query = it }, placeholder = nativeString("Search models"), modifier = Modifier.semantics { contentDescription = nativeString("Search models") }, maxLines = 1)
        }
        item(key = "summary") {
          Text(
            if (models.size == 1) nativeString("Providers · \$ready ready · 1 model", rows.count { it.ready }) else nativeString("Providers · \$ready ready · \$models models", rows.count { it.ready }, models.size),
            modifier = Modifier.padding(vertical = ClawTheme.spacing.xs),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        when {
          !isConnected && rows.isEmpty() -> {
            item { ClawEmptyState(title = nativeString("Gateway offline"), body = nativeString("Connect your Gateway to load provider readiness.")) }
          }

          searching && visibleRows.isEmpty() -> {
            item { Text(nativeString("No models match \"\$query\"", query), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) }
          }

          rows.isEmpty() -> {
            item { Text(if (refreshing) nativeString("Loading providers…") else nativeString("No providers connected"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) }
          }

          else -> {
            providerListItems(
              rows = visibleRows,
              capabilities = capabilities,
              tagsDescribeDefaults = tagsDescribeDefaults,
              searching = searching,
              expandedProviders = expandedProviders,
              expandedMore = expandedMore,
              canSignIn = isConnected,
              onToggle = { id -> expandedProviders = if (id in expandedProviders) expandedProviders - id else expandedProviders + id },
              onToggleMore = { id -> expandedMore = if (id in expandedMore) expandedMore - id else expandedMore + id },
              onSignIn = ::openSignIn,
            )
          }
        }
        if (!searching) {
          item(key = "add-provider") {
            TextButton(onClick = { openSignIn(null) }, enabled = isConnected, modifier = Modifier.fillMaxWidth()) {
              Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
              Text(nativeString("Add provider"), modifier = Modifier.padding(start = ClawTheme.spacing.xxs))
            }
          }
        }
        errorText?.let { message ->
          item(key = "error") {
            ClawPanel { Text(message, style = ClawTheme.type.body, color = ClawTheme.colors.warning) }
          }
        }
      }
      SnackbarHost(snackbar, modifier = Modifier.align(Alignment.BottomCenter))
    }
  }
}

internal data class ProviderRow(
  val id: String,
  val name: String,
  val status: String,
  val availability: ProviderAvailability,
  val modelCount: Int,
  val models: List<GatewayModelSummary> = emptyList(),
  val auth: GatewayModelProviderSummary? = null,
) {
  val ready: Boolean
    get() = availability == ProviderAvailability.Available

  val renewalFailed: Boolean
    get() = auth?.renewalFailed == true && !ready
}

internal enum class ProviderAvailability {
  Available,
  Unavailable,
  Unknown,
}

/** Combines gateway auth-provider readiness with configured model providers. */
internal fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): List<ProviderRow> {
  val providersById = providers.associateBy { it.id.normalizedProviderId() }
  val modelsByProvider =
    models
      .groupBy { it.provider.normalizedProviderId() }
      .mapValues { (_, providerModels) -> providerModels.sortedWith(modelComparator) }
  val providerIds = providersById.keys + modelsByProvider.keys
  return providerIds
    .map { providerId ->
      val providerModels = modelsByProvider[providerId].orEmpty()
      val authProvider = providersById[providerId]
      val availability = providerAvailability(authProvider = authProvider, models = providerModels)
      val displayId = providerModels.firstOrNull()?.provider?.takeIf { it.isNotBlank() } ?: authProvider?.id ?: providerId
      ProviderRow(
        id = displayId,
        name = authProvider?.displayName ?: providerDisplayName(displayId),
        status = availability.label,
        availability = availability,
        modelCount = providerModels.size,
        models = providerModels,
        auth = authProvider,
      )
    }.sortedWith(compareBy(::providerPriority, { it.name.lowercase() }))
}

private val ProviderAvailability.label: String
  get() =
    when (this) {
      ProviderAvailability.Available -> nativeString("Ready")
      ProviderAvailability.Unavailable -> nativeString("Needs attention")
      ProviderAvailability.Unknown -> nativeString("Unknown")
    }

private fun providerAvailability(
  authProvider: GatewayModelProviderSummary?,
  models: List<GatewayModelSummary>,
): ProviderAvailability {
  if (models.any { it.available == true }) return ProviderAvailability.Available
  if (authProvider?.renewalFailed == true) return ProviderAvailability.Unavailable
  if (models.isNotEmpty()) {
    return if (models.all { it.available == false }) ProviderAvailability.Unavailable else ProviderAvailability.Unknown
  }
  return if (authProvider != null && modelProviderReady(authProvider.status)) {
    ProviderAvailability.Available
  } else {
    ProviderAvailability.Unavailable
  }
}

private fun String.normalizedProviderId(): String = trim().lowercase()

/** Normalizes gateway provider status strings into a ready/not-ready boolean. */
internal fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" ||
    normalized == "ready" ||
    normalized == "healthy" ||
    normalized == "configured" ||
    normalized == "static"
}

private val modelComparator =
  compareBy<GatewayModelSummary>(
    {
      if ("default" in it.tags) {
        0
      } else if (it.tags.any { tag -> tag.startsWith("fallback#") }) {
        1
      } else {
        2
      }
    },
    { it.name.lowercase() },
    { it.id.lowercase() },
  )

private fun providerPriority(row: ProviderRow): Int = providerPriority(row.id)

private fun providerPriority(provider: String): Int =
  when (provider.trim().lowercase()) {
    "openai" -> 0
    "anthropic" -> 1
    "google" -> 2
    "openrouter" -> 3
    "ollama", "ollama-local" -> 4
    "codex" -> 5
    else -> 100
  }

private fun LazyListScope.providerListItems(
  rows: List<ProviderRow>,
  capabilities: List<ProviderAuthProvider>,
  tagsDescribeDefaults: Boolean,
  searching: Boolean,
  expandedProviders: List<String>,
  expandedMore: List<String>,
  canSignIn: Boolean,
  onToggle: (String) -> Unit,
  onToggleMore: (String) -> Unit,
  onSignIn: (String) -> Unit,
) {
  rows.forEach { row ->
    val expanded = searching || row.id in expandedProviders
    val authProviderId = row.auth?.authProviderId ?: row.id
    val capability = capabilities.firstOrNull { it.id == authProviderId }
    item(key = "provider:${row.id}") {
      ProviderListRow(row, capability, expanded, showSignIn = !searching, canSignIn = canSignIn, onToggle = { onToggle(row.id) }, onSignIn = { onSignIn(authProviderId) })
    }
    if (expanded) {
      if (!searching) {
        item(key = "signin:${row.id}") {
          if (capability?.canSignIn == true) {
            TextButton(onClick = { onSignIn(authProviderId) }, enabled = canSignIn) {
              Text(
                if (row.renewalFailed) nativeString("Sign in again") else nativeString("Manage sign-in"),
                color = if (row.renewalFailed) ClawTheme.colors.danger else ClawTheme.colors.textMuted,
              )
            }
          } else {
            Text(
              nativeString("Sign-in is managed on the computer"),
              modifier = Modifier.padding(ClawTheme.spacing.xs),
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
            )
          }
        }
      }
      val (configured, more) = row.models.partition { model -> model.tags.any { it == "default" || it == "configured" || it.startsWith("fallback#") } }
      val visible = if (searching) row.models else configured
      items(visible, key = { "model:${row.id}:${it.id}:${it.runtimeName}" }) { model -> ProviderModelRow(model, row.availability, tagsDescribeDefaults) }
      if (!searching && more.isNotEmpty()) {
        item(key = "more:${row.id}") {
          TextButton(onClick = { onToggleMore(row.id) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (more.size == 1) nativeString("1 more model") else nativeString("\$count more models", more.size), modifier = Modifier.weight(1f))
            Icon(if (row.id in expandedMore) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = if (row.id in expandedMore) nativeString("Collapse") else nativeString("Expand"))
          }
        }
        if (row.id in expandedMore) {
          items(more, key = { "model:${row.id}:${it.id}:${it.runtimeName}" }) { model -> ProviderModelRow(model, row.availability, tagsDescribeDefaults) }
        }
      }
      if (row.models.isEmpty()) {
        item(key = "empty:${row.id}") {
          Text(
            if (row.ready) nativeString("Connected, no models configured") else nativeString("No models configured"),
            modifier = Modifier.padding(ClawTheme.spacing.xs),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
  }
}

@Composable
private fun ProviderListRow(
  row: ProviderRow,
  capability: ProviderAuthProvider?,
  expanded: Boolean,
  showSignIn: Boolean,
  canSignIn: Boolean,
  onToggle: () -> Unit,
  onSignIn: () -> Unit,
) {
  val missing = row.auth?.status == "missing" && !row.ready && !row.renewalFailed
  val failed = row.renewalFailed
  val statusColor = if (failed) ClawTheme.colors.danger else row.availability.color()
  val expansionState = if (expanded) nativeString("Expanded") else nativeString("Collapsed")
  Surface(
    onClick = onToggle,
    modifier = Modifier.fillMaxWidth().semantics { stateDescription = expansionState },
    shape = RoundedCornerShape(ClawTheme.radii.row),
    color = if (missing) ClawTheme.colors.warningSoft else ClawTheme.colors.surface,
  ) {
    Row(
      modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget).padding(horizontal = ClawTheme.spacing.xs, vertical = ClawTheme.spacing.xxs),
      horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(
        Modifier
          .size(7.dp)
          .clip(CircleShape)
          .background(statusColor)
          .semantics { contentDescription = row.status },
      )
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(row.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
          providerSignInSubtitle(row, capability),
          style = ClawTheme.type.caption,
          color = if (failed) ClawTheme.colors.danger else ClawTheme.colors.textMuted,
        )
      }
      Text(row.modelCount.toString(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      if (missing && showSignIn && capability?.canSignIn == true) {
        TextButton(onClick = onSignIn, enabled = canSignIn) { Text(nativeString("Sign in")) }
      }
      Icon(if (expanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(18.dp), tint = ClawTheme.colors.textMuted)
    }
  }
}

private fun providerSignInSubtitle(
  row: ProviderRow,
  capability: ProviderAuthProvider?,
): String =
  when {
    row.renewalFailed -> nativeString("Renewal failed · sign in again")
    capability?.canSignIn != true -> nativeString("Set up on computer")
    row.auth?.status == "missing" && !row.ready -> nativeString("Not signed in")
    row.auth?.authType == "oauth" -> if (row.id == "openai") nativeString("ChatGPT sign-in · renews automatically") else nativeString("Account sign-in · renews automatically")
    row.auth?.authType == "api_key" -> nativeString("API key")
    row.auth?.authType == "token" -> nativeString("Token")
    else -> row.status
  }

@Composable
private fun ProviderModelRow(
  model: GatewayModelSummary,
  providerAvailability: ProviderAvailability,
  tagsDescribeDefaults: Boolean,
) {
  val availability = model.available.toProviderAvailability()
  Column(Modifier.fillMaxWidth().padding(horizontal = ClawTheme.spacing.xs, vertical = ClawTheme.spacing.xxs)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs)) {
      Text(model.name, modifier = Modifier.weight(1f), style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (tagsDescribeDefaults && "default" in model.tags) ModelTag(nativeString("Gateway default"), emphasized = true)
      if (tagsDescribeDefaults && model.tags.any { it.startsWith("fallback#") }) ModelTag(nativeString("Fallback"))
      model.contextTokens?.let { ModelTag(formatContextTokens(it)) }
    }
    if (availability != providerAvailability) {
      Text(
        when (availability) {
          ProviderAvailability.Available -> nativeString("Available")
          ProviderAvailability.Unavailable -> nativeString("Unavailable")
          ProviderAvailability.Unknown -> nativeString("Availability unknown")
        },
        style = ClawTheme.type.caption,
        color = availability.color(),
      )
    }
  }
}

@Composable
private fun ModelTag(
  label: String,
  emphasized: Boolean = false,
) {
  Surface(shape = RoundedCornerShape(ClawTheme.radii.row), color = if (emphasized) ClawTheme.colors.successSoft else ClawTheme.colors.surfacePressed) {
    Text(label, modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp), style = ClawTheme.type.captionSmall, color = if (emphasized) ClawTheme.colors.success else ClawTheme.colors.textMuted, maxLines = 1)
  }
}

@Composable
private fun ProviderAvailability.color(): Color =
  when (this) {
    ProviderAvailability.Available -> ClawTheme.colors.success
    ProviderAvailability.Unavailable -> ClawTheme.colors.warning
    ProviderAvailability.Unknown -> ClawTheme.colors.textSubtle
  }

private fun Boolean?.toProviderAvailability(): ProviderAvailability =
  when (this) {
    true -> ProviderAvailability.Available
    false -> ProviderAvailability.Unavailable
    null -> ProviderAvailability.Unknown
  }

private fun formatContextTokens(tokens: Long): String = if (tokens >= 1_000) "${tokens / 1_000}k" else tokens.toString()
