/**
 * 📎 Lead Management → Google Drive
 * Paste this whole file into a new project at https://script.google.com
 * (with the Google account whose Drive should hold the files), change
 * SECRET below, then Deploy → New deployment → Web app:
 *   Execute as: Me    ·    Who has access: Anyone
 * Copy the Web app URL and the SECRET into the app:
 * Settings → Google Drive.
 * Only the app's server knows the URL and the SECRET; without the SECRET
 * every request is refused.
 *
 * Updating an older copy: paste this file over the old code but KEEP your
 * own SECRET line, then Deploy → Manage deployments → ✏️ → Version: New
 * version → Deploy. The URL stays the same.
 */
const SECRET = 'PUT-A-LONG-RANDOM-TEXT-HERE'; // e.g. 30+ letters and numbers, keep it private

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || SECRET.indexOf('PUT-') === 0 || req.secret !== SECRET) return out({ error: 'Not allowed' });

    switch (req.action) {
      case 'ping':
        return out({ ok: true, email: Session.getEffectiveUser().getEmail() });

      case 'folder': {
        const parent = req.parent ? DriveApp.getFolderById(req.parent) : DriveApp.getRootFolder();
        return out({ id: parent.createFolder(String(req.name)).getId() });
      }

      case 'upload': {
        const blob = Utilities.newBlob(
          Utilities.base64Decode(req.data),
          req.mime || 'application/octet-stream',
          String(req.name),
        );
        return out({ id: DriveApp.getFolderById(req.parent).createFile(blob).getId() });
      }

      case 'download': {
        const file = DriveApp.getFileById(req.id);
        const blob = file.getBlob();
        return out({ name: file.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) });
      }

      case 'trash': {
        // Removed in the app: to Drive's Trash (Google empties it after 30 days)
        DriveApp.getFileById(req.id).setTrashed(true);
        return out({ ok: true });
      }

      default:
        return out({ error: 'Unknown action' });
    }
  } catch (err) {
    return out({ error: String(err) });
  }
}

function doGet() {
  return out({ ok: true, app: 'Lead Management Drive' });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor (▶ Run) to give the script access to your Drive */
function allowDrive() {
  DriveApp.getRootFolder().getName();
}
