import { router, type Href } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { alumniToday, type AlumniToday } from '@/features/alumni/api';
import { whenText } from '@/features/alumni/sheets';
import { useAlumniAccess } from '@/features/alumni/ui';
import { useAlumniDialer } from '@/features/alumni/useAlumniDialer';
import { Fold, MIcon, md, Tap } from '@/features/home/md';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

// =====================================================================
// 🎓 Home: alumni to contact today (the next contact that is due) and
//   today's birthdays. Only for people who see alumni; one small request.
// =====================================================================

export function AlumniHomeCard() {
  const access = useAlumniAccess();
  const [data, setData] = useSavedState<AlumniToday | null>('home:alumni', null);
  // 📞 right from Home; the popup asks what happened when you come back
  const dialer = useAlumniDialer();

  useFocusRefresh(
    useCallback(() => {
      if (!access.view) return;
      alumniToday(5)
        .then(setData)
        .catch(() => undefined);
    }, [access.view, setData]),
  );

  if (!access.view || !data || (data.due === 0 && data.birthdays.length === 0)) return null;
  const late = data.list.filter((x) => x.late).length;
  return (
    <>
      <Fold
        id="alumni-today"
        icon="school"
        tint={{ bg: md.goldC, fg: md.onGoldC }}
        title="Alumni to contact"
        summary={[
          data.due > 0 ? `${data.due} due${late ? ` · ${late} late` : ''}` : null,
          data.birthdays.length ? `🎂 ${data.birthdays.length}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        defaultOpen
      >
        {data.list.map((x) => (
          <View key={x.id} style={styles.row}>
            <Pressable
              onPress={() => router.push(`/alumni/${x.id}` as Href)}
              style={({ pressed }) => [styles.flex, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.name} numberOfLines={1}>
                {x.name}
              </Text>
              <Text style={[styles.what, x.late && styles.late]} numberOfLines={1}>
                {x.late ? '⚠ ' : '⏰ '}
                {whenText(x.next_contact_at)}
                {x.next_contact_note ? ` · ${x.next_contact_note}` : x.batch_name ? ` · ${x.batch_name}` : ''}
              </Text>
            </Pressable>
            {!!x.phone && (
              <Tap
                onPress={() => dialer.call({ id: x.id, name: x.name, phone: x.phone, whatsapp_number: null })}
                style={styles.call}
                label={`Call ${x.name}`}
              >
                <MIcon name="call" size={20} color={md.onOkC} />
              </Tap>
            )}
          </View>
        ))}
        {data.birthdays.map((b) => (
          <Pressable
            key={b.id}
            onPress={() => router.push(`/alumni/${b.id}?wa=1` as Href)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={[styles.name, styles.flex]} numberOfLines={1}>
              🎂 {b.name}
            </Text>
            <Text style={styles.wish}>Send a wish ›</Text>
          </Pressable>
        ))}
        <View style={styles.footer}>
          <Pressable onPress={() => router.push('/alumni' as Href)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.all}>All alumni ›</Text>
          </Pressable>
        </View>
      </Fold>
      {/* outside the card: it shows even when the card is folded */}
      {dialer.sheet}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  pressed: { opacity: 0.7 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  what: { fontSize: fontSize.caption, color: colors.textMuted },
  late: { color: colors.danger },
  wish: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  call: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.okC,
    overflow: 'hidden',
  },
  footer: { alignItems: 'flex-end', paddingTop: 2 },
  all: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
