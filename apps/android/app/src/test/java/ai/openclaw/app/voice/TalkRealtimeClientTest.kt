package ai.openclaw.app.voice

import java.lang.reflect.Field

internal fun realtimeTestField(
  target: Any,
  name: String,
): Field = target.javaClass.getDeclaredField(name).apply { isAccessible = true }
