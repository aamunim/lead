package expo.modules.calllog

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 💥 Crashes in the app's Android part (call sync, caller card, WhatsApp calls…).
 * When the app is about to close because of an error, the error is written to a
 * small file first; the next time the app opens, the JS part sends it to the
 * developer (Contact developer → inbox → Crashes) and the file is emptied.
 * Installed from every way the Android part starts: the app, a call ringing or
 * ending, the WhatsApp listener and the background job.
 */
object NativeCrash {
  private const val FILE = "native_crashes.json"
  private const val MAX = 10

  @Volatile private var installed = false

  fun install(context: Context) {
    if (installed) return
    synchronized(this) {
      if (installed) return
      val app = context.applicationContext
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        try {
          save(app, thread, error)
        } catch (_: Throwable) {
          // never stop the normal crash
        }
        previous?.uncaughtException(thread, error)
      }
      installed = true
    }
  }

  private fun file(context: Context) = File(context.filesDir, FILE)

  @Synchronized
  private fun save(context: Context, thread: Thread, error: Throwable) {
    val list = read(context)
    val root = generateSequence(error) { it.cause }.last()
    val item = JSONObject()
      .put("name", error.javaClass.name)
      .put("message", (error.message ?: root.message ?: "").take(1000))
      .put("stack", error.stackTraceToString().take(4000))
      .put("thread", thread.name)
      .put("at", System.currentTimeMillis())
    list.put(item)
    // keep the newest ones only
    val out = JSONArray()
    val from = maxOf(0, list.length() - MAX)
    for (i in from until list.length()) out.put(list.get(i))
    file(context).writeText(out.toString())
  }

  private fun read(context: Context): JSONArray =
    try {
      val f = file(context)
      if (f.exists()) JSONArray(f.readText()) else JSONArray()
    } catch (_: Throwable) {
      JSONArray()
    }

  /** The saved crashes (JSON array) — and the file is emptied */
  @Synchronized
  fun take(context: Context): String {
    val list = read(context)
    try {
      file(context).delete()
    } catch (_: Throwable) {
    }
    return list.toString()
  }
}
