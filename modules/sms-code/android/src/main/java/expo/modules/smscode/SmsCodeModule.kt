package expo.modules.smscode

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.util.Base64
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

/**
 * 🔐 Reads the sign-in code SMS by itself (Google's SMS Retriever).
 *  · appHash(): this app's 11-letter code; the server puts it on the SMS's last line
 *  · waitForSms(): starts listening (up to 5 minutes); gives the SMS text, or null
 *  · stop(): stops listening (gives null to the one waiting)
 * No SMS permission: Android only passes on an SMS that ends with this app's code.
 */
class SmsCodeModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not ready" }

  private var receiver: BroadcastReceiver? = null
  private var waiting: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("SmsCode")

    Function("appHash") { appHash() }

    AsyncFunction("waitForSms") { promise: Promise -> start(promise) }

    Function("stop") { finish(null) }

    OnDestroy { finish(null) }
  }

  private fun start(promise: Promise) {
    finish(null) // only one at a time
    val ctx = context
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context, intent: Intent) {
        if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
        val extras = intent.extras ?: return
        @Suppress("DEPRECATION")
        val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status
        if (status?.statusCode == CommonStatusCodes.SUCCESS) {
          finish(extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE))
        } else {
          finish(null) // 5 minutes passed
        }
      }
    }
    synchronized(this) {
      waiting = promise
      receiver = r
    }
    try {
      ContextCompat.registerReceiver(
        ctx,
        r,
        IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
        SmsRetriever.SEND_PERMISSION,
        null,
        ContextCompat.RECEIVER_EXPORTED,
      )
      SmsRetriever.getClient(ctx).startSmsRetriever().addOnFailureListener { finish(null) }
    } catch (e: Exception) {
      finish(null)
    }
  }

  private fun finish(message: String?) {
    val p: Promise?
    val r: BroadcastReceiver?
    synchronized(this) {
      p = waiting
      r = receiver
      waiting = null
      receiver = null
    }
    if (r != null) {
      try {
        context.unregisterReceiver(r)
      } catch (_: Exception) {
      }
    }
    p?.resolve(message)
  }

  /** The 11-letter code Google uses to send the SMS to this app (package + signing key) */
  private fun appHash(): String? =
    try {
      val pkg = context.packageName
      @Suppress("DEPRECATION")
      val sig = context.packageManager.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()
      if (sig == null) {
        null
      } else {
        val digest = MessageDigest.getInstance("SHA-256").digest("$pkg ${sig.toCharsString()}".toByteArray(Charsets.UTF_8))
        Base64.encodeToString(digest.copyOfRange(0, 9), Base64.NO_PADDING or Base64.NO_WRAP).substring(0, 11)
      }
    } catch (_: Exception) {
      null
    }
}
