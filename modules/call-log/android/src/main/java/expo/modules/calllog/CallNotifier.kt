package expo.modules.calllog

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Two kinds of notifications:
 *  - after a lead call ends:  "📞 Karim Uddin · 2m 15s — Tap to add a note"
 *  - while a lead is calling: "Incoming: Karim Uddin — HOT · CSE · Last note…"
 * Tapping opens the lead in the app (leadmanagement://leads/<id>).
 */
object CallNotifier {
  private const val CHANNEL_AFTER = "lead_calls_after"
  private const val CHANNEL_INCOMING = "lead_calls_incoming"
  private const val INCOMING_ID = 4201
  private const val SCHEME = "leadmanagement"

  fun canNotify(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) return false
    return NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  private fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL_AFTER) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_AFTER, "After lead calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "Reminds you to add a note after a call with a lead"
        },
      )
    }
    if (nm.getNotificationChannel(CHANNEL_INCOMING) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_INCOMING, "Lead is calling", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Shows who is calling when a lead calls you"
          setSound(null, null) // the phone is already ringing
        },
      )
    }
  }

  private fun openLead(context: Context, leadId: String, query: String, requestCode: Int): PendingIntent {
    val uri = Uri.parse("$SCHEME://leads/$leadId$query")
    val intent = Intent(Intent.ACTION_VIEW, uri).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun formatDuration(sec: Long): String =
    when {
      sec <= 0 -> "0 sec"
      sec < 60 -> "${sec}s"
      sec % 60 == 0L -> "${sec / 60}m"
      else -> "${sec / 60}m ${sec % 60}s"
    }

  private fun details(e: LeadDirectory.Entry): String =
    listOfNotNull(e.rating?.uppercase(), e.course, e.stage).joinToString(" · ")

  // -------------------------------------------------------------------
  // After a lead call ends
  // -------------------------------------------------------------------
  fun afterCall(context: Context, call: CallLogStore.Call, lead: LeadDirectory.Entry) {
    if (!canNotify(context)) return
    ensureChannels(context)

    val missed = call.direction == "missed" || call.direction == "rejected"
    val title = if (missed) "📵 Missed call: ${lead.name}" else "📞 ${lead.name} · ${formatDuration(call.durationSec)}"
    val text = when {
      missed -> "Tap to open and call back"
      call.durationSec > 0 -> "Tap to add a note and rating"
      else -> "Not answered · tap to open"
    }
    val query = if (missed) "" else "?callNote=${Uri.encode(call.id)}"

    val n = NotificationCompat.Builder(context, CHANNEL_AFTER)
      .setSmallIcon(android.R.drawable.sym_action_call)
      .setContentTitle(title)
      .setContentText(text)
      .setSubText(details(lead).ifBlank { null })
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setContentIntent(openLead(context, lead.leadId, query, call.id.hashCode()))
      .build()

    try {
      NotificationManagerCompat.from(context).notify(call.id.hashCode(), n)
    } catch (_: SecurityException) {
      // notifications not allowed
    }
  }

  // -------------------------------------------------------------------
  // While a lead is calling
  // -------------------------------------------------------------------
  fun incoming(context: Context, lead: LeadDirectory.Entry) {
    if (!canNotify(context)) return
    ensureChannels(context)

    val body = buildString {
      append(details(lead).ifBlank { "Lead" })
      lead.lastNote?.let { append("\nLast note: ").append(it) }
    }

    val n = NotificationCompat.Builder(context, CHANNEL_INCOMING)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle("Incoming: ${lead.name}")
      .setContentText(details(lead).ifBlank { "Lead is calling" })
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setAutoCancel(true)
      .setTimeoutAfter(2 * 60 * 1000) // gone after 2 minutes at most
      .setContentIntent(openLead(context, lead.leadId, "", INCOMING_ID))
      .build()

    try {
      NotificationManagerCompat.from(context).notify(INCOMING_ID, n)
    } catch (_: SecurityException) {
      // notifications not allowed
    }
  }

  /** The call ended: remove the "Incoming" notification */
  fun clearIncoming(context: Context) {
    NotificationManagerCompat.from(context).cancel(INCOMING_ID)
  }
}