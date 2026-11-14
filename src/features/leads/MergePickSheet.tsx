import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { listLeads, type LeadListItem } from '@/features/leads/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Modal } from '@/shared/ui/Modal';

/**
 * 🔗 Find the other lead to merge with: search by name or number
 * (closed leads too). The leads already chosen are left out.
 */
export function MergePickSheet({
  visible,
  exclude,
  onPick,
  onClose,
  title = 'Merge with which lead?',
}: {
  visible: boolean;
  exclude: string[];
  onPick: (lead: LeadListItem) => void;
  onClose: () => void;
  title?: string;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<LeadListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const reqNo = useRef(0);
  const skip = exclude.join(',');

  useEffect(() => {
    if (!visible) return;
    const s = text.trim();
    if (s.length < 2) {
      setRows([]);
      return;
    }
    const no = ++reqNo.current;
    setBusy(true);
    const t = setTimeout(() => {
      listLeads({ search: s, quick: 'all', closedMode: 'show', page: 0 })
        .then((r) => no === reqNo.current && setRows(r.items.filter((x) => !skip.split(',').includes(x.id))))
        .catch(() => no === reqNo.current && setRows([]))
        .finally(() => no === reqNo.current && setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [text, visible, skip]);

  useEffect(() => {
    if (!visible) setText('');
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={s.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={s.sheet}>
          <View style={s.handle} />
          <Text style={s.title}>{title}</Text>
          <Text style={s.muted}>Search the same person by name or the other number.</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Name or number"
            placeholderTextColor={colors.textMuted}
            autoFocus
            style={s.input}
          />
          {busy && <ActivityIndicator color={colors.primary} style={s.loader} />}
          <FlatList
            data={rows}
            keyExtractor={(r) => r.id}
            keyboardShouldPersistTaps="handled"
            style={s.list}
            ListEmptyComponent={
              !busy && text.trim().length >= 2 ? <Text style={s.muted}>No lead found.</Text> : undefined
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onPick(item)}
                style={({ pressed }) => [s.row, pressed && s.pressed]}
                accessibilityRole="button"
              >
                <View style={s.flex}>
                  <Text style={s.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={s.meta} numberOfLines={1}>
                    {[item.phone ?? item.whatsapp_number, item.stage?.name, item.assignee?.full_name ?? 'Unassigned']
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Text style={s.pick}>Choose ›</Text>
              </Pressable>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    maxHeight: '85%',
    minHeight: '60%',
    padding: spacing.lg,
    gap: spacing.sm,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  loader: { marginVertical: spacing.sm },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pressed: { opacity: 0.6 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  pick: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
