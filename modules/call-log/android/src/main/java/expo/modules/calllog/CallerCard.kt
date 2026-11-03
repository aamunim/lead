package expo.modules.calllog

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs

/**
 * 📲 The caller card: while a lead (or an unknown number) is calling, a small
 * card floats over the phone's call screen with who it is, their stage,
 * money due, the last note and the next call. It can be dragged up or down
 * (the place is remembered), it shrinks once the call is answered and goes
 * away when the call ends.
 *
 * Needs "Display over other apps" (Settings.canDrawOverlays). Without it the
 * old "Incoming: <name>" notification is used instead.
 */
object CallerCard {
  private const val PREFS = "caller_card"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_UNKNOWN = "unknown"
  private const val KEY_Y = "y"
  private const val SCHEME = "leadmanagement"

  private const val PRIMARY = "#3557D4"
  private const val TEXT = "#191C24"
  private const val MUTED = "#5A5F6E"
  private const val SOFT = "#F0F2FA"

  private var root: View? = null
  private var params: WindowManager.LayoutParams? = null
  private var details: List<View> = emptyList()
  private var shrunk = false
  private val main = Handler(Looper.getMainLooper())

  private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun enabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, true)

  fun unknownEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_UNKNOWN, true)

  fun setSettings(context: Context, enabled: Boolean?, unknown: Boolean?) {
    prefs(context).edit().apply {
      enabled?.let { putBoolean(KEY_ENABLED, it) }
      unknown?.let { putBoolean(KEY_UNKNOWN, it) }
    }.apply()
  }

  /** "Display over other apps" is allowed */
  fun allowed(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  /** Opens the phone's "Display over other apps" page for this app */
  fun openPermission(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val intent = Intent(
      Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      Uri.parse("package:${context.packageName}"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (_: Throwable) {
      // some phones hide the page: the app details instead
      context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }
  }

  // -------------------------------------------------------------------
  // Show / shrink / hide
  // -------------------------------------------------------------------

  /** lead = null: an unknown number ("Not a lead · Add as lead") */
  fun show(context: Context, lead: LeadDirectory.Entry?, number: String?, autoHideMs: Long = 0) {
    if (!allowed(context)) return
    main.post {
      try {
        hideNow(context)
        build(context.applicationContext, lead, number)
        if (autoHideMs > 0) main.postDelayed({ hideNow(context) }, autoHideMs)
      } catch (_: Throwable) {
        // never get in the way of a call
      }
    }
  }

  /** The call was answered: keep only the name line */
  fun shrink() {
    main.post {
      if (root == null || shrunk) return@post
      shrunk = true
      details.forEach { it.visibility = View.GONE }
    }
  }

  fun hide(context: Context) {
    main.post { hideNow(context) }
  }

  private fun hideNow(context: Context) {
    val v = root ?: return
    root = null
    params = null
    details = emptyList()
    shrunk = false
    try {
      wm(context).removeView(v)
    } catch (_: Throwable) {
      // already gone
    }
  }

  private fun wm(context: Context) = context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager

  // -------------------------------------------------------------------
  // The card
  // -------------------------------------------------------------------
  private fun dp(context: Context, v: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()

  private fun text(context: Context, value: String, size: Float, color: String, bold: Boolean = false, lines: Int = 1) =
    TextView(context).apply {
      text = value
      setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
      setTextColor(Color.parseColor(color))
      if (bold) typeface = Typeface.DEFAULT_BOLD
      maxLines = lines
      ellipsize = TextUtils.TruncateAt.END
    }

  private fun ratingColor(r: String?) =
    when (r?.lowercase()) {
      "hot" -> "#E4572E"
      "warm" -> "#D98E04"
      "cold" -> "#64748B"
      else -> null
    }

  private fun money(v: Double): String = "৳" + NumberFormat.getIntegerInstance(Locale.US).format(v.toLong())

  /** "Today 4:00 PM" / "5 Nov, 4:00 PM" (empty if the date can't be read) */
  private fun whenText(iso: String?): String? {
    if (iso.isNullOrBlank() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
    return try {
      val t = java.time.OffsetDateTime.parse(iso.replace(" ", "T")).atZoneSameInstant(java.time.ZoneId.systemDefault())
      val today = java.time.LocalDate.now()
      val time = t.format(java.time.format.DateTimeFormatter.ofPattern("h:mm a", Locale.US))
      if (t.toLocalDate() == today) "Today $time"
      else t.format(java.time.format.DateTimeFormatter.ofPattern("d MMM", Locale.US)) + ", $time"
    } catch (_: Throwable) {
      null
    }
  }

  private fun button(context: Context, label: String, filled: Boolean, onClick: () -> Unit) =
    text(context, label, 14f, if (filled) "#FFFFFF" else PRIMARY, bold = true).apply {
      gravity = Gravity.CENTER
      setPadding(dp(context, 16), dp(context, 9), dp(context, 16), dp(context, 9))
      background = GradientDrawable().apply {
        cornerRadius = dp(context, 20).toFloat()
        if (filled) setColor(Color.parseColor(PRIMARY)) else {
          setColor(Color.parseColor(SOFT))
        }
      }
      setOnClickListener { onClick() }
    }

  private fun open(context: Context, path: String) {
    try {
      context.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse("$SCHEME://$path")).apply {
          setPackage(context.packageName)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        },
      )
    } catch (_: Throwable) {
      // the app is gone?
    }
    hideNow(context)
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun build(context: Context, lead: LeadDirectory.Entry?, number: String?) {
    val pad = dp(context, 14)

    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, dp(context, 12), pad, pad)
      background = GradientDrawable().apply {
        cornerRadius = dp(context, 20).toFloat()
        setColor(Color.WHITE)
        setStroke(dp(context, 1), Color.parseColor("#E3E7F0"))
      }
      elevation = dp(context, 12).toFloat()
    }

    // ── Title line: name · rating · ✕ (drag here; a tap opens / closes the details)
    val head = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    val title = if (lead != null) lead.name else "📞 Not a lead"
    head.addView(
      text(context, title, 17f, TEXT, bold = true),
      LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
    )
    ratingColor(lead?.rating)?.let { c ->
      head.addView(
        text(context, lead!!.rating!!.uppercase(), 11f, c, bold = true).apply {
          setPadding(dp(context, 8), dp(context, 2), dp(context, 8), dp(context, 2))
          background = GradientDrawable().apply {
            cornerRadius = dp(context, 10).toFloat()
            setColor(Color.parseColor(c))
            alpha = 40
          }
        },
      )
    }
    val close = text(context, "  ✕", 18f, MUTED, bold = true).apply {
      setPadding(dp(context, 8), 0, 0, 0)
      setOnClickListener { hideNow(context) }
    }
    head.addView(close)
    card.addView(head)

    // ── Details
    val rows = mutableListOf<View>()
    fun row(value: String?, color: String = MUTED, size: Float = 13f, lines: Int = 1) {
      if (value.isNullOrBlank()) return
      val tv = text(context, value, size, color, lines = lines).apply { setPadding(0, dp(context, 4), 0, 0) }
      card.addView(tv)
      rows.add(tv)
    }

    if (lead != null) {
      row(
        listOfNotNull(lead.course, lead.stage, lead.owner?.let { "$it's lead" }).joinToString(" · ").ifBlank { null },
        TEXT,
      )
      val money = listOfNotNull(lead.feeDue?.let { "💵 ${money(it)} due" }, lead.studentRef?.let { "ID $it" })
      row(money.joinToString(" · ").ifBlank { null }, if (lead.feeDue != null) "#B23A0B" else MUTED)
      row(lead.lastNote?.let { "📝 “$it”" }, MUTED, 13f, 2)
      row(whenText(lead.nextCall)?.let { "⏰ Next call: $it" })
    } else {
      row(number, TEXT, 15f)
      row("This number is not in your leads.")
    }

    // ── Buttons
    val buttons = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.END
      setPadding(0, dp(context, 10), 0, 0)
    }
    if (lead != null) {
      buttons.addView(button(context, "Open", filled = true) { open(context, "leads/${lead.leadId}") })
    } else {
      val digits = number?.filter { it.isDigit() || it == '+' } ?: ""
      buttons.addView(
        button(context, "➕ Add as lead", filled = true) {
          open(context, "leads/edit/new?phone=${Uri.encode(digits)}")
        },
      )
    }
    card.addView(buttons)
    rows.add(buttons)
    details = rows

    // Side margins around the card
    val frame = FrameLayout(context).apply {
      setPadding(dp(context, 12), 0, dp(context, 12), 0)
      addView(card, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    }

    val type =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    val p = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = 0
      y = prefs(context).getInt(KEY_Y, dp(context, 90))
    }

    // Drag by the title line; a short tap shows / hides the details
    var startY = 0
    var touchY = 0f
    var moved = false
    head.setOnTouchListener { _, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          startY = p.y
          touchY = e.rawY
          moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dy = (e.rawY - touchY).toInt()
          if (abs(dy) > dp(context, 6)) moved = true
          if (moved) {
            p.y = (startY + dy).coerceAtLeast(0)
            try {
              wm(context).updateViewLayout(frame, p)
            } catch (_: Throwable) {
              // gone meanwhile
            }
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          if (moved) {
            prefs(context).edit().putInt(KEY_Y, p.y).apply()
          } else {
            shrunk = !shrunk
            details.forEach { it.visibility = if (shrunk) View.GONE else View.VISIBLE }
          }
          true
        }
        else -> false
      }
    }

    wm(context).addView(frame, p)
    root = frame
    params = p
    shrunk = false
  }
}
