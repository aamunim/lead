package expo.modules.calllog

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager

/**
 * Android tells us whenever the phone's call state changes:
 *  - RINGING: if the caller is one of our leads, show "Incoming: <name>" with details
 *  - OFFHOOK: call answered / dialing — keep the details on screen while talking
 *  - IDLE:    call ended — remove the "Incoming" notification and schedule a short job
 *             that copies the new call into our queue (works even if the app is closed)
 *
 * The job runs twice (after a few seconds and a bit later), because some phones write
 * the call log entry a little after the call ends.
 */
class CallEndReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
    if (!CallLogStore.isEnabled(context)) return

    when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
      TelephonyManager.EXTRA_STATE_RINGING -> onRinging(context, intent)
      TelephonyManager.EXTRA_STATE_IDLE -> {
        CallNotifier.clearIncoming(context)
        CaptureCallsWorker.runSoon(context)
      }
      else -> Unit
    }
  }

  @Suppress("DEPRECATION")
  private fun onRinging(context: Context, intent: Intent) {
    if (!CallLogStore.notifyIncoming(context)) return

    // Android sends this broadcast twice on newer phones: once without the number, once with it.
    // The number only comes when we have both READ_PHONE_STATE and READ_CALL_LOG.
    val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: return

    try {
      val lead = LeadDirectory.findByNumber(context, number) ?: return
      CallNotifier.incoming(context, lead)
    } catch (_: Throwable) {
      // never crash while the phone is ringing
    }
  }
}