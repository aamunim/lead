package expo.modules.calllog

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What JavaScript can call. Everything heavy lives in CallLogStore / LeadDirectory / CallNotifier.
 */
class CallLogModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not ready" }

  override fun definition() = ModuleDefinition {
    Name("CallLog")

    // One id per app install
    Function("getDeviceId") {
      CallLogStore.deviceId(context)
    }

    // Which permissions the user has given
    Function("getPermissions") {
      mapOf(
        "callLog" to CallLogStore.hasCallLogPermission(context),
        "phoneState" to CallLogStore.hasPhoneStatePermission(context),
        "notifications" to CallNotifier.canNotify(context),
      )
    }

    // Sync on/off on this phone (also starts/stops the 15-minute safety job)
    Function("isEnabled") {
      CallLogStore.isEnabled(context)
    }

    Function("setEnabled") { enabled: Boolean ->
      CallLogStore.setEnabled(context, enabled)
      if (enabled) {
        CaptureCallsWorker.schedulePeriodic(context)
      } else {
        CaptureCallsWorker.cancelAll(context)
        CallNotifier.clearIncoming(context)
      }
    }

    // SIM cards, and which one to sync (null = all)
    Function("getSims") {
      CallLogStore.sims(context).map { mapOf("id" to it.id, "label" to it.label) }
    }

    Function("getSimFilter") {
      CallLogStore.simFilter(context)
    }

    Function("setSimFilter") { simId: String? ->
      CallLogStore.setSimFilter(context, simId)
    }

    // Copy new calls from the call log into the queue now
    AsyncFunction("captureNow") {
      CallLogStore.capture(context)
    }

    // The queue waiting to be uploaded (a JSON array as text)
    Function("getPending") {
      CallLogStore.pendingJson(context)
    }

    Function("getPendingCount") {
      CallLogStore.pendingCount(context)
    }

    // Drop calls the server has accepted
    Function("removePending") { ids: List<String> ->
      CallLogStore.removePending(context, ids)
    }

    // For the after-call popup: the latest call with this number since a time
    AsyncFunction("latestCallFor") { number: String, sinceMs: Double ->
      CallLogStore.latestCallFor(context, number, sinceMs.toLong())
    }

    // For the note popup opened from a notification: one call by its call-log id
    AsyncFunction("callById") { id: String ->
      CallLogStore.callById(context, id)
    }

    // The app's Call button was pressed: no "add a note" notification for that call
    Function("markAppCall") { number: String ->
      CallLogStore.markAppCall(context, number)
    }

    // ---------------------------------------------------------------
    // Lead directory (number hash → name…) kept on the phone
    // ---------------------------------------------------------------
    AsyncFunction("setLeadDirectory") { json: String ->
      LeadDirectory.save(context, json)
      LeadDirectory.size(context)
    }

    Function("clearLeadDirectory") {
      LeadDirectory.clear(context)
    }

    Function("getLeadDirectorySize") {
      LeadDirectory.size(context)
    }

    // ---------------------------------------------------------------
    // Notifications on/off
    // ---------------------------------------------------------------
    Function("getNotifySettings") {
      mapOf(
        "afterCall" to CallLogStore.notifyAfter(context),
        "incoming" to CallLogStore.notifyIncoming(context),
      )
    }

    Function("setNotifySettings") { afterCall: Boolean?, incoming: Boolean? ->
      CallLogStore.setNotify(context, afterCall, incoming)
      if (incoming == false) CallNotifier.clearIncoming(context)
    }
  }
}