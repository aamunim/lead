import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { AdmissionCreditCard } from '@/features/aiCredit/AdmissionCreditCard';
import { getLeadCredit, type LeadCredit } from '@/features/aiCredit/api';
import { getContribTimeline, type TimelineItem } from '@/features/contribution/api';
import { Dot, ShareBar, ShareLegend, cs } from '@/features/contribution/ui';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, spacing } from '@/shared/theme';

// =====================================================================
// 🤝 One student: who did how much (bar + reasons + each person's
//   numbers; admins can work it out again or change it by hand), and the
//   story in short — who did what, when.
// =====================================================================

type Head = {
  id: string;
  name: string;
  student_ref: string | null;
  admitted_at: string | null;
  course: { name: string } | null;
};

const KIND: Record<string, string> = {
  added: '➕ Added the lead',
  call_answered: '📞 Call',
  call_missed: '📵 Call, not answered',
  whatsapp: '💬 WhatsApp',
  note_added: '📝 Note',
  visit_planned: '📅 Planned a campus visit',
  visit_done: '🏫 Campus visit',
  paper_received: '📄 Paper received',
  assigned: '🔁 Handed over',
  fee_offer: '💰 Fee offer',
  fee_discount: '💰 Discount',
  payment: '💵 Payment taken',
  admitted: '🎓 Marked Admitted',
};

const day = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function ContributionStudentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [head, setHead] = useState<Head | null>(null);
  const [credit, setCredit] = useState<LeadCredit | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!id) return;
    supabase
      .from('leads')
      .select('id, name, student_ref, admitted_at, course:courses!leads_admitted_course_id_fkey(name)')
      .eq('id', id)
      .maybeSingle()
      .then(({ data }) => setHead(data as unknown as Head | null));
    getLeadCredit(id)
      .then(setCredit)
      .catch(() => undefined);
    getContribTimeline(id)
      .then(setTimeline)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, [id]);

  const names = new Map((credit?.shares ?? []).map((s) => [s.user_id, s.name]));
  const nameOf = (u: string | null | undefined) => (u ? (names.get(u) ?? null) : null);
  const shown = timeline ? (showAll ? timeline : timeline.slice(-30)) : [];

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      keyboardShouldPersistTaps="handled"
      style={cs.screen}
      contentContainerStyle={[cs.content, cs.wide]}
    >
      <Stack.Screen options={{ title: head?.name ?? 'Admission Contribution' }} />
      {!head ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <View style={cs.card}>
          <View style={cs.row}>
            <Text style={[cs.title, { flex: 1 }]}>{head.name}</Text>
            <Pressable onPress={() => router.push(`/leads/${head.id}` as Href)} accessibilityRole="button" hitSlop={8}>
              <Text style={cs.link}>Open ›</Text>
            </Pressable>
          </View>
          <Text style={cs.small}>
            {[head.student_ref, head.course?.name, head.admitted_at ? `Admitted ${day(head.admitted_at)}` : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {credit && credit.shares.length > 0 && (
            <>
              <ShareBar shares={credit.shares} height={14} />
              <ShareLegend shares={credit.shares} max={8} />
            </>
          )}
        </View>
      )}

      {/* shares, reasons, numbers; admins: work out again / by hand */}
      {!!id && head?.admitted_at && <AdmissionCreditCard leadId={id} stateKey={head.admitted_at} nameOf={nameOf} />}

      <Text style={cs.label}>WHO DID WHAT, WHEN</Text>
      {error && <Text style={[cs.text, cs.bad]}>{error}</Text>}
      {!timeline ? (
        <ActivityIndicator color={colors.primary} />
      ) : timeline.length === 0 ? (
        <Text style={cs.muted}>Nothing recorded.</Text>
      ) : (
        <View style={cs.card}>
          {timeline.length > shown.length && (
            <Pressable onPress={() => setShowAll(true)} accessibilityRole="button">
              <Text style={cs.link}>Show the {timeline.length - shown.length} earlier ones</Text>
            </Pressable>
          )}
          {shown.map((e, i) => (
            <View key={`${e.at}-${i}`} style={styles.item}>
              {e.user_id ? <Dot userId={e.user_id} size={10} /> : <View style={styles.noDot} />}
              <View style={{ flex: 1 }}>
                <Text style={cs.text}>
                  {KIND[e.kind] ?? e.kind}
                  {e.minutes ? ` · ${e.minutes} min` : ''}
                  {e.name ? <Text style={cs.small}> · {e.name}</Text> : null}
                </Text>
                {!!e.text && <Text style={styles.note}>{e.text}</Text>}
                <Text style={cs.small}>{day(e.at)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', paddingVertical: 4 },
  noDot: { width: 10 },
  note: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted, fontStyle: 'italic' },
});
