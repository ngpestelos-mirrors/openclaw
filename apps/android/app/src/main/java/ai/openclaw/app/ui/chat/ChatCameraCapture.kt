package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.AppAlertDialog
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

internal enum class ChatCameraMode { Photo, Video }

@Composable
internal fun rememberChatCameraCapture(
  viewModel: MainViewModel,
  owner: ChatComposerOwner,
  mainSessionKey: String,
): (ChatCameraMode) -> Unit {
  val context = LocalContext.current
  val app = context.applicationContext
  val currentOwner by rememberUpdatedState(owner)
  val currentMainSessionKey by rememberUpdatedState(mainSessionKey)
  val composer = viewModel.chatComposerState
  val checkpoint = rememberSaveable(saver = ChatComposerMediaCheckpoint.Saver) { ChatComposerMediaCheckpoint() }
  var fileName by rememberSaveable { mutableStateOf<String?>(null) }
  var mode by rememberSaveable { mutableStateOf(ChatCameraMode.Photo) }
  var failure by remember { mutableStateOf<String?>(null) }
  val directory = remember(app) { File(app.cacheDir, "chat-camera") }

  fun cancelCapture() {
    fileName?.let { File(directory, it).delete() }
    fileName = null
    checkpoint.clear()?.let { composer.cancelMediaAcquisition(it.authorizationId) }
  }

  fun completeCapture(captured: Boolean) {
    val file = fileName?.let { File(directory, it) }
    fileName = null
    val lease = checkpoint.consume()
    if (!captured || file == null || lease == null) {
      file?.delete()
      lease?.let { composer.cancelMediaAcquisition(it.authorizationId) }
      return
    }
    val importOwner =
      if (shouldMigrateComposerDraft(lease.owner, currentOwner, currentMainSessionKey)) currentOwner else lease.owner
    val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
    val importJob =
      viewModel.importChatComposerAttachments(importOwner, lease.authorizationId, currentMainSessionKey, expectedCount = 1) {
        listOf(loadPickedMediaOrDocumentAttachment(app.contentResolver, uri))
      }
    // Also clean up when admission is revoked or the ViewModel cancels before loading starts.
    if (importJob == null) file.delete() else importJob.invokeOnCompletion { file.delete() }
  }

  val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture(), ::completeCapture)
  val captureVideo = rememberLauncherForActivityResult(ActivityResultContracts.CaptureVideo(), ::completeCapture)

  fun launchCapture() {
    val lease = checkpoint.consume() ?: return
    if (!viewModel.isCurrentChatComposerOwner(lease.owner) || !composer.isMediaAcquisitionActive(lease.authorizationId)) {
      composer.cancelMediaAcquisition(lease.authorizationId)
      return
    }
    checkpoint.begin(lease.owner, lease.authorizationId)
    try {
      check(directory.isDirectory || directory.mkdirs())
      val file = File.createTempFile("camera-", if (mode == ChatCameraMode.Video) ".mp4" else ".jpg", directory)
      fileName = file.name
      val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
      when (mode) {
        ChatCameraMode.Photo -> takePicture.launch(uri)
        ChatCameraMode.Video -> captureVideo.launch(uri)
      }
    } catch (_: Exception) {
      cancelCapture()
      failure = nativeString("Could not start the camera.")
    }
  }

  val permission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) {
        launchCapture()
      } else {
        cancelCapture()
        failure = nativeString("Permission required")
      }
    }

  failure?.let { message ->
    AppAlertDialog(
      onDismissRequest = { failure = null },
      title = { Text(nativeString("Camera")) },
      text = { Text(message) },
      confirmButton = {
        TextButton(onClick = {
          failure = null
          context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${app.packageName}")))
        }) { Text(nativeString("Open settings")) }
      },
      dismissButton = { TextButton(onClick = { failure = null }) { Text(nativeString("Cancel")) } },
    )
  }

  return capture@{ selectedMode ->
    if (checkpoint.owner != null || !viewModel.isCurrentChatComposerOwner(currentOwner)) return@capture
    val authorizationId = composer.beginMediaAcquisition(currentOwner) ?: return@capture
    checkpoint.begin(currentOwner, authorizationId)
    mode = selectedMode
    failure = null
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      launchCapture()
    } else {
      try {
        permission.launch(Manifest.permission.CAMERA)
      } catch (_: Exception) {
        cancelCapture()
        failure = nativeString("Could not start the camera.")
      }
    }
  }
}
