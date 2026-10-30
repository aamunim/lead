# 🔄 EAS Update: sending app changes without a new build

## How it works
- Builds (preview APK / production AAB) carry **runtime version `"1"`** (`app.json → runtimeVersion`).
- `eas update` sends the JavaScript part of the app to every installed build with the **same runtime** on that channel.
- The phone looks for an update when the app opens, and again when it comes back to the front (at most every 30 minutes).
- A downloaded update starts after a restart: the app shows **"A new version is ready · Restart"**, or it starts by itself the next time the app is opened.
- **More → About** shows the update in use and has **Check for updates**.

| Channel | Build profile | For |
|---|---|---|
| `production` | `production` (AAB, Play Store) | everyone |
| `preview` | `preview` (APK) | testing first |
| — | `development` | dev client (code from Metro, no updates) |

## Sending an update (from the PC)
```
git checkout -B main origin/main
npx supabase db push                     # database first, always
npx eas-cli@latest update --channel preview --environment preview --message "What changed"
# check it on a preview phone, then:
npx eas-cli@latest update --channel production --environment production --message "What changed"
```
Undo a bad update on a channel:
```
npx eas-cli@latest update:list --branch production            # find the earlier good update's group id
npx eas-cli@latest update:republish --group <group id>         # send that one again
# or go back to the code inside the build:
npx eas-cli@latest update:roll-back-to-embedded --channel production
```

## When a NEW BUILD is needed (and runtimeVersion goes up: "1" → "2")
Anything native:
- a new library with native code (e.g. `npx expo install expo-…`), or a library's version changed
- `app.json` / `app.config.js` changes in android settings, permissions, plugins, icon, splash
- the `modules/call-log` (Kotlin) code

Then: raise `runtimeVersion`, make the builds, upload the AAB to Play Store. Updates sent after that go only to the new builds.
