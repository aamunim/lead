package expo.modules.calllog

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Copies new calls from the phone's call log into the on-phone queue,
 * then shows an "add a note" notification for a call that just ended with a lead.
 * No internet needed: uploading happens later from the app.
 */
class CaptureCallsWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

  override fun doWork(): Result {
    return try {
      val added = CallLogStore.captureNew(applicationContext)
      if (added.isNotEmpty()) notifyLeadCalls(added)
      Result.success()
    } catch (_: Throwable) {
      // Never crash in the background; the next run will try again
      Result.success()
    }
  }

  private fun notifyLeadCalls(calls: List<CallLogStore.Call>) {
    val ctx = applicationContext
    if (!CallLogStore.notifyAfter(ctx)) return
    if (!CallNotifier.canNotify(ctx)) return

    val now = System.currentTimeMillis()

    // Only calls that ended in the last few minutes (no flood of old calls),
    // and only the latest call for each lead
    val latestPerNumber = calls
      .filter { now - it.endedMs <= CallLogStore.RECENT_CALL_MS }
      .groupBy { it.number }
      .mapNotNull { (_, list) -> list.maxByOrNull { it.dateMs } }

    for (call in latestPerNumber) {
      // Called with the app's Call button: the app already shows its own popup
      if (CallLogStore.isAppCall(ctx, call)) continue
      val lead = LeadDirectory.findByNumber(ctx, call.number) ?: continue // not a lead
      CallNotifier.afterCall(ctx, call, lead)
    }
  }

  companion object {
    private const val FAST = "lead-call-capture-fast"
    private const val LATE = "lead-call-capture-late"
    private const val PERIODIC = "lead-call-capture-periodic"

    /** After a call ends: run in ~6 seconds, and once more in ~40 seconds */
    fun runSoon(context: Context) {
      val wm = WorkManager.getInstance(context.applicationContext)
      wm.enqueueUniqueWork(
        FAST,
        ExistingWorkPolicy.REPLACE,
        OneTimeWorkRequestBuilder<CaptureCallsWorker>().setInitialDelay(6, TimeUnit.SECONDS).build(),
      )
      wm.enqueueUniqueWork(
        LATE,
        ExistingWorkPolicy.REPLACE,
        OneTimeWorkRequestBuilder<CaptureCallsWorker>().setInitialDelay(40, TimeUnit.SECONDS).build(),
      )
    }

    /** Safety net: also capture every 15 minutes (Android's shortest repeat) */
    fun schedulePeriodic(context: Context) {
      WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
        PERIODIC,
        ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<CaptureCallsWorker>(15, TimeUnit.MINUTES).build(),
      )
    }

    /** Sync turned off: stop the repeating job */
    fun cancelAll(context: Context) {
      val wm = WorkManager.getInstance(context.applicationContext)
      wm.cancelUniqueWork(FAST)
      wm.cancelUniqueWork(LATE)
      wm.cancelUniqueWork(PERIODIC)
    }
  }
}