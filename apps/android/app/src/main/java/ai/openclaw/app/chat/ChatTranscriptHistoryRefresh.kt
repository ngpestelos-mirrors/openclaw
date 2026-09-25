package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestRejected
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Coalesces durable transcript invalidations until the current owner can read them. */
internal class ChatTranscriptHistoryRefresh(
  private val scope: CoroutineScope,
  private val retryDelayMs: Long,
) {
  data class Owner(
    val sessionKey: String,
    val generation: Long,
    val gatewayScope: ChatCacheScope?,
    val agentId: String?,
  )

  private class Pending(
    val owner: Owner,
  ) {
    var requested = true
    var job: Job? = null
  }

  private var pending: Pending? = null

  fun request(
    owner: Owner,
    isCurrent: () -> Boolean,
    refresh: suspend () -> Unit,
  ) {
    val job =
      synchronized(this) {
        if (!isCurrent()) return
        pending?.takeIf { it.owner == owner }?.let {
          it.requested = true
          return
        }
        pending?.job?.cancel()
        val request = Pending(owner)
        pending = request
        scope
          .launch(start = CoroutineStart.LAZY) {
            try {
              while (isCurrent()) {
                val shouldRead =
                  synchronized(this@ChatTranscriptHistoryRefresh) {
                    if (pending !== request) {
                      false
                    } else if (!request.requested) {
                      // Retire atomically so an event arriving as we finish starts a new reader.
                      pending = null
                      false
                    } else {
                      request.requested = false
                      true
                    }
                  }
                if (!shouldRead) break
                try {
                  refresh()
                } catch (err: CancellationException) {
                  throw err
                } catch (err: Throwable) {
                  if (err is GatewayRequestRejected &&
                    err.gatewayError.code == "UNAVAILABLE" &&
                    err.gatewayError.details?.retryable == true
                  ) {
                    // A worker refusal does not discharge a committed transcript invalidation.
                    synchronized(this@ChatTranscriptHistoryRefresh) { request.requested = true }
                    delay(retryDelayMs)
                  }
                }
              }
            } finally {
              synchronized(this@ChatTranscriptHistoryRefresh) {
                if (pending === request) pending = null
              }
            }
          }.also { request.job = it }
      }
    job.start()
  }
}
