import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { channelLabel, formatDuration, listLeadCalls, outcomeInfo } from '@/features/calls/api';
import { isRecordedVoice, listLeadFiles } from '@/features/files/api';
import type { LeadListItem } from '@/features/leads/api';
import { ago, callDot } from '@/features/leads/lastActivity';
import { VOICE_CONTEXT, clock } from '@/features/voice/format';
import { VoicePlayer } from '@/features/voice/VoiceNote';
import type { PlayableFile } from '@/features/voice/VoicePlayerSheet';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 👁 Peek: the last calls and notes of a lead (whole notes), from the
//   list, without opening the lead page
// =====================================================================

type Item = {
  key: string;
  at: string;
  kind: 'call' | 'note' | 'voice';
  title: string;
  text: string | null;
  color: string;
  by: string | null;
  voice?: PlayableFile;
};

const SHOW = 5;

export function LeadPeekSheet({
  lead,
  nameOf,
  onClose,
  onOpen,
  onAddNote,
}: {
  lead: LeadListItem;
  nameOf: (id: string | null) => string | null;
  onClose: () => void;
  onOpen: () => void;
  onAddNote: () => void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [playing, setPlaying] = useState<PlayableFile | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      listLeadCalls(lead.id).catch(() => []),
      supabase
        .from('lead_activity')
        .select('id, created_at, user_id, details')
        .eq('lead_id', lead.id)
        .eq('action', 'note_added')
        .order('created_at', { ascending: false })
        .limit(SHOW)
        .then(({ data }) => data ?? []),
      listLeadFiles(lead.id).catch(() => []),
    ]).then(([calls, notes, files]) => {
      if (!live) return;
      const list: Item[] = [
        ...calls
          .filter((c) => !(c as { deleted_at?: string | null }).deleted_at)
          .map((c): Item => {
            const wa = channelLabel(c.channel, c.media);
            const length = c.outcome === 'connected' ? formatDuration(c.duration_sec) : null;
            return {
              key: `c-${c.id}`,
              at: c.called_at,
              kind: 'call',
              title: `${wa ? `💬 ${wa}` : '📞 Call'} · ${outcomeInfo(c.outcome).label}${length ? ` ${length}` : ''}`,
              text: c.notes,
              color: callDot(c.outcome),
              by: c.user_id,
            };
          }),
        ...notes.map(
          (n): Item => ({
            key: `n-${n.id}`,
            at: n.created_at,
            kind: 'note',
            title: '📝 Note',
            text: ((n.details ?? {}) as { note?: string }).note ?? null,
            color: colors.primary,
            by: n.user_id,
          }),
        ),
        ...files.filter(isRecordedVoice).map(
          (f): Item => ({
            key: `v-${f.id}`,
            at: f.created_at,
            kind: 'voice',
            title: `🎙 Voice note${f.duration_sec ? ` · ${clock(f.duration_sec)}` : ''}${
              VOICE_CONTEXT[f.context ?? ''] ? ` · ${VOICE_CONTEXT[f.context ?? '']}` : ''
            }`,
            text: null,
            color: colors.primary,
            by: f.uploaded_by,
            voice: { id: f.id, name: f.name, duration_sec: f.duration_sec },
          }),
        ),
      ]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, SHOW);
      setItems(list);
    });
    return () => {
      live = false;
    };
  }, [lead.id]);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title} numberOfLines={1}>
            {lead.name}
          </Text>
          <Text style={styles.sub}>Last calls and notes</Text>

          <ScrollView contentContainerStyle={styles.list}>
            {items === null ? (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            ) : items.length === 0 ? (
              <Text style={styles.empty}>No calls or notes yet.</Text>
            ) : (
              items.map((it) => (
                <Pressable
                  key={it.key}
                  onPress={it.voice ? () => setPlaying(it.voice ?? null) : undefined}
                  disabled={!it.voice}
                  style={styles.item}
                  accessibilityRole={it.voice ? 'button' : undefined}
                >
                  <View style={[styles.dot, { backgroundColor: it.color }]} />
                  <View style={styles.flex}>
                    <Text style={styles.itemTitle}>
                      {it.title}
                      {it.voice ? '  ▶' : ''}
                    </Text>
                    {!!it.text && <Text style={styles.itemText}>{it.text}</Text>}
                    <Text style={styles.meta}>{[ago(it.at), nameOf(it.by)].filter(Boolean).join(' · ')}</Text>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>

          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button title="📝 Add note" variant="secondary" onPress={onAddNote} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button title="Open lead" onPress={onOpen} fullWidth />
            </View>
          </View>
        </View>
      </View>
      <VoicePlayer file={playing} onClose={() => setPlaying(null)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '80%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.border, marginVertical: spacing.sm },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.caption, color: colors.textMuted, marginBottom: spacing.sm },
  list: { gap: spacing.md, paddingVertical: spacing.sm },
  loader: { marginVertical: spacing.xl },
  empty: { fontSize: fontSize.small, color: colors.textMuted, paddingVertical: spacing.lg },
  item: { flexDirection: 'row', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  itemTitle: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  itemText: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  meta: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  buttons: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
});
