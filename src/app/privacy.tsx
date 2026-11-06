import { router, Stack, type Href } from 'expo-router';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { APP_NAME, COLLEGE } from '@/features/web/brand';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🔒 Privacy policy (Google Play asks for a public link):
//   lead.ittc.edu.bd/privacy, open to everyone, signed in or not.
//   Keep it true: when the app starts collecting something new, add it here
//   and change UPDATED.
// =====================================================================

const UPDATED = '4 December 2026';
const SITE = 'https://lead.ittc.edu.bd';

type Section = { title: string; text?: string; items?: string[] };

const SECTIONS: Section[] = [
  {
    title: '1. Who we are',
    text: `${APP_NAME} (the “app”, also the website ${SITE}) is the admission and lead management system of ${COLLEGE} (“the institute”, “we”). It is used only by the institute’s own staff (admins, counsellors and callers) to follow up people who are interested in admission, and to keep student, fee and paper records. The institute is responsible for the data in it.`,
  },
  {
    title: '2. What we collect and why',
    items: [
      'Your account: name, e-mail, phone number, password (stored only as a secure hash by our login provider), photo if you add one, role and team. Used to sign you in and to show who did what.',
      'Records of the institute’s work: leads and students (names, phone numbers, guardian, e-mail, area, courses, notes, voice notes, follow-ups, fees, payments, receipts and papers). Staff type or upload these; they are the institute’s business records.',
      'Calls (Android app, only if your admin turns on call sync for you): for calls with a number that is already a lead, the time, duration, direction, result and SIM name are saved with that lead, so the follow-up is recorded. Calls with other numbers are not saved; the app keeps only a one-way hash of such a number for at most 15 days so that a call can be matched if the number becomes a lead. Recordings are never made or uploaded.',
      'WhatsApp activity (Android app, only if you turn it on): from WhatsApp notifications on your phone the app notes that a call or message with a lead happened (time, direction, call length, type). Message text and media are not uploaded.',
      'Contacts: read on your phone only while you open “Phone contacts”, to show which numbers are already leads. Only the contacts you choose are saved, as leads.',
      'Camera, photos and microphone: only when you take or choose a photo of a paper, or record a voice note.',
      'Device and app information: phone model or browser name, app version, update number, time of use (sessions) and notification tokens. Used to send notifications, to show which app version each person has, and to find problems.',
      'Problem reports: if the app crashes, or you send feedback (for example a screenshot), the error details and what you send go to the app’s developer to fix the problem.',
    ],
  },
  {
    title: '3. Permissions on your phone',
    items: [
      'Notifications: to tell you about new leads, follow-ups and messages.',
      'Call log and phone state: only for call sync (above).',
      'Display over other apps: to show a small card about the lead during or after a call.',
      'Notification access: only for WhatsApp activity (above), if you turn it on.',
      'Contacts, camera, photos, microphone: only when you use the matching feature.',
      'You can say no to any of these, or turn them off later in your phone’s settings; the rest of the app still works.',
    ],
  },
  {
    title: '4. Where the data is kept and who handles it',
    text: 'We do not sell your data, do not show ads and do not share data with advertisers. Data is handled only by these service providers, for running the app:',
    items: [
      'Supabase (database, login and file storage; servers in Singapore)',
      'Google Firebase Cloud Messaging and Expo (to deliver notifications)',
      'Google Drive of the institute (copies of uploaded papers and files)',
      'Expo (app updates)',
    ],
  },
  {
    title: '5. How long we keep it',
    items: [
      'Your account: until it is deleted (see 7).',
      'Lead, student, call and payment records: as long as the institute needs them for its admissions and accounts.',
      'Hashes of non-lead call numbers: at most 15 days.',
      'App session history: about 90 days.',
      'Notification delivery details: about 14 days.',
    ],
  },
  {
    title: '6. Security',
    text: 'All traffic is encrypted (HTTPS). Each person sees only what their role allows (for example, a caller sees only their own leads). Passwords are never stored in readable form and nobody at the institute can see them.',
  },
  {
    title: '7. Your choices and deleting your account',
    items: [
      'You can see and correct your name, phone and photo in the app (More → My profile).',
      'You can delete your account at any time: in the app (More → Delete my account) or on the web page below, also if you cannot sign in.',
      'When an account is deleted, your name, e-mail, phone, photo, login, notifications, devices and saved settings are removed for ever. Records of the institute’s work that you made (leads, calls, notes, payments) stay with the institute and are shown as “Deleted user”.',
      'Leads and students whose data is in the app can ask the institute to see, correct or remove their data.',
    ],
  },
  {
    title: '8. Children',
    text: 'The app is for the institute’s staff only and is not meant for children.',
  },
  {
    title: '9. Changes',
    text: 'If this policy changes, the new version is put on this page with a new date. Important changes are also shown in the app.',
  },
  {
    title: '10. Contact',
    text: `${COLLEGE}. For questions about this policy or your data, contact the institute’s office, or use the account deletion page.`,
  },
];

export default function PrivacyScreen() {
  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Privacy policy', headerShown: true }} />
      <Text style={styles.h1}>🔒 Privacy policy</Text>
      <Text style={styles.muted}>
        {APP_NAME} · Last updated {UPDATED}
      </Text>

      {SECTIONS.map((s) => (
        <View key={s.title} style={styles.card}>
          <Text style={styles.h2}>{s.title}</Text>
          {!!s.text && <Text style={styles.text}>{s.text}</Text>}
          {s.items?.map((t) => (
            <View key={t} style={styles.row}>
              <Text style={styles.bullet}>•</Text>
              <Text style={[styles.text, styles.flex]}>{t}</Text>
            </View>
          ))}
          {s.title.startsWith('7.') && (
            <Pressable onPress={() => router.push('/delete-account' as Href)} accessibilityRole="link">
              <Text style={styles.link}>🗑 {SITE.replace('https://', '')}/delete-account</Text>
            </Pressable>
          )}
          {s.title.startsWith('10.') && (
            <Pressable onPress={() => Linking.openURL(SITE)} accessibilityRole="link">
              <Text style={styles.link}>🌐 {SITE.replace('https://', '')}</Text>
            </Pressable>
          )}
        </View>
      ))}

      <Button title="Back" variant="ghost" onPress={leave} fullWidth />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(Platform.OS === 'web' ? { maxWidth: 760, width: '100%', alignSelf: 'center', paddingTop: spacing.xl } : {}),
  },
  h1: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  h2: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  text: { fontSize: fontSize.small, color: colors.text, lineHeight: 21 },
  row: { flexDirection: 'row', gap: spacing.sm },
  bullet: { fontSize: fontSize.small, color: colors.textMuted, lineHeight: 21 },
  flex: { flex: 1 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
