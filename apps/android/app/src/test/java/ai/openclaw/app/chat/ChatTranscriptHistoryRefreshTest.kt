package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatTranscriptHistoryRefreshTest {
  @Test
  fun obsoleteInvalidationCannotCancelTheCurrentOwnersRead() =
    runTest {
      val refresh = ChatTranscriptHistoryRefresh(backgroundScope, 750)
      val current = ChatTranscriptHistoryRefresh.Owner("current", 2, ChatCacheScope("gateway", 1), "main")
      val obsolete = current.copy(sessionKey = "old", generation = 1)
      var reads = 0
      refresh.request(current, isCurrent = { true }, refresh = { reads += 1 })
      refresh.request(obsolete, isCurrent = { false }, refresh = { error("obsolete owner read") })
      runCurrent()
      assertEquals(1, reads)
    }

  @Test
  fun invalidationDuringAReadRequiresOneTrailingRead() =
    runTest {
      val refresh = ChatTranscriptHistoryRefresh(backgroundScope, 750)
      val owner = ChatTranscriptHistoryRefresh.Owner("main", 1, ChatCacheScope("gateway", 1), "main")
      val firstRead = CompletableDeferred<Unit>()
      var reads = 0
      val read: suspend () -> Unit = {
        reads += 1
        if (reads == 1) firstRead.await()
      }
      refresh.request(owner, isCurrent = { true }, refresh = read)
      runCurrent()
      repeat(3) { refresh.request(owner, isCurrent = { true }, refresh = read) }
      runCurrent()
      assertEquals(1, reads)
      firstRead.complete(Unit)
      runCurrent()
      assertEquals(2, reads)
    }
}
