package expo.modules.calllog

import android.content.BroadcastReceiver
import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 📵 Call lock, the phone's part: while someone talks with a lead, others are
 * stopped from calling the same lead (the server keeps the "on call" mark).
 *  - an incoming call from a lead is answered → "on call" (the app is not needed)
 *  - any call ends (IDLE) → the user's marks are removed at once, so the lead
 *    is free again the moment the call is over (calls started from the app
 *    are marked by the app itself, before dialing)
 * The app gives this phone a key (Settings → Call lock is on, signed in); the
 * key only lets this phone set and clear its own user's marks.
 */
object CallLock {
  private const val PREFS = "call_lock"

  private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun configure(context: Context, url: String?, anonKey: String?, deviceKey: String?, enabled: Boolean) {
    prefs(context).edit()
      .putString("url", url)
      .putString("anon", anonKey)
      .putString("key", deviceKey)
      .putBoolean("enabled", enabled && !url.isNullOrBlank() && !deviceKey.isNullOrBlank())
      .remove("ringing")
      .apply()
  }

  fun status(context: Context): Map<String, Any?> {
    val p = prefs(context)
    return mapOf("enabled" to p.getBoolean("enabled", false), "hasKey" to !p.getString("key", null).isNullOrBlank())
  }

  private fun enabled(context: Context) = prefs(context).getBoolean("enabled", false)

  /** Ringing: remember which lead is calling (if it is one) */
  fun onRinging(context: Context, number: String?) {
    if (!enabled(context)) return
    val lead = try {
      LeadDirectory.findByNumber(context, number)?.leadId
    } catch (_: Throwable) {
      null
    }
    prefs(context).edit().putString("ringing", lead).apply()
  }

  /** Answered (or dialing): a lead that was ringing is now "on call" */
  fun onOffhook(context: Context, receiver: BroadcastReceiver?) {
    if (!enabled(context)) return
    val lead = prefs(context).getString("ringing", null) ?: return
    prefs(context).edit().remove("ringing").apply()
    send(context, "start", lead, receiver)
  }

  /** The call is over: this user's marks go */
  fun onIdle(context: Context, receiver: BroadcastReceiver?) {
    if (!enabled(context)) return
    prefs(context).edit().remove("ringing").apply()
    send(context, "end", null, receiver)
  }

  private fun send(context: Context, state: String, leadId: String?, receiver: BroadcastReceiver?) {
    val p = prefs(context)
    val url = p.getString("url", null) ?: return
    val anon = p.getString("anon", null) ?: return
    val key = p.getString("key", null) ?: return
    val pending = try {
      receiver?.goAsync()
    } catch (_: Throwable) {
      null
    }
    Thread {
      try {
        val body = JSONObject()
          .put("p_key", key)
          .put("p_lead", leadId ?: JSONObject.NULL)
          .put("p_state", state)
          .toString()
        val conn = (URL("${url.trimEnd('/')}/rest/v1/rpc/call_lock_device").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 8000
          readTimeout = 8000
          doOutput = true
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("apikey", anon)
          setRequestProperty("Authorization", "Bearer $anon")
        }
        conn.outputStream.use { it.write(body.toByteArray()) }
        conn.responseCode // send it; the answer does not matter
        conn.disconnect()
      } catch (_: Throwable) {
        // no internet: the mark ends by itself after a few minutes
      } finally {
        try {
          pending?.finish()
        } catch (_: Throwable) {
        }
      }
    }.start()
  }
}
