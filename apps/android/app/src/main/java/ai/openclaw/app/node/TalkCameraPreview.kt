package ai.openclaw.app.node

import android.graphics.Bitmap
import android.util.Base64
import androidx.camera.core.CameraSelector
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.graphics.scale
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream

// CameraX is process-wide. Every app-owned binding uses this lease and releases only its own cases.
private var activeCameraBinding: Any? = null

internal fun bindCameraUseCases(
  provider: ProcessCameraProvider,
  owner: LifecycleOwner,
  selector: CameraSelector,
  vararg useCases: UseCase,
): AutoCloseable {
  check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
  check(activeCameraBinding == null) { "Camera is in use; close the other camera view first" }
  val token = Any()
  activeCameraBinding = token
  try {
    provider.bindToLifecycle(owner, selector, *useCases)
  } catch (error: Throwable) {
    provider.unbind(*useCases)
    activeCameraBinding = null
    throw error
  }
  return AutoCloseable {
    if (activeCameraBinding === token) {
      try {
        provider.unbind(*useCases)
      } finally {
        activeCameraBinding = null
      }
    }
  }
}

/** A current local preview, sampled only when describe_view asks for one JPEG. */
internal class TalkCameraPreview(
  private val view: PreviewView,
  private val binding: AutoCloseable,
  private val isCurrent: () -> Boolean,
) : AutoCloseable {
  private var closed = false

  suspend fun captureMessage(maxMessageBytes: Int): String =
    withContext(Dispatchers.Main.immediate) {
      check(!closed && isCurrent()) { "Talk camera is no longer active" }
      check(view.previewStreamState.value == PreviewView.StreamState.STREAMING) { "Camera preview is not ready; try again" }
      val bitmap = view.bitmap ?: error("Camera preview has no current image")
      try {
        val envelopeBytes = talkCameraImageMessage("").toByteArray(Charsets.UTF_8).size
        val jpegBudget = ((maxMessageBytes - envelopeBytes) / 4) * 3
        check(jpegBudget > 0) { "Realtime image message budget is too small" }
        val result =
          JpegSizeLimiter.compressToLimit(
            initialWidth = bitmap.width,
            initialHeight = bitmap.height,
            startQuality = 80,
            maxBytes = jpegBudget,
            encode = { width, height, quality ->
              val image = if (width == bitmap.width && height == bitmap.height) bitmap else bitmap.scale(width, height, true)
              try {
                ByteArrayOutputStream().use { output ->
                  check(image.compress(Bitmap.CompressFormat.JPEG, quality, output)) { "Could not encode camera image" }
                  output.toByteArray()
                }
              } finally {
                if (image !== bitmap) image.recycle()
              }
            },
          )
        val message = talkCameraImageMessage(Base64.encodeToString(result.bytes, Base64.NO_WRAP))
        check(message.toByteArray(Charsets.UTF_8).size <= maxMessageBytes) { "Camera image exceeds the Realtime message budget" }
        check(!closed && isCurrent()) { "Talk camera changed during capture" }
        message
      } finally {
        bitmap.recycle()
      }
    }

  override fun close() {
    if (closed) return
    closed = true
    binding.close()
  }
}

internal fun talkCameraImageMessage(base64: String): String =
  buildJsonObject {
    put("type", "conversation.item.create")
    put(
      "item",
      buildJsonObject {
        put("type", "message")
        put("role", "user")
        put(
          "content",
          JsonArray(
            listOf(
              buildJsonObject {
                put("type", "input_image")
                put("image_url", "data:image/jpeg;base64,$base64")
              },
            ),
          ),
        )
      },
    )
  }.toString()
