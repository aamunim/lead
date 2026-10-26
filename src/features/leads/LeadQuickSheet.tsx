import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { cancelFollowUp, followUpPresets, formatDue, scheduleFollowUp } from '@/features/follow-ups/api';
import {
  addNoteToLeads,
  addTagsToLeads,
  listAssignableUsers,
  removeTagsFromLeads,
  updateLeads,
  type LeadListItem,
  type QuickPatch,
  type Rating,
} from '@/features/leads/api';
import { createItem, listHolidays, listItems, type Holiday } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';

export type QuickField = 'rating' | 'stage' | 'tags' | 'assign' | 'followup' | 'note';

type Option = { value: string; label: string; color?: string };
type TagMark = 'add' | 'remove';

const TITLES: Record<QuickField, string> = {
  rating: 'Rating',
  stage: 'Stage',
  tags: 'Tags',
  assign: 'Assign to',
  followup: 'Next call',
  note: 'Add a note',
};

const RATINGS: { value: Rating; label: string; color: string }[] = [
  { value: 'hot', label: 'Hot', color: colors.hot },
  { value: 'warm', label: 'Warm', color: colors.warm },
  { value: 'cold', label: 'Cold', color: colors.cold },
];

// Colours given to new tags, in turn
const TAG_COLORS = ['#EC4899', '#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#14B8A6', '#6366F1'];

function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

type Props = {
  visible: boolean;
  /** Which thing to change */
  field: QuickField;
  /** The marked leads (one or many) */
  leads: LeadListItem[];
  onClose: () => void;
  /** Called after saving, with a short message to show */
  onSaved: (message: string) => void;
};

export function LeadQuickSheet({ visible, field, leads, onClose, onSaved }: Props) {
  const { profile, hasPermission } = useAuth();
  const seesAllLeads = hasPermission('leads.view_all');

  const single = leads.length === 1 ? leads[0] : null;
  const count = leads.length;
  const ids = leads.map((l) => l.id);

  const [options, setOptions] = useState<Option[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tags: one lead = tick boxes; many leads = add / remove marks
  const [tagSet, setTagSet] = useState<Set<string>>(new Set());
  const [tagMarks, setTagMarks] = useState<Map<string, TagMark>>(new Map());

  // New tag
  const [newTag, setNewTag] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);

  // Note
  const [note, setNote] = useState('');

  // A holiday date picked by hand, waiting for a second tap to confirm
  const [pendingHoliday, setPendingHoliday] = useState<Date | null>(null);

  // --- load what this field needs ---------------------------------------
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setTagSet(new Set(single ? single.lead_tags.map((t) => t.tag_id) : []));
    setTagMarks(new Map());
    setNewTag('');
    setNote('');
    setPendingHoliday(null);

    const load = async () => {
      if (field === 'rating' || field === 'note') return;
      setLoading(true);
      try {
        if (field === 'stage') {
          const stg = await listItems('pipeline_stages');
          setOptions(
            stg
              .filter((s) => s.kind === 'open')
              .map((s) => ({ value: s.id, label: s.name, color: s.color as string })),
          );
        } else if (field === 'tags') {
          const tg = await listItems('tags');
          setOptions(tg.map((t) => ({ value: t.id, label: t.name, color: t.color as string })));
        } else if (field === 'assign') {
          const ppl = await listAssignableUsers(seesAllLeads ? {} : { teamLeadId: profile?.id });
          setOptions(ppl.map((p) => ({ value: p.id, label: p.full_name ?? 'No name' })));
        } else if (field === 'followup') {
          const year = new Date().getFullYear();
          const [h1, h2] = await Promise.all([
            listHolidays(year).catch(() => []),
            listHolidays(year + 1).catch(() => []),
          ]);
          setHolidays([...h1, ...h2]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the options.');
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, field]);

  const holidayName = (d: Date) => {
    const key = dayKey(d);
    return holidays.find((h) => h.start_date <= key && key <= h.end_date)?.name ?? null;
  };

  const presets = useMemo(
    () => (visible && field === 'followup' ? followUpPresets(new Date(), (d) => holidayName(d) !== null) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, field, holidays],
  );

  // --- saving ------------------------------------------------------------
  const done = (changed: number) => {
    const skipped = count - changed;
    onSaved(
      single
        ? 'Saved.'
        : skipped > 0
          ? `Saved for ${changed} of ${count}. ${skipped} could not be changed (no permission).`
          : `Saved for ${count} leads.`,
    );
  };

  const run = async (work: () => Promise<number>) => {
    setSaving(true);
    setError(null);
    try {
      done(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const applyPatch = (patch: QuickPatch) => run(() => updateLeads(ids, patch));

  const applyFollowUp = (date: Date | null) =>
    run(async () => {
      for (let i = 0; i < ids.length; i += 5) {
        await Promise.all(
          ids.slice(i, i + 5).map((id) => (date ? scheduleFollowUp(id, date) : cancelFollowUp(id))),
        );
      }
      return count;
    });

  const applyNote = () => run(() => addNoteToLeads(ids, note));

  const pickFollowUpDate = (date: Date) => {
    if (pendingHoliday && dayKey(pendingHoliday) === dayKey(date)) {
      applyFollowUp(date);
      return;
    }
    const holiday = holidayName(date);
    if (holiday) {
      setError(`⚠️ ${formatDue(date)} is a holiday (${holiday}). Pick the same day again to keep it, or pick another.`);
      setPendingHoliday(date);
      return;
    }
    applyFollowUp(date);
  };

  const applyTags = () =>
    run(async () => {
      let add: string[] = [];
      let remove: string[] = [];
      if (single) {
        const before = new Set(single.lead_tags.map((t) => t.tag_id));
        add = [...tagSet].filter((t) => !before.has(t));
        remove = [...before].filter((t) => !tagSet.has(t));
      } else {
        tagMarks.forEach((mark, tagId) => (mark === 'add' ? add.push(tagId) : remove.push(tagId)));
      }
      if (add.length > 0) await addTagsToLeads(ids, add);
      if (remove.length > 0) await removeTagsFromLeads(ids, remove);
      return count;
    });

  const pressTag = (tagId: string) => {
    if (single) {
      const next = new Set(tagSet);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      setTagSet(next);
      return;
    }
    // Many leads: nothing → Add → Remove → nothing
    const next = new Map(tagMarks);
    const now = next.get(tagId);
    if (!now) next.set(tagId, 'add');
    else if (now === 'add') next.set(tagId, 'remove');
    else next.delete(tagId);
    setTagMarks(next);
  };

  // Create a new tag and tick it straight away
  const handleCreateTag = async () => {
    const name = newTag.trim();
    if (!name) return;

    // Already exists? Just tick it.
    const existing = options.find((o) => o.label.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (single) setTagSet((s) => new Set(s).add(existing.value));
      else setTagMarks((m) => new Map(m).set(existing.value, 'add'));
      setNewTag('');
      return;
    }

    setCreatingTag(true);
    setError(null);
    try {
      const color = TAG_COLORS[options.length % TAG_COLORS.length];
      const created = await createItem('tags', { name, color });
      setOptions((list) => [...list, { value: created.id, label: created.name, color }]);
      if (single) setTagSet((s) => new Set(s).add(created.id));
      else setTagMarks((m) => new Map(m).set(created.id, 'add'));
      setNewTag('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the tag.');
    } finally {
      setCreatingTag(false);
    }
  };

  // --- body for each field ----------------------------------------------
  const renderBody = () => {
    if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />;

    switch (field) {
      case 'rating':
        return (
          <View style={styles.bigRow}>
            {RATINGS.map((r) => (
              <BigChoice
                key={r.value}
                label={r.label}
                color={r.color}
                on={single?.rating === r.value}
                disabled={saving}
                onPress={() => applyPatch({ rating: r.value })}
              />
            ))}
            <BigChoice
              label="None"
              color={colors.textMuted}
              on={!!single && !single.rating}
              disabled={saving}
              onPress={() => applyPatch({ rating: null })}
            />
          </View>
        );

      case 'stage':
        return (
          <View style={styles.list}>
            {options.map((s) => (
              <Row
                key={s.value}
                label={s.label}
                color={s.color}
                on={single?.stage_id === s.value}
                disabled={saving}
                onPress={() => applyPatch({ stage_id: s.value })}
              />
            ))}
            <Text style={styles.hint}>Admitted and Lost are set from the lead page.</Text>
          </View>
        );

      case 'assign':
        return (
          <View style={styles.list}>
            {options.map((u) => (
              <Row
                key={u.value}
                label={u.label}
                on={single?.assigned_to === u.value}
                disabled={saving}
                onPress={() => applyPatch({ assigned_to: u.value })}
              />
            ))}
            <Row
              label="Unassigned"
              color={colors.textMuted}
              on={!!single && !single.assigned_to}
              disabled={saving}
              onPress={() => applyPatch({ assigned_to: null })}
            />
          </View>
        );

      case 'followup':
        return (
          <View style={styles.list}>
            {single && (
              <Text style={styles.hint}>
                Now: {single.next_follow_up_at ? formatDue(single.next_follow_up_at) : 'not set'}
              </Text>
            )}
            {presets.map((p) => (
              <Row
                key={p.key}
                label={p.label}
                sub={formatDue(p.date)}
                disabled={saving}
                onPress={() => applyFollowUp(p.date)}
              />
            ))}
            <View style={styles.pickerRow}>
              <DateTimePickerButton disabled={saving} onPick={pickFollowUpDate} />
            </View>
            <Row
              label="Remove next call"
              color={colors.danger}
              disabled={saving}
              onPress={() => applyFollowUp(null)}
            />
          </View>
        );

      case 'note':
        return (
          <View style={styles.list}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Write the note…"
              placeholderTextColor={colors.textMuted}
              style={styles.noteInput}
              multiline
              autoFocus
              maxLength={2000}
              editable={!saving}
              textAlignVertical="top"
            />
            <Text style={styles.hint}>
              Added below the {single ? "lead's" : "leads'"} notes, with today's date and your name. Old notes stay.
            </Text>
            <Button title="Save note" onPress={applyNote} loading={saving} disabled={!note.trim()} fullWidth />
          </View>
        );

      case 'tags':
        return (
          <View style={styles.list}>
            {/* New tag */}
            <View style={styles.newTagRow}>
              <TextInput
                value={newTag}
                onChangeText={setNewTag}
                placeholder="New tag name"
                placeholderTextColor={colors.textMuted}
                style={styles.newTagInput}
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={handleCreateTag}
                editable={!creatingTag}
              />
              <Pressable
                onPress={handleCreateTag}
                disabled={!newTag.trim() || creatingTag}
                style={({ pressed }) => [
                  styles.newTagBtn,
                  (!newTag.trim() || creatingTag) && styles.newTagBtnOff,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Create tag"
              >
                {creatingTag ? (
                  <ActivityIndicator color={colors.textOnPrimary} size="small" />
                ) : (
                  <Text style={styles.newTagBtnText}>+ Add</Text>
                )}
              </Pressable>
            </View>

            {!single && <Text style={styles.hint}>Tap once to add, twice to remove, three times to leave.</Text>}

            {options.length === 0 ? (
              <Text style={styles.hint}>No tags yet. Type a name above and tap + Add.</Text>
            ) : (
              <View style={styles.chips}>
                {options.map((t) => {
                  const mark = tagMarks.get(t.value);
                  const on = single ? tagSet.has(t.value) : !!mark;
                  const tint = mark === 'remove' ? colors.danger : t.color ?? colors.primary;
                  return (
                    <Pressable
                      key={t.value}
                      onPress={() => pressTag(t.value)}
                      style={[styles.chip, on && { backgroundColor: tint, borderColor: tint }]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                    >
                      {!on && <View style={[styles.dot, { backgroundColor: tint }]} />}
                      <Text style={[styles.chipText, on && styles.textOn]}>
                        {!single && mark ? `${mark === 'add' ? '+' : '−'} ` : ''}
                        {t.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <Button title="Save tags" onPress={applyTags} loading={saving} fullWidth />
          </View>
        );
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>{TITLES[field]}</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {single ? single.name : `${count} leads`}
            </Text>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {renderBody()}

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            {saving && field !== 'tags' && field !== 'note' && <ActivityIndicator color={colors.primary} />}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function BigChoice({
  label,
  color,
  on,
  disabled,
  onPress,
}: {
  label: string;
  color: string;
  on?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.big,
        { borderColor: color },
        on && { backgroundColor: color },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
    >
      <Text style={[styles.bigText, { color: on ? colors.textOnPrimary : color }]}>{label}</Text>
    </Pressable>
  );
}

function Row({
  label,
  sub,
  color,
  on,
  disabled,
  onPress,
}: {
  label: string;
  sub?: string;
  color?: string;
  on?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
    >
      {color && <View style={[styles.dot, { backgroundColor: color }]} />}
      <View style={styles.flex}>
        <Text style={[styles.rowText, color === colors.danger && { color: colors.danger }]}>{label}</Text>
        {sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      {on && <Text style={styles.tick}>✓</Text>}
    </Pressable>
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  loader: { paddingVertical: spacing.xl },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  pressed: { opacity: 0.7 },
  bigRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  big: {
    flexGrow: 1,
    minWidth: '45%',
    alignItems: 'center',
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 2,
  },
  bigText: { fontSize: fontSize.body, fontWeight: fontWeight.bold },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  rowText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowSub: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  tick: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
  pickerRow: { paddingVertical: spacing.xs },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  newTagRow: { flexDirection: 'row', gap: spacing.sm },
  newTagInput: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    fontSize: fontSize.body,
    color: colors.text,
  },
  noteInput: {
    minHeight: 110,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    fontSize: fontSize.body,
    color: colors.text,
  },
  newTagBtn: {
    minWidth: 76,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  newTagBtnOff: { opacity: 0.4 },
  newTagBtnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});