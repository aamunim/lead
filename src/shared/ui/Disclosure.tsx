import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🛡 Prominent disclosure (Google Play rule): before the phone asks for a
//   sensitive permission, the app itself says what it collects, why, and
//   how it is used, and the person taps "Allow" or "Not now".
//   Usage: if (!(await disclose('calls'))) return;
//   Keep this text in step with the Privacy policy (src/app/privacy.tsx).
// =====================================================================

export type DisclosureKind = 'calls' | 'whatsapp' | 'overlay' | 'contacts';

type Text_ = { icon: string; title: string; intro: string; points: string[]; allow: string };

const TEXTS: Record<DisclosureKind, Text_> = {
  calls: {
    icon: '📞',
    title: 'Call log access',
    intro:
      'This app reads your phone’s call log so that calls with leads are saved on the lead by themselves, and you don’t have to type them.',
    points: [
      'What is read: the number, time, duration, direction (in / out / missed) and SIM of each call.',
      'What is uploaded: only calls with numbers that are already leads, to the institute’s secure database, so your admin can see the follow-up.',
      'Calls with other numbers are not uploaded. Only a one-way code (hash) of such a number is kept for at most 15 days, in case it becomes a lead.',
      'Call recordings are never made or read. Nothing is sold or shared with anyone else.',
      'Phone state is used only to know when a call ends.',
      'You can turn this off any time: More → Call log sync, or in the phone’s settings.',
    ],
    allow: 'Allow call log',
  },
  whatsapp: {
    icon: '💬',
    title: 'Notification access (WhatsApp)',
    intro: 'To record WhatsApp calls and chats with leads, the app looks at WhatsApp notifications on this phone.',
    points: [
      'What is read: the name or number in WhatsApp call and message notifications, the time, and the call length.',
      'What is uploaded: only that a call or message with a lead happened (time, direction, length), to the institute’s secure database.',
      'Message text, photos and voice messages are never read or uploaded. Notifications of other apps are ignored.',
      'Nothing is sold or shared with anyone else.',
      'You can turn this off any time: More → Call log sync → WhatsApp, or in the phone’s settings.',
    ],
    allow: 'Continue',
  },
  overlay: {
    icon: '🪟',
    title: 'Display over other apps',
    intro: 'When a lead calls you, or after a call, the app shows a small card on top of the call screen.',
    points: [
      'The card shows who is calling (the lead’s name and stage), so you know before you answer.',
      'Nothing extra is collected or uploaded for this.',
      'You can turn it off any time in the phone’s settings.',
    ],
    allow: 'Continue',
  },
  contacts: {
    icon: '👥',
    title: 'Contacts access',
    intro: 'To save people from your phone’s contacts as leads, the app reads your contacts on this phone.',
    points: [
      'What is read: contact names and phone numbers.',
      'Your contact list is not uploaded. The numbers are only checked against the leads, so you can see who is already a lead.',
      'Only the contacts you tick and save are uploaded, as leads, to the institute’s secure database.',
      'Nothing is sold or shared with anyone else.',
    ],
    allow: 'Allow contacts',
  },
};

type Ask = { kind: DisclosureKind; done: (ok: boolean) => void };
let show: ((a: Ask) => void) | null = null;

/** Show the disclosure; true when the person tapped Allow. */
export function disclose(kind: DisclosureKind): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(true);
  return new Promise((resolve) => {
    if (!show) return resolve(true);
    show({ kind, done: resolve });
  });
}

/** Mounted once, in the root layout */
export function DisclosureHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    show = (a) =>
      setAsk((now) => {
        now?.done(false);
        return a;
      });
    return () => {
      show = null;
    };
  }, []);

  if (!ask) return null;
  const t = TEXTS[ask.kind];
  const finish = (ok: boolean) => {
    ask.done(ok);
    setAsk(null);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => finish(false)} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.icon}>{t.icon}</Text>
            <Text style={styles.title}>{t.title}</Text>
            <Text style={styles.intro}>{t.intro}</Text>
            {t.points.map((p) => (
              <View key={p} style={styles.row}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.point}>{p}</Text>
              </View>
            ))}
            <Text
              style={styles.link}
              onPress={() => {
                finish(false);
                router.push('/privacy' as Href);
              }}
              accessibilityRole="link"
            >
              🔒 Privacy policy
            </Text>
          </ScrollView>
          <View style={styles.buttons}>
            <Button title={t.allow} onPress={() => finish(true)} fullWidth />
            <Button title="Not now" variant="ghost" onPress={() => finish(false)} fullWidth />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    maxHeight: '90%',
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  body: { padding: spacing.lg, gap: spacing.sm },
  icon: { fontSize: 36, textAlign: 'center' },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  intro: { fontSize: fontSize.body, color: colors.text, lineHeight: 22 },
  row: { flexDirection: 'row', gap: spacing.sm },
  bullet: { fontSize: fontSize.small, color: colors.textMuted, lineHeight: 20 },
  point: { flex: 1, fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: spacing.xs },
  buttons: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.xs },
});
