package expo.modules.calllog

import android.content.Context
import android.content.SharedPreferences
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * WhatsApp calls (and "a lead sent a message") seen in WhatsApp's notifications,
 * waiting on the phone until the app uploads them.
 *
 * Privacy:
 *  - Only events from leads in the lead directory are kept (matched on the phone).
 *  - No names, numbers or message text are stored; only the lead id and the times.
 */
object WhatsAppStore {
  private const val PREFS = "lead_whatsapp"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_PENDING = "pending"
  private const val KEY_LAST_MESSAGE = "last_message"
  private const val KEY_LAST_MISSED = "last_missed"

  private const val MAX_PENDING = 2000

  /** One "message received" line per lead per hour at most */
  const val MESSAGE_GAP_MS = 60L * 60 * 1000
  /** A missed-call notification within this time of our own missed call is the same call */
  const val MISSED_SAME_MS = 3L * 60 * 1000

  val PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")

  data class Event(
    val id: String,
    val leadId: String,
    val media: String, // voice | video | message
    val direction: String, // outgoing | incoming | missed
    val durationSec: Long,
    val connected: Boolean,
    val atMs: Long,
  )

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // -------------------------------------------------------------------
  // On / off, and Android's "Notification access" for this app
  // -------------------------------------------------------------------
  fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

  fun setEnabled(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
  }

  fun hasAccess(context: Context): Boolean =
    NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)

  // -------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------
  private fun isoUtc(ms: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(Date(ms))

  private fun toJson(e: Event): JSONObject = JSONObject().apply {
    put("id", e.id)
    put("lead_id", e.leadId)
    put("media", e.media)
    put("direction", e.direction)
    put("duration_sec", e.durationSec)
    put("connected", e.connected)
    put("called_at", isoUtc(e.atMs))
  }

  private fun pendingArray(context: Context): JSONArray =
    try {
      JSONArray(prefs(context).getString(KEY_PENDING, "[]"))
    } catch (_: Throwable) {
      JSONArray()
    }

  fun newId(): String = UUID.randomUUID().toString()

  @Synchronized
  fun add(context: Context, e: Event) {
    val pending = pendingArray(context)
    pending.put(toJson(e))
    val trimmed = if (pending.length() > MAX_PENDING) {
      JSONArray().also { t ->
        for (i in pending.length() - MAX_PENDING until pending.length()) t.put(pending.get(i))
      }
    } else pending
    prefs(context).edit().putString(KEY_PENDING, trimmed.toString()).apply()
  }

  fun pendingJson(context: Context): String = pendingArray(context).toString()

  fun pendingCount(context: Context): Int = pendingArray(context).length()

  @Synchronized
  fun removePending(context: Context, ids: Collection<String>) {
    if (ids.isEmpty()) return
    val drop = ids.toHashSet()
    val all = pendingArray(context)
    val keep = JSONArray()
    for (i in 0 until all.length()) {
      val o = all.optJSONObject(i) ?: continue
      if (!drop.contains(o.optString("id"))) keep.put(o)
    }
    prefs(context).edit().putString(KEY_PENDING, keep.toString()).apply()
  }

  /** One event still on the phone (for the "add a note" popup) */
  fun eventById(context: Context, id: String): Map<String, Any?>? {
    val all = pendingArray(context)
    for (i in 0 until all.length()) {
      val o = all.optJSONObject(i) ?: continue
      if (o.optString("id") == id) {
        return mapOf(
          "id" to o.optString("id"),
          "leadId" to o.optString("lead_id"),
          "media" to o.optString("media"),
          "direction" to o.optString("direction"),
          "durationSec" to o.optLong("duration_sec"),
          "connected" to o.optBoolean("connected"),
          "calledAt" to o.optString("called_at"),
        )
      }
    }
    return null
  }

  // -------------------------------------------------------------------
  // Keeping the log short
  // -------------------------------------------------------------------
  private fun lastTimes(context: Context, key: String): JSONObject =
    try {
      JSONObject(prefs(context).getString(key, "{}") ?: "{}")
    } catch (_: Throwable) {
      JSONObject()
    }

  /** True (and remembered) if this lead hasn't had a message line within the gap */
  @Synchronized
  fun takeMessageSlot(context: Context, leadId: String, now: Long): Boolean {
    val times = lastTimes(context, KEY_LAST_MESSAGE)
    if (now - times.optLong(leadId, 0L) < MESSAGE_GAP_MS) return false
    times.put(leadId, now)
    prefs(context).edit().putString(KEY_LAST_MESSAGE, times.toString()).apply()
    return true
  }

  @Synchronized
  fun rememberMissed(context: Context, leadId: String, now: Long) {
    val times = lastTimes(context, KEY_LAST_MISSED)
    times.put(leadId, now)
    prefs(context).edit().putString(KEY_LAST_MISSED, times.toString()).apply()
  }

  fun missedRecently(context: Context, leadId: String, now: Long): Boolean =
    now - lastTimes(context, KEY_LAST_MISSED).optLong(leadId, 0L) < MISSED_SAME_MS

  /** On logout */
  fun clear(context: Context) {
    prefs(context).edit().clear().apply()
  }
}
