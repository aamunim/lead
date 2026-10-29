package expo.modules.calllog

import android.content.Context
import org.json.JSONArray
import java.io.File

/**
 * A small on-phone list of the user's leads: number hash → name and a few details.
 * Lets the phone recognise a lead call (ringing or just ended) with no internet.
 * Stored in the app's private storage; refreshed by the app after each sync.
 */
object LeadDirectory {
  private const val FILE = "lead_directory.json"

  data class Entry(
    val leadId: String,
    val name: String,
    val rating: String?,
    val stage: String?,
    val course: String?,
    val lastNote: String?,
  )

  @Volatile private var cache: Map<String, Entry>? = null

  private fun file(context: Context) = File(context.applicationContext.filesDir, FILE)

  /** Save the list sent by the app: [{hash, lead_id, name, rating, stage, course, last_note}] */
  @Synchronized
  fun save(context: Context, json: String) {
    file(context).writeText(json)
    cache = parse(json)
  }

  @Synchronized
  fun clear(context: Context) {
    file(context).delete()
    cache = emptyMap()
  }

  fun size(context: Context): Int = load(context).size

  /** Find a lead by the SHA-256 hash of its normalized number */
  fun find(context: Context, hash: String): Entry? = load(context)[hash]

  /** Find a lead by a raw phone number ("+880 1711…" works too) */
  fun findByNumber(context: Context, rawNumber: String?): Entry? {
    val number = CallLogStore.normalizeBd(rawNumber) ?: return null
    return find(context, CallLogStore.sha256Hex(number))
  }

  /** Find a lead by a directory key: a number ("01711…", "+971…") or "u:<username>" */
  fun findKey(context: Context, key: String): Entry? = find(context, CallLogStore.sha256Hex(key))

  /** The one lead with exactly this name (case does not matter); null if none or several */
  fun findUniqueByName(context: Context, name: String): Entry? {
    val wanted = name.trim().lowercase()
    if (wanted.isEmpty()) return null
    val hits = load(context).values.filter { it.name.trim().lowercase() == wanted }.distinctBy { it.leadId }
    return hits.singleOrNull()
  }

  @Synchronized
  private fun load(context: Context): Map<String, Entry> {
    cache?.let { return it }
    val f = file(context)
    val map = if (f.exists()) parse(f.readText()) else emptyMap()
    cache = map
    return map
  }

  private fun parse(json: String): Map<String, Entry> {
    return try {
      val arr = JSONArray(json)
      val map = HashMap<String, Entry>(arr.length())
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        val hash = o.optString("hash")
        if (hash.isBlank()) continue
        map[hash] = Entry(
          leadId = o.optString("lead_id"),
          name = o.optString("name"),
          rating = o.optString("rating").takeIf { it.isNotBlank() && it != "null" },
          stage = o.optString("stage").takeIf { it.isNotBlank() && it != "null" },
          course = o.optString("course").takeIf { it.isNotBlank() && it != "null" },
          lastNote = o.optString("last_note").takeIf { it.isNotBlank() && it != "null" },
        )
      }
      map
    } catch (_: Throwable) {
      emptyMap()
    }
  }
}