import { router, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { openSms, openWhatsApp, type LeadContact } from '@/features/leads/contact';
import {
  fillTemplate,
  listTemplates,
  loadTemplateContext,
  logTemplateSent,
  VARIABLES,
  type MessageTemplate,
  type TemplateChannel,
  type TemplateContext,
  type TemplateSettings,
} from '@/features/templates/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💬 Pick a template for WhatsApp / SMS, see it filled in, change it, send
// =====================================================================

const WHATSAPP_GREEN = '#1F7A57';

type Props = {
  visible: boolean;
  lead: (LeadContact & { id: string; name: string }) | null;
  channel: TemplateChannel;
  settings: TemplateSettings;
  onClose: () => void;
  /** "Just open the chat" (no template) */
  onPlain: () => void;
  /** A template was sent (and logged on the lead) */
  onSent?: (templateName: string) => void;
};

export function TemplateSheet({ visible, lead, channel, settings, onClose, onPlain, onSent }: Props) {
  const { profile } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [ctx, setCtx] = useState<TemplateContext>({});
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [picked, setPicked] = useState<MessageTemplate | null>(null);
  const [text, setText] = useState('');
  const [filled, setFilled] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // Fresh every time it opens
  useEffect(() => {
    if (!visible || !lead) return;
    setPicked(null);
    setSearch('');
    setCategory(null);
    setError(null);
    setLoading(true);
    const me = profile as unknown as { full_name: string | null; phone?: string | null } | null;
    Promise.all([listTemplates(), loadTemplateContext(lead.id, me, settings)])
      .then(([t, c]) => {
        setTemplates(t);
        setCtx(c.ctx);
        setCourseIds(c.courseIds);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the templates.'))
      .finally(() => setLoading(false));
  }, [visible, lead, profile, settings]);

  // Templates for this channel and this lead's course, most used first
  const usable = useMemo(
    () =>
      templates
        .filter((t) => t.is_active && (t.channels === 'both' || t.channels === channel))
        .filter((t) => !t.course_ids || t.course_ids.length === 0 || t.course_ids.some((id) => courseIds.includes(id)))
        .sort((a, b) => b.use_count - a.use_count || a.sort_order - b.sort_order),
    [templates, channel, courseIds],
  );
  const categories = [...new Set(usable.map((t) => t.category).filter(Boolean))] as string[];
  const q = search.trim().toLowerCase();
  const shown = usable.filter(
    (t) =>
      (!category || t.category === category) &&
      (!q || t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)),
  );

  const pick = (t: MessageTemplate) => {
    const f = fillTemplate(t.body, ctx);
    setPicked(t);
    setText(f.text);
    setFilled(f.text);
    setMissing(f.missing);
  };

  const send = async () => {
    if (!lead || !picked || !text.trim()) return;
    setSending(true);
    const opened =
      channel === 'whatsapp' ? await openWhatsApp(lead, text.trim()) : lead.phone ? await openSms(lead.phone, text.trim()) : false;
    if (opened) {
      // Saved on the lead; a failed save must not stop the message
      logTemplateSent(lead.id, picked.id, channel, text.trim() !== filled.trim()).catch(() => undefined);
      onSent?.(picked.name);
      onClose();
    }
    setSending(false);
  };

  const label = (key: string) => VARIABLES.find((v) => v.key === key)?.label ?? key;
  const isWa = channel === 'whatsapp';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {isWa ? '💬 WhatsApp' : '✉️ SMS'} · {lead?.name}
            </Text>
            {picked ? (
              <Pressable onPress={() => setPicked(null)} hitSlop={10} accessibilityRole="button">
                <Text style={styles.link}>‹ Templates</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => {
                  onClose();
                  onPlain();
                }}
                hitSlop={10}
                accessibilityRole="button"
              >
                <Text style={styles.link}>Open chat ›</Text>
              </Pressable>
            )}
          </View>

          {picked ? (
            // --- the message, filled in, to check and change -------------
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>{picked.name}</Text>
              {missing.length > 0 && (
                <Text style={styles.warn}>
                  ⚠ Not known for this lead: {missing.map(label).join(', ')}. Check the message before sending.
                </Text>
              )}
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                style={styles.editor}
                textAlignVertical="top"
                accessibilityLabel="Message"
              />
              <Text style={styles.hint}>
                {isWa
                  ? 'WhatsApp opens with this message typed in; tap Send there.'
                  : 'Your SMS app opens with this message typed in; tap Send there.'}
              </Text>
              <Button
                title={isWa ? 'Open WhatsApp with this message' : 'Open SMS with this message'}
                onPress={send}
                loading={sending}
                disabled={!text.trim()}
                fullWidth
              />
            </ScrollView>
          ) : (
            // --- the list ------------------------------------------------
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search templates"
                placeholderTextColor={colors.textMuted}
                style={styles.search}
              />
              {categories.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                  <Chip text="All" on={!category} onPress={() => setCategory(null)} />
                  {categories.map((c) => (
                    <Chip key={c} text={c} on={category === c} onPress={() => setCategory(category === c ? null : c)} />
                  ))}
                </ScrollView>
              )}

              {loading ? (
                <ActivityIndicator color={colors.primary} style={styles.loader} />
              ) : error ? (
                <Text style={styles.error}>{error}</Text>
              ) : shown.length === 0 ? (
                <Text style={styles.empty}>No templates here. Add one in Message templates.</Text>
              ) : (
                shown.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => pick(t)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    accessibilityRole="button"
                  >
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {t.name}
                        {!t.is_shared && <Text style={styles.mine}>  · mine</Text>}
                      </Text>
                      <Text style={styles.rowText} numberOfLines={2}>
                        {fillTemplate(t.body, ctx).text}
                      </Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                ))
              )}

              <Pressable
                onPress={() => {
                  onClose();
                  router.push('/templates' as Href);
                }}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.manage}>✏️ Manage templates</Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button">
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: WHATSAPP_GREEN },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  search: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  chips: { flexDirection: 'row', gap: spacing.xs, paddingVertical: 2 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: WHATSAPP_GREEN, borderColor: WHATSAPP_GREEN },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  loader: { paddingVertical: spacing.xl },
  error: { fontSize: fontSize.small, color: colors.danger },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.7 },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  mine: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  rowText: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 22, color: colors.textMuted },
  manage: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, textAlign: 'center', marginTop: spacing.sm },
  label: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  warn: { fontSize: fontSize.small, color: colors.warning },
  editor: {
    minHeight: 180,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    lineHeight: 22,
    color: colors.text,
    backgroundColor: colors.background,
  },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
});
