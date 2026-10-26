package expo.modules.calllog

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.provider.CallLog
import android.telecom.PhoneAccountHandle
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Reads the phone's call log and keeps a small queue of calls waiting to be uploaded.
 *
 * Privacy:
 *  - Only Bangladeshi mobile numbers are kept, and only as a SHA-256 hash.
 *  - The server matches the hash against leads; anything that isn't a lead is dropped there.
 *  - Calls stay in this queue (on the phone) even if the user deletes them from the call log.
 */
object CallLogStore {
  private const val PREFS = "lead_call_log"
  private const val KEY_DEVICE_ID = "device_id"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_SIM_FILTER = "sim_filter"
  private const val KEY_LAST_CAPTURED = "last_captured"
  private const val KEY_PENDING = "pending"
  private const val KEY_APP_CALL_HASH = "app_call_hash"
  private const val KEY_APP_CALL_AT = "app_call_at"
  private const val KEY_NOTIFY_AFTER = "notify_after"
  private const val KEY_NOTIFY_INCOMING = "notify_incoming"

  private const val MAX_PENDING = 3000
  private const val FIRST_RUN_DAYS = 2L

  /** A call started from the app's Call button counts as "from the app" for this long */
  private const val APP_CALL_WINDOW_MS = 2L * 60 * 60 * 1000
  /** Only calls that ended this recently get an "add a note" notification */
  const val RECENT_CALL_MS = 15L * 60 * 1000

  private val bdMobile = Regex("^01[3-9]\\d{8}$")

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // -------------------------------------------------------------------
  // Settings kept on the phone
  // -------------------------------------------------------------------
  /** One id per app install, so the server knows which phone a call came from. */
  fun deviceId(context: Context): String {
    val p = prefs(context)
    p.getString(KEY_DEVICE_ID, null)?.let { return it }
    val id = UUID.randomUUID().toString()
    p.edit().putString(KEY_DEVICE_ID, id).apply()
    return id
  }

  fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

  fun setEnabled(context: Context, enabled: Boolean) {
    val p = prefs(context).edit().putBoolean(KEY_ENABLED, enabled)
    // Turning it on for the first time: start from a couple of days back, not the whole history
    if (enabled && !prefs(context).contains(KEY_LAST_CAPTURED)) {
      p.putLong(KEY_LAST_CAPTURED, System.currentTimeMillis() - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000)
    }
    p.apply()
  }

  /** null = all SIMs; otherwise the subscription id of the one SIM to sync */
  fun simFilter(context: Context): String? = prefs(context).getString(KEY_SIM_FILTER, null)

  fun setSimFilter(context: Context, simId: String?) {
    prefs(context).edit().apply {
      if (simId.isNullOrBlank()) remove(KEY_SIM_FILTER) else putString(KEY_SIM_FILTER, simId)
    }.apply()
  }

  /** "Add a note" notification after a lead call (default on) */
  fun notifyAfter(context: Context): Boolean = prefs(context).getBoolean(KEY_NOTIFY_AFTER, true)

  /** "Lead is calling" notification while the phone rings (default on) */
  fun notifyIncoming(context: Context): Boolean = prefs(context).getBoolean(KEY_NOTIFY_INCOMING, true)

  fun setNotify(context: Context, after: Boolean?, incoming: Boolean?) {
    prefs(context).edit().apply {
      after?.let { putBoolean(KEY_NOTIFY_AFTER, it) }
      incoming?.let { putBoolean(KEY_NOTIFY_INCOMING, it) }
    }.apply()
  }

  // -------------------------------------------------------------------
  // Calls started from the app (they already get the in-app popup)
  // -------------------------------------------------------------------
  /** The app's Call button was pressed for this number */
  fun markAppCall(context: Context, rawNumber: String) {
    val number = normalizeBd(rawNumber) ?: return
    prefs(context).edit()
      .putString(KEY_APP_CALL_HASH, sha256Hex(number))
      .putLong(KEY_APP_CALL_AT, System.currentTimeMillis())
      .apply()
  }

  /** Was this call placed with the app's Call button? Then no notification is needed. */
  fun isAppCall(context: Context, call: Call): Boolean {
    if (call.direction != "outgoing") return false
    val p = prefs(context)
    val hash = p.getString(KEY_APP_CALL_HASH, null) ?: return false
    val at = p.getLong(KEY_APP_CALL_AT, 0L)
    if (hash != sha256Hex(call.number)) return false
    // the call log time is when dialing started: allow a minute of clock slack
    return call.dateMs >= at - 60_000 && call.dateMs <= at + APP_CALL_WINDOW_MS
  }

  // -------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------
  fun hasCallLogPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) ==
      PackageManager.PERMISSION_GRANTED

  fun hasPhoneStatePermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
      PackageManager.PERMISSION_GRANTED

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  /** "+880 1711-234567" → "01711234567"; null if it isn't a Bangladeshi mobile number */
  fun normalizeBd(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    var d = raw.filter { it.isDigit() }
    if (d.length == 13 && d.startsWith("880")) d = "0" + d.substring(3)
    else if (d.length == 10 && d.startsWith("1")) d = "0$d"
    return if (bdMobile.matches(d)) d else null
  }

  fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest(text.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }

  private fun isoUtc(ms: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(Date(ms))

  /** Android call type → our direction; null = skip (blocked, unknown…) */
  private fun directionOf(type: Int): String? = when (type) {
    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
    CallLog.Calls.INCOMING_TYPE -> "incoming"
    CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "incoming"
    CallLog.Calls.MISSED_TYPE -> "missed"
    CallLog.Calls.VOICEMAIL_TYPE -> "missed"
    CallLog.Calls.REJECTED_TYPE -> "rejected"
    else -> null
  }

  // -------------------------------------------------------------------
  // SIM cards
  // -------------------------------------------------------------------
  data class Sim(val id: String, val label: String, val iccId: String?)

  @SuppressLint("MissingPermission")
  fun sims(context: Context): List<Sim> {
    if (!hasPhoneStatePermission(context)) return emptyList()
    return try {
      val sm = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
      (sm.activeSubscriptionInfoList ?: emptyList()).map { info ->
        val name = info.displayName?.toString()?.takeIf { it.isNotBlank() }
          ?: info.carrierName?.toString()
          ?: "SIM"
        // On Android 10+ apps get an empty ICCID; treat that as "unknown", never as a match
        val iccId = try { info.iccId?.takeIf { it.isNotBlank() } } catch (_: Throwable) { null }
        Sim(info.subscriptionId.toString(), "SIM ${info.simSlotIndex + 1} · $name", iccId)
      }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  /**
   * Which SIM a call used. The call log stores a "phone account" (component + id):
   *  - Android 11+: ask the system to turn it into a subscription id (reliable)
   *  - older phones: the id is usually the subscription id, on some the ICCID
   */
  @SuppressLint("MissingPermission")
  private fun matchSim(
    context: Context,
    component: String?,
    accountId: String?,
    sims: List<Sim>,
  ): Sim? {
    if (accountId.isNullOrBlank() || sims.isEmpty()) return null

    // 1. Android 11+ : the system knows exactly which subscription this account is
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !component.isNullOrBlank() && hasPhoneStatePermission(context)) {
      try {
        val cn = ComponentName.unflattenFromString(component)
        val tm = context.getSystemService(TelephonyManager::class.java)
        if (cn != null && tm != null) {
          val subId = tm.getSubscriptionId(PhoneAccountHandle(cn, accountId))
          if (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
            sims.firstOrNull { it.id == subId.toString() }?.let { return it }
          }
        }
      } catch (_: Throwable) {
        // fall through to the simple checks
      }
    }

    // 2. The account id is the subscription id itself
    sims.firstOrNull { it.id == accountId }?.let { return it }

    // 3. The account id is (or starts with) the real ICCID — only when we actually know it
    sims.firstOrNull { sim ->
      val icc = sim.iccId ?: return@firstOrNull false
      accountId == icc || accountId.startsWith(icc) || icc.startsWith(accountId)
    }?.let { return it }

    // 4. Only one SIM in the phone: it must be that one
    return if (sims.size == 1) sims[0] else null
  }

  // -------------------------------------------------------------------
  // Reading the call log
  // -------------------------------------------------------------------
  data class Call(
    val id: String,
    val number: String,       // normalized 01…
    val direction: String,
    val durationSec: Long,
    val dateMs: Long,
    val simId: String?,
    val simLabel: String?,
  ) {
    /** When the call ended (call log time is when it started) */
    val endedMs: Long get() = dateMs + durationSec * 1000
  }

  @SuppressLint("MissingPermission")
  private fun readCalls(context: Context, sinceMs: Long): List<Call> {
    if (!hasCallLogPermission(context)) return emptyList()
    val sims = sims(context)
    val out = mutableListOf<Call>()

    val projection = arrayOf(
      CallLog.Calls._ID,
      CallLog.Calls.NUMBER,
      CallLog.Calls.TYPE,
      CallLog.Calls.DATE,
      CallLog.Calls.DURATION,
      CallLog.Calls.PHONE_ACCOUNT_ID,
      CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME,
    )

    context.contentResolver.query(
      CallLog.Calls.CONTENT_URI,
      projection,
      "${CallLog.Calls.DATE} > ?",
      arrayOf(sinceMs.toString()),
      "${CallLog.Calls.DATE} ASC",
    )?.use { c ->
      val iId = c.getColumnIndexOrThrow(CallLog.Calls._ID)
      val iNum = c.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
      val iType = c.getColumnIndexOrThrow(CallLog.Calls.TYPE)
      val iDate = c.getColumnIndexOrThrow(CallLog.Calls.DATE)
      val iDur = c.getColumnIndexOrThrow(CallLog.Calls.DURATION)
      val iAcc = c.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
      val iComp = c.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME)

      while (c.moveToNext()) {
        val direction = directionOf(c.getInt(iType)) ?: continue
        val number = normalizeBd(c.getString(iNum)) ?: continue
        val accountId = if (iAcc >= 0) c.getString(iAcc) else null
        val component = if (iComp >= 0) c.getString(iComp) else null
        val sim = matchSim(context, component, accountId, sims)
        out += Call(
          id = c.getLong(iId).toString(),
          number = number,
          direction = direction,
          durationSec = c.getLong(iDur),
          dateMs = c.getLong(iDate),
          simId = sim?.id ?: accountId,
          simLabel = sim?.label,
        )
      }
    }
    return out
  }

  private fun toJson(call: Call): JSONObject = JSONObject().apply {
    put("id", call.id)
    put("hash", sha256Hex(call.number))
    put("direction", call.direction)
    put("duration_sec", call.durationSec)
    put("called_at", isoUtc(call.dateMs))
    put("sim", call.simLabel ?: JSONObject.NULL)
  }

  // -------------------------------------------------------------------
  // Capture: copy new calls from the call log into the pending queue
  // -------------------------------------------------------------------
  /**
   * Copies new calls into the queue and returns the calls that were added
   * (so the worker can notify about lead calls). Safe to call from anywhere, any time.
   */
  @Synchronized
  fun captureNew(context: Context): List<Call> {
    if (!isEnabled(context) || !hasCallLogPermission(context)) return emptyList()

    val p = prefs(context)
    val since = p.getLong(
      KEY_LAST_CAPTURED,
      System.currentTimeMillis() - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000,
    )
    val calls = readCalls(context, since)
    if (calls.isEmpty()) return emptyList()

    val filter = simFilter(context)
    val pending = pendingArray(context)
    val have = HashSet<String>()
    for (i in 0 until pending.length()) have += pending.getJSONObject(i).optString("id")

    val added = mutableListOf<Call>()
    var newest = since
    for (call in calls) {
      if (call.dateMs > newest) newest = call.dateMs
      if (filter != null && call.simId != null && call.simId != filter) continue
      if (call.id in have) continue
      pending.put(toJson(call))
      have += call.id
      added += call
    }

    // Keep the queue bounded (oldest dropped first)
    val trimmed = if (pending.length() > MAX_PENDING) {
      JSONArray().also { t ->
        for (i in pending.length() - MAX_PENDING until pending.length()) t.put(pending.get(i))
      }
    } else pending

    p.edit()
      .putString(KEY_PENDING, trimmed.toString())
      .putLong(KEY_LAST_CAPTURED, newest)
      .apply()
    return added
  }

  /** Returns how many calls were added to the queue */
  fun capture(context: Context): Int = captureNew(context).size

  // -------------------------------------------------------------------
  // Pending queue
  // -------------------------------------------------------------------
  private fun pendingArray(context: Context): JSONArray =
    try {
      JSONArray(prefs(context).getString(KEY_PENDING, "[]"))
    } catch (_: Throwable) {
      JSONArray()
    }

  @Synchronized
  fun pendingJson(context: Context): String = pendingArray(context).toString()

  @Synchronized
  fun pendingCount(context: Context): Int = pendingArray(context).length()

  /** Remove calls that the server has accepted (by their call-log id) */
  @Synchronized
  fun removePending(context: Context, ids: Collection<String>) {
    if (ids.isEmpty()) return
    val drop = ids.toHashSet()
    val current = pendingArray(context)
    val keep = JSONArray()
    for (i in 0 until current.length()) {
      val o = current.getJSONObject(i)
      if (o.optString("id") !in drop) keep.put(o)
    }
    prefs(context).edit().putString(KEY_PENDING, keep.toString()).apply()
  }

  // -------------------------------------------------------------------
  // For the after-call popup: the latest call with one number
  // -------------------------------------------------------------------
  fun latestCallFor(context: Context, rawNumber: String, sinceMs: Long): Map<String, Any?>? {
    val number = normalizeBd(rawNumber) ?: return null
    val call = readCalls(context, sinceMs).lastOrNull { it.number == number } ?: return null
    return mapOf(
      "id" to call.id,
      "direction" to call.direction,
      "durationSec" to call.durationSec,
      "calledAt" to isoUtc(call.dateMs),
      "simId" to call.simId,
      "simLabel" to call.simLabel,
    )
  }

  /** One call by its call-log id (for the note popup opened from a notification) */
  fun callById(context: Context, id: String): Map<String, Any?>? {
    val call = readCalls(context, System.currentTimeMillis() - 3L * 24 * 60 * 60 * 1000)
      .lastOrNull { it.id == id } ?: return null
    return mapOf(
      "id" to call.id,
      "direction" to call.direction,
      "durationSec" to call.durationSec,
      "calledAt" to isoUtc(call.dateMs),
      "simId" to call.simId,
      "simLabel" to call.simLabel,
    )
  }
}