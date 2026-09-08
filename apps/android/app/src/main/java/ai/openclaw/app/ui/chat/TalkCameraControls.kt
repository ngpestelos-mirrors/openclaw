package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withContext

@Composable
internal fun TalkCameraControls(viewModel: MainViewModel) {
  val callId by viewModel.talkCameraCallId.collectAsState()
  if (callId == null) return
  val context = LocalContext.current
  var enabled by remember(callId) { mutableStateOf(false) }
  var facing by remember(callId) { mutableStateOf("front") }
  var error by remember(callId) { mutableStateOf(false) }
  var permissionCall by remember { mutableStateOf<String?>(null) }
  val preview = remember(callId) { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FIT_CENTER } }
  val permission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (permissionCall != null && permissionCall == viewModel.talkCameraCallId.value) {
        enabled = granted
        error = !granted
      }
      permissionCall = null
    }
  LaunchedEffect(callId, enabled, facing, preview) {
    if (!enabled) return@LaunchedEffect
    var binding: AutoCloseable? = null
    try {
      binding = viewModel.openTalkCamera(checkNotNull(callId), preview, facing)
      error = false
      awaitCancellation()
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      error = true
      enabled = false
    } finally {
      withContext(NonCancellable + Dispatchers.Main.immediate) { binding?.close() }
    }
  }
  Column {
    Row {
      TextButton(onClick = {
        error = false
        if (enabled) {
          permissionCall = null
          enabled = false
        } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
          enabled = true
        } else {
          permissionCall = callId
          permission.launch(Manifest.permission.CAMERA)
        }
      }) { Text(if (enabled) nativeString("Turn camera off") else nativeString("Turn camera on")) }
      if (enabled) {
        TextButton(onClick = { facing = if (facing == "front") "back" else "front" }) {
          Text(if (facing == "front") nativeString("Use back camera") else nativeString("Use front camera"))
        }
      }
    }
    if (error) Text(nativeString("Camera unavailable. Allow camera access and close other camera views, then try again."))
    if (enabled) AndroidView(factory = { preview }, modifier = Modifier.fillMaxWidth().height(160.dp))
  }
}
