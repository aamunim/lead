package expo.modules.calllog

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * 👥 The phone's contact groups / labels ("Family", "Students 2025", ⭐ Starred…),
 * so Phone contacts can show one group and save all of it as leads.
 * Groups with the same name in different accounts (Google, phone, SIM) are
 * shown as one. Only read; nothing on the phone is changed.
 */
object ContactGroups {
  private fun allowed(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

  /** Group id → the contacts in it */
  private fun membership(context: Context): Map<Long, Set<Long>> {
    val out = HashMap<Long, MutableSet<Long>>()
    context.contentResolver.query(
      ContactsContract.Data.CONTENT_URI,
      arrayOf(
        ContactsContract.Data.CONTACT_ID,
        ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID,
      ),
      "${ContactsContract.Data.MIMETYPE} = ?",
      arrayOf(ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE),
      null,
    )?.use { c ->
      while (c.moveToNext()) {
        val contact = c.getLong(0)
        val group = c.getLong(1)
        out.getOrPut(group) { HashSet() }.add(contact)
      }
    }
    return out
  }

  /** [{key, title, count, ids:[group ids]}], A–Z, without empty or "everyone" groups */
  fun groups(context: Context): String {
    if (!allowed(context)) return "[]"
    val members = membership(context)
    data class G(val title: String, val ids: MutableList<Long>, val contacts: MutableSet<Long>)
    val byTitle = LinkedHashMap<String, G>()

    context.contentResolver.query(
      ContactsContract.Groups.CONTENT_URI,
      arrayOf(
        ContactsContract.Groups._ID,
        ContactsContract.Groups.TITLE,
        ContactsContract.Groups.AUTO_ADD,
        ContactsContract.Groups.SYSTEM_ID,
      ),
      "${ContactsContract.Groups.DELETED} = 0",
      null,
      null,
    )?.use { c ->
      while (c.moveToNext()) {
        val id = c.getLong(0)
        val rawTitle = c.getString(1)?.trim().orEmpty()
        val autoAdd = !c.isNull(2) && c.getInt(2) == 1
        val system = c.getString(3)
        // "My Contacts" holds everyone: not a useful group
        if (autoAdd || system == "Contacts") continue
        val title = when {
          system == "Starred in Android" || rawTitle == "Starred in Android" -> "⭐ Starred"
          rawTitle.isEmpty() -> continue
          else -> rawTitle
        }
        val people = members[id] ?: emptySet()
        val g = byTitle.getOrPut(title.lowercase()) { G(title, ArrayList(), HashSet()) }
        g.ids.add(id)
        g.contacts.addAll(people)
      }
    }

    val arr = JSONArray()
    byTitle.values
      .filter { it.contacts.isNotEmpty() }
      .sortedBy { it.title.lowercase() }
      .forEach { g ->
        arr.put(
          JSONObject()
            .put("key", g.title.lowercase())
            .put("title", g.title)
            .put("count", g.contacts.size)
            .put("ids", JSONArray(g.ids.map { it.toString() })),
        )
      }
    return arr.toString()
  }

  /** The contact ids in these groups (the same ids Phone contacts uses) */
  fun contactIds(context: Context, groupIds: List<String>): List<String> {
    if (!allowed(context) || groupIds.isEmpty()) return emptyList()
    val wanted = groupIds.mapNotNull { it.toLongOrNull() }.toSet()
    val out = LinkedHashSet<String>()
    membership(context).forEach { (group, contacts) ->
      if (group in wanted) contacts.forEach { out.add(it.toString()) }
    }
    return out.toList()
  }
}
