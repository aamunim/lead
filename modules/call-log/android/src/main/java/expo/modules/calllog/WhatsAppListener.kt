package expo.modules.calllog

import android.Manifest
import android.app.Notification
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.content.ContextCompat

/**
 * Reads WhatsApp / WhatsApp Business notifications (only when the user turned
 * WhatsApp sync on and allowed "Notification access"):
 *
 *  - a call notification appears   → a call started (ringing = incoming, else outgoing)
 *  - it shows a running timer       → the call was answered
 *  - all its call notifications go  → the call ended: save it, "add a note" notification
 *  - a missed-call notification     → a missed call (once)
 *  - a chat message notification    → "the lead sent a message" (at most once an hour)
 *
 * Only leads in the on-phone lead directory count; everything else is ignored.
 * Message text is never read. Words are checked in English and Bangla, because
 * WhatsApp writes its notifications in the phone's language.
 */
class WhatsAppListener : NotificationListenerService() {

  /** A WhatsApp call in progress, by lead */
  private class ActiveCall(
    val lead: LeadDirectory.Entry,
    val startMs: Long,
    val incoming: Boolean,
  ) {
    var video = false
    var connectedAtMs: Long? = null
    val keys = HashSet<String>()
  }

  private val active = HashMap<String, ActiveCall>()
  private val handler = Handler(Looper.getMainLooper())

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    try {
      if (sbn != null) posted(sbn)
    } catch (_: Throwable) {
      // never crash because of someone else's notification
    }
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    try {
      if (sbn != null) removed(sbn)
    } catch (_: Throwable) {
      // ignore
    }
  }

  // -------------------------------------------------------------------
  // New or updated notification
  // -------------------------------------------------------------------
  private fun posted(sbn: StatusBarNotification) {
    if (!WhatsAppStore.PACKAGES.contains(sbn.packageName)) return
    val context = applicationContext
    if (!WhatsAppStore.isEnabled(context)) return

    val n = sbn.notification ?: return
    if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return

    val extras = n.extras
    val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
    val category = n.category

    when (category) {
      CATEGORY_CALL -> onCall(context, sbn.key, title, n)
      CATEGORY_MISSED_CALL -> onMissed(context, title, textOf(n))
      CATEGORY_MESSAGE -> {
        if (extras.getBoolean(EXTRA_IS_GROUP, false)) return
        onMessage(context, title)
      }
      else -> {
        // Some versions post the missed call without the "missed_call" category
        val text = textOf(n)
        if (hasAny(text, MISSED) && hasAny(text, CALL_WORDS)) onMissed(context, title, text)
      }
    }
  }

  private fun onCall(context: Context, key: String, title: String, n: Notification) {
    val text = textOf(n)
    var call = active.values.firstOrNull { it.keys.contains(key) }

    if (call == null) {
      val lead = resolve(context, title) ?: return
      call = active[lead.leadId]
      // A call whose end we never saw (hours ago): start fresh
      if (call != null && System.currentTimeMillis() - call.startMs > STALE_MS) {
        active.remove(lead.leadId)
        call = null
      }
      if (call == null) {
        val incoming = n.fullScreenIntent != null || hasAny(text, INCOMING)
        call = ActiveCall(lead, System.currentTimeMillis(), incoming)
        active[lead.leadId] = call
        if (incoming && CallLogStore.notifyIncoming(context)) {
          CallNotifier.waIncoming(context, lead, hasAny(text, VIDEO))
        }
      }
      call.keys.add(key)
    }

    if (hasAny(text, VIDEO)) call.video = true

    // A running timer (or "ongoing") means the call was answered
    val timer = n.extras?.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER, false) == true
    if (call.connectedAtMs == null && (timer || hasAny(text, ONGOING))) {
      val now = System.currentTimeMillis()
      val base = n.`when`
      call.connectedAtMs = if (timer && base in (call.startMs - 60_000)..now) base else now
      CallNotifier.clearIncoming(context)
    }
  }

  private fun onMissed(context: Context, title: String, text: String) {
    val lead = resolve(context, title) ?: return
    val now = System.currentTimeMillis()
    if (active.containsKey(lead.leadId)) return // our own call tracking will save it
    if (WhatsAppStore.missedRecently(context, lead.leadId, now)) return
    WhatsAppStore.rememberMissed(context, lead.leadId, now)

    val event = WhatsAppStore.Event(
      id = WhatsAppStore.newId(),
      leadId = lead.leadId,
      media = if (hasAny(text, VIDEO)) "video" else "voice",
      direction = "missed",
      durationSec = 0,
      connected = false,
      atMs = now,
    )
    WhatsAppStore.add(context, event)
    if (CallLogStore.notifyAfter(context)) CallNotifier.waAfterCall(context, event, lead)
  }

  private fun onMessage(context: Context, title: String) {
    val lead = resolve(context, title) ?: return
    val now = System.currentTimeMillis()
    if (!WhatsAppStore.takeMessageSlot(context, lead.leadId, now)) return
    WhatsAppStore.add(
      context,
      WhatsAppStore.Event(
        id = WhatsAppStore.newId(),
        leadId = lead.leadId,
        media = "message",
        direction = "incoming",
        durationSec = 0,
        connected = false,
        atMs = now,
      ),
    )
  }

  // -------------------------------------------------------------------
  // Notification gone
  // -------------------------------------------------------------------
  private fun removed(sbn: StatusBarNotification) {
    if (!WhatsAppStore.PACKAGES.contains(sbn.packageName)) return
    val key = sbn.key
    val call = active.values.firstOrNull { it.keys.contains(key) } ?: return
    call.keys.remove(key)
    // WhatsApp often swaps "ringing" for "ongoing": wait a moment before calling it ended
    handler.postDelayed({
      try {
        if (call.keys.isEmpty() && active[call.lead.leadId] === call) finish(applicationContext, call)
      } catch (_: Throwable) {
        // ignore
      }
    }, END_DELAY_MS)
  }

  private fun finish(context: Context, call: ActiveCall) {
    active.remove(call.lead.leadId)
    CallNotifier.clearIncoming(context)
    if (!WhatsAppStore.isEnabled(context)) return

    val now = System.currentTimeMillis()
    val connectedAt = call.connectedAtMs
    val durationSec = if (connectedAt != null) ((now - END_DELAY_MS - connectedAt) / 1000).coerceAtLeast(0) else 0L
    val connected = connectedAt != null
    val direction = when {
      call.incoming && !connected -> "missed"
      call.incoming -> "incoming"
      else -> "outgoing"
    }
    if (direction == "missed") WhatsAppStore.rememberMissed(context, call.lead.leadId, now)

    val event = WhatsAppStore.Event(
      id = WhatsAppStore.newId(),
      leadId = call.lead.leadId,
      media = if (call.video) "video" else "voice",
      direction = direction,
      durationSec = durationSec,
      connected = connected,
      atMs = call.startMs,
    )
    WhatsAppStore.add(context, event)
    if (CallLogStore.notifyAfter(context)) CallNotifier.waAfterCall(context, event, call.lead)
  }

  // -------------------------------------------------------------------
  // Who is it? (a lead from the on-phone directory, or nobody)
  // -------------------------------------------------------------------
  private fun resolve(context: Context, rawTitle: String): LeadDirectory.Entry? {
    val title = rawTitle.trim()
      .removePrefix("~")
      .replace(Regex("\\s*\\(\\d+[^)]*\\)\\s*$"), "") // "Karim (2 messages)"
      .trim()
    if (title.isEmpty()) return null

    // @username
    if (title.startsWith("@")) {
      return LeadDirectory.findKey(context, "u:" + title.removePrefix("@").lowercase())
    }

    // A number (not saved in contacts)
    if (title.matches(Regex("^[+\\d\\s\\-().]+$")) && title.count { it.isDigit() } >= 8) {
      val key = normalizeWa(title) ?: return null
      return LeadDirectory.findKey(context, key)
    }

    // A contact name: its numbers from the phone's contacts
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      for (number in contactNumbers(context, title)) {
        val key = normalizeWa(number) ?: continue
        LeadDirectory.findKey(context, key)?.let { return it }
      }
    }

    // Last try: exactly one lead with this name
    return LeadDirectory.findUniqueByName(context, title)
  }

  private fun contactNumbers(context: Context, name: String): List<String> {
    val out = ArrayList<String>()
    val cursor = context.contentResolver.query(
      ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
      "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} = ?",
      arrayOf(name),
      null,
    ) ?: return out
    cursor.use {
      while (it.moveToNext() && out.size < 10) {
        it.getString(0)?.let { n -> out.add(n) }
      }
    }
    return out
  }

  companion object {
    private const val CATEGORY_CALL = "call"
    private const val CATEGORY_MISSED_CALL = "missed_call"
    private const val CATEGORY_MESSAGE = "msg"
    private const val EXTRA_IS_GROUP = "android.isGroupConversation"
    private const val END_DELAY_MS = 3000L
    private const val STALE_MS = 3L * 60 * 60 * 1000

    private val VIDEO = listOf("video", "ভিডিও")
    private val INCOMING = listOf("incoming", "ইনকামিং")
    private val ONGOING = listOf("ongoing", "চলমান", "চলছে")
    private val MISSED = listOf("missed", "মিসড", "মিস করা")
    private val CALL_WORDS = listOf("call", "কল")

    private fun textOf(n: Notification): String =
      (n.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "").lowercase()

    private fun hasAny(text: String, words: List<String>): Boolean = words.any { text.contains(it) }

    /** Same rules as the database: 01711… for Bangladesh, else +<digits> */
    fun normalizeWa(raw: String?): String? {
      if (raw.isNullOrBlank()) return null
      val trimmed = raw.trim()
      var d = trimmed.filter { it.isDigit() }
      if (d.isEmpty()) return null
      val plusForeign = trimmed.startsWith("+") && !d.startsWith("880")
      val bd = CallLogStore.normalizeBd(d)
      if (bd != null && !plusForeign) return bd
      if (d.startsWith("00")) d = d.substring(2)
      return "+$d"
    }
  }
}
