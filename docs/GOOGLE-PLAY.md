# Google Play: Data safety, Permissions Declaration, review video

> The app's own texts must stay in step with this file:
> Privacy policy `src/app/privacy.tsx` (https://lead.ittc.edu.bd/privacy),
> disclosures `src/shared/ui/Disclosure.tsx`, account deletion https://lead.ittc.edu.bd/delete-account.

---

## 1. App content → Privacy policy

- URL: `https://lead.ittc.edu.bd/privacy`

## 2. App content → Data safety

### Data collection and security (first page)

| Question                                                                                                                             | Answer                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Does your app collect or share any of the required user data types?                                                                  | **Yes**                                                                |
| Is all of the user data collected by your app encrypted in transit?                                                                  | **Yes** (HTTPS only)                                                   |
| Which of the following methods of account creation does your app support?                                                            | **Username and password** (e-mail + password)                          |
| Delete account URL                                                                                                                   | `https://lead.ittc.edu.bd/delete-account`                              |
| Do you provide a way for users to request that some or all of their data is deleted, without requiring them to delete their account? | **No** (only account deletion; an admin can delete single leads/notes) |

### Data types

For every type below: **Collected = Yes, Shared = No.** Service providers (Supabase, Firebase/Expo, Google Drive) are not "sharing" in Google's rules.
"Processed ephemerally" = **No**, except where it says **Yes**.

| Category → type                                                                                                                   | Required / optional | Purposes                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------- |
| Personal info → **Name**                                                                                                          | Required            | App functionality, Account management       |
| Personal info → **Email address**                                                                                                 | Required            | App functionality, Account management       |
| Personal info → **Phone number**                                                                                                  | Required            | App functionality, Account management       |
| Personal info → **User IDs**                                                                                                      | Required            | App functionality, Account management       |
| Personal info → **Other info** (call history with leads: time, duration, direction, SIM; WhatsApp call/message events with leads) | Optional            | App functionality                           |
| Financial info → **Other financial info** (students' fees and payments typed by staff)                                            | Optional            | App functionality                           |
| Messages → **Other in-app messages** (chat with the developer, feedback)                                                          | Optional            | App functionality, Developer communications |
| Photos and videos → **Photos** (paper photos, profile photo)                                                                      | Optional            | App functionality                           |
| Audio → **Voice or sound recordings** (voice notes)                                                                               | Optional            | App functionality                           |
| Files and docs → **Files and docs** (uploaded papers)                                                                             | Optional            | App functionality                           |
| Contacts → **Contacts** (only the ones the user picks to save as leads)                                                           | Optional            | App functionality                           |
| App activity → **App interactions** (sessions: when the app is used)                                                              | Required            | App functionality, Analytics                |
| App info and performance → **Crash logs**                                                                                         | Required            | App functionality (fixing problems)         |
| App info and performance → **Diagnostics** (app version, update id)                                                               | Required            | App functionality, Analytics                |
| Device or other IDs → **Device or other IDs** (push token, device model id)                                                       | Required            | App functionality                           |

**Not collected:** Location, Health, Web browsing, Calendar, SMS, Emails, Videos, Music, Installed apps, Advertising ID.
**No ads.** The app does not use the Advertising ID.

> নোট: "Shared = No", কারণ ডেটা শুধু সার্ভিস প্রোভাইডার (Supabase, Firebase/Expo, Google Drive) দেখে, যারা আমাদের হয়ে কাজ করে। Google-এর নিয়মে এটা "sharing" নয়।

---

## 3. App content → Sensitive permissions (Permissions Declaration Form)

### READ_CALL_LOG (+ READ_PHONE_STATE)

- **Core functionality:** choose **"Enterprise archive, CRM, and enterprise device management"**. If the console doesn't offer it, choose the closest CRM option.
- **Description (copy this):**

> Ideal Teachers' Training College Admission Tracker is the internal admission CRM of Ideal Teachers' Training College. Only the institute's own staff (counsellors and callers) use it, with accounts that an admin approves. Staff phone people who asked about admission (leads). The app reads the call log so that every call with a lead (time, duration, direction, SIM) is saved on that lead's record without typing. Admins use this to see the follow-up of each lead. Only calls with numbers that are already leads are uploaded. For any other number, only a one-way hash is kept for at most 15 days, so the call can be linked if the number becomes a lead later. Call recordings are never made or read. Call log access is optional: the admin turns it on per user, and before Android asks for the permission the app shows its own disclosure dialog, and the user must tap Allow. READ_PHONE_STATE is used only to detect when a call ends, so the call can be saved and the user reminded to add a note.

- **Video:** see section 5.

### Other permissions (no form, but Google may ask in review)

| Permission                                        | Why                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification access (NotificationListenerService) | Optional WhatsApp sync: records that a WhatsApp call/message with a lead happened. Only WhatsApp notifications are looked at; message text is never read. A disclosure is shown first. |
| SYSTEM_ALERT_WINDOW                               | The caller card: shows the lead's name and stage over the call screen. A disclosure is shown first.                                                                                    |
| READ_CONTACTS                                     | "Phone contacts": choose contacts to save as leads. Only the chosen ones are uploaded. A disclosure is shown first.                                                                    |
| CAMERA, RECORD_AUDIO, photos                      | Paper photos and voice notes, only when the user taps the button                                                                                                                       |
| POST_NOTIFICATIONS                                | Reminders, new leads, messages                                                                                                                                                         |

---

## 4. App access (for the reviewer)

- **All or some functionality is restricted** → add a reviewer login (e-mail + password).
  - Make a test account with the **Caller** role and call sync turned on.
  - Type the password **only in Play Console**, never in chat or in the repository.
- Instructions: "Sign in with the account above. More → Call log sync shows the call log disclosure and permission. More → Phone contacts shows the contacts disclosure."

---

## 5. The review video (call log)

Google wants a short screen recording, uploaded to YouTube as **Unlisted**, with the link put in the form.

ভিডিও বানানোর ধাপ (৩০–৬০ সেকেন্ড যথেষ্ট):

1. ফোনে Settings → Apps → অ্যাপ → Permissions থেকে Call log permission আগে বন্ধ করে রাখুন, যাতে disclosure আবার আসে।
2. ফোনের Screen record চালু করুন।
3. অ্যাপ খুলুন → লগইন → **More → Call log sync** → "Allow"।
4. **Disclosure স্ক্রিন** দেখান, ধীরে স্ক্রল করুন যাতে লেখা পড়া যায় → **Allow call log** চাপুন → Android-এর permission dialog → Allow।
5. একটা লিডকে ফোন করুন (বা লিডের নম্বর থেকে ফোন আসুক) → কল শেষ করুন।
6. লিডের পেজ খুলে দেখান কলটা নিজে থেকেই সেভ হয়েছে (সময়, কতক্ষণ)।
7. চাইলে শেষে **More → Privacy policy** খুলে দেখান।
8. ভিডিও YouTube-এ **Unlisted** করে আপলোড করুন, লিংকটা ফর্মে দিন।

> ভিডিওতে কোনো আসল ছাত্র বা লিডের নাম/নম্বর যেন না দেখা যায়: একটা টেস্ট লিড ব্যবহার করুন।
