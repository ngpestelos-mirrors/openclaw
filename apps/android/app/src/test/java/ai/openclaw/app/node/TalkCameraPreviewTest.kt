package ai.openclaw.app.node

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [TalkPreviewViewShadow::class, TalkCameraProviderShadow::class])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkCameraPreviewTest {
  @Before fun setMain() {
    Dispatchers.setMain(UnconfinedTestDispatcher())
  }

  @After fun resetMain() {
    Dispatchers.resetMain()
  }

  @Test fun encodesCurrentJpegWithinBase64AndJsonEnvelopeBudget() =
    runBlocking {
      val view = Shadow.newInstanceOf(PreviewView::class.java)
      val frames = Shadow.extract<TalkPreviewViewShadow>(view)
      val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.RED) }
      frames.frame = bitmap
      val raw =
        ByteArrayOutputStream().use { out ->
          bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
          out.toByteArray()
        }
      val budget = talkCameraImageMessage(Base64.encodeToString(raw, Base64.NO_WRAP)).toByteArray().size
      var released = 0
      val camera = TalkCameraPreview(view, AutoCloseable { released++ }) { true }
      try {
        val message = camera.captureMessage(budget)
        assertEquals(budget, message.toByteArray().size)
        val item = Json.parseToJsonElement(message).jsonObject["item"]!!.jsonObject
        val image = item["content"]!!.jsonArray.single().jsonObject
        assertEquals("input_image", image["type"]!!.jsonPrimitive.content)
        val bytes = Base64.decode(image["image_url"]!!.jsonPrimitive.content.removePrefix("data:image/jpeg;base64,"), Base64.NO_WRAP)
        assertTrue(bytes.size < message.toByteArray().size)
        assertEquals(0xff, bytes[0].toInt() and 255)
        assertEquals(0xd8, bytes[1].toInt() and 255)
        val decoded = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
        assertEquals(16, decoded.width)
        decoded.recycle()
        assertTrue(bitmap.isRecycled)
        assertEquals(1, frames.reads)
      } finally {
        camera.close()
        camera.close()
      }
      assertEquals(1, released)
    }

  @Test fun insufficientEnvelopeOrJpegBudgetRejectsAndRecycles() =
    runBlocking {
      val envelope = talkCameraImageMessage("").toByteArray().size
      for (budget in listOf(envelope, envelope + 4)) {
        val view = Shadow.newInstanceOf(PreviewView::class.java)
        val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
        Shadow.extract<TalkPreviewViewShadow>(view).frame = bitmap
        val camera = TalkCameraPreview(view, AutoCloseable {}) { true }
        try {
          assertTrue(runCatching { camera.captureMessage(budget) }.exceptionOrNull() is IllegalStateException)
          assertTrue(bitmap.isRecycled)
        } finally {
          camera.close()
        }
      }
    }

  @Test fun unreadyRetiredAndClosedPreviewsNeverReadAFrame() =
    runBlocking {
      val view = Shadow.newInstanceOf(PreviewView::class.java)
      val frames = Shadow.extract<TalkPreviewViewShadow>(view)
      var current = true
      val camera = TalkCameraPreview(view, AutoCloseable {}) { current }
      try {
        frames.stream.value = PreviewView.StreamState.IDLE
        assertTrue(runCatching { camera.captureMessage(65536) }.isFailure)
        frames.stream.value = PreviewView.StreamState.STREAMING
        current = false
        assertTrue(runCatching { camera.captureMessage(65536) }.isFailure)
        camera.close()
        current = true
        assertTrue(runCatching { camera.captureMessage(65536) }.isFailure)
        assertEquals(0, frames.reads)
      } finally {
        camera.close()
      }
    }

  @Test fun retirementDuringFrameReadRejectsTheLateSample() =
    runBlocking {
      val view = Shadow.newInstanceOf(PreviewView::class.java)
      val frames = Shadow.extract<TalkPreviewViewShadow>(view)
      val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
      var current = true
      frames.frame = bitmap
      frames.onRead = { current = false }
      val camera = TalkCameraPreview(view, AutoCloseable {}) { current }
      try {
        val error = runCatching { camera.captureMessage(65536) }.exceptionOrNull()
        assertEquals("Talk camera changed during capture", error?.message)
        assertTrue(bitmap.isRecycled)
      } finally {
        camera.close()
      }
    }

  @Test fun leaseReleasesOnlyOwnedUseCasesAndCannotCloseItsSuccessor() {
    val provider = Shadow.newInstanceOf(ProcessCameraProvider::class.java)
    val sdk = Shadow.extract<TalkCameraProviderShadow>(provider)
    val foreign = Preview.Builder().build()
    val own = Preview.Builder().build()
    val next = Preview.Builder().build()
    sdk.bound.add(foreign)
    val owner =
      object : LifecycleOwner {
        override val lifecycle = LifecycleRegistry(this)
      }
    val first = bindCameraUseCases(provider, owner, CameraSelector.DEFAULT_FRONT_CAMERA, own)
    try {
      assertTrue(runCatching { bindCameraUseCases(provider, owner, CameraSelector.DEFAULT_BACK_CAMERA, next) }.isFailure)
      assertEquals(setOf(foreign, own), sdk.bound)
    } finally {
      first.close()
    }
    assertEquals(setOf(foreign), sdk.bound)
    val second = bindCameraUseCases(provider, owner, CameraSelector.DEFAULT_BACK_CAMERA, next)
    try {
      first.close()
      assertEquals(setOf(foreign, next), sdk.bound)
    } finally {
      second.close()
    }
    assertEquals(listOf(listOf(own), listOf(next)), sdk.unbound)
    assertEquals(setOf(foreign), sdk.bound)
  }

  @Test fun failedBindingCleansOnlyAttemptedUseCasesAndReleasesAdmission() {
    val provider = Shadow.newInstanceOf(ProcessCameraProvider::class.java)
    val sdk = Shadow.extract<TalkCameraProviderShadow>(provider)
    val foreign = Preview.Builder().build()
    val own = Preview.Builder().build()
    sdk.bound.add(foreign)
    sdk.failBind = true
    val owner =
      object : LifecycleOwner {
        override val lifecycle = LifecycleRegistry(this)
      }
    assertTrue(runCatching { bindCameraUseCases(provider, owner, CameraSelector.DEFAULT_FRONT_CAMERA, own) }.isFailure)
    assertEquals(setOf(foreign), sdk.bound)
    sdk.failBind = false
    bindCameraUseCases(provider, owner, CameraSelector.DEFAULT_FRONT_CAMERA, own).close()
    assertEquals(listOf(listOf(own), listOf(own)), sdk.unbound)
    assertEquals(setOf(foreign), sdk.bound)
  }
}

// Substitute SDK frame production only; TalkCameraPreview still executes its real encoder and fences.
@Implements(value = PreviewView::class, isInAndroidSdk = false)
class TalkPreviewViewShadow {
  val stream = MutableLiveData(PreviewView.StreamState.STREAMING)
  var frame: Bitmap? = null
  var reads = 0
  var onRead: (() -> Unit)? = null

  @Implementation fun getPreviewStreamState(): LiveData<PreviewView.StreamState> = stream

  @Implementation fun getBitmap(): Bitmap? {
    reads++
    onRead?.invoke()
    return frame
  }
}

// Record only CameraX bind/unbind calls; never initialize or open a physical camera.
@Implements(value = ProcessCameraProvider::class, isInAndroidSdk = false)
class TalkCameraProviderShadow {
  val bound = mutableSetOf<UseCase>()
  val unbound = mutableListOf<List<UseCase>>()
  var failBind = false

  @Implementation fun bindToLifecycle(
    owner: LifecycleOwner,
    selector: CameraSelector,
    vararg cases: UseCase,
  ): Camera? {
    bound.addAll(cases)
    check(!failBind) { "Camera binding rejected" }
    return null
  }

  @Implementation fun unbind(vararg cases: UseCase) {
    unbound.add(cases.toList())
    bound.removeAll(cases.toSet())
  }

  @Implementation fun unbindAll(): Unit = throw AssertionError("Must not release foreign camera use cases")
}
