import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Linking,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    askContactsPermission,
    canImportContacts,
    findExistingLeadPhones,
    getContactsPermission,
    loadPhoneContacts,
    saveContactsAsLeads,
    undoContactsSave,
    type PhoneContact,
    type SaveContactResult,
} from '@/features/contacts/api';
import { listAssignableUsers, normalizePhone } from '@/features/leads/api';
import { listCourses, listItems } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

type Option = { value: string; label: string; color?: string };

type Stage =
  | 'checking'     // checking access + permission
  | 'no_access'    // admin hasn't allowed this user
  | 'ask'          // phone permission not given yet
  | 'blocked'      // phone permission denied for good
  | 'loading'      // reading contacts
  | 'ready';

const ROW_HEIGHT = 64;
const AUTO = '__auto__';
const UNASSIGNED = '__none__';

const RATINGS: Option[] = [
  { value: 'hot', label: 'Hot', color: colors.hot },
  { value: 'warm', label: 'Warm', color: colors.warm },
  { value: 'cold', label: 'Cold', color: colors.cold },
];

export default function PhoneContactsScreen() {
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<Stage>('checking');
  const [error, setError] = useState<string | null>(null);

  const [contacts, setContacts] = useState<PhoneContact[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set()); // numbers already leads
  const [chosenIndex, setChosenIndex] = useState<Record<string, number>>({}); // contact id → number index
  const [selected, setSelected] = useState<Set<string>>(new Set()); // contact ids
  const [search, setSearch] = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [result, setResult] = useState<SaveContactResult | null>(null);
  const [undoing, setUndoing] = useState(false);

  // --- read the contacts and mark the ones that are already leads --------
  const loadContacts = useCallback(async () => {
    setStage('loading');
    setError(null);
    try {
      const list = await loadPhoneContacts();
      setContacts(list);
      const phones = list.flatMap((c) => c.numbers.filter((n) => n.valid).map((n) => n.normalized));
      setExisting(await findExistingLeadPhones(phones));
      setStage('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your contacts.');
      setStage('ready');
    }
  }, []);

  // --- on open: admin access, then the phone's permission ----------------
  useEffect(() => {
    (async () => {
      if (!(await canImportContacts())) {
        setStage('no_access');
        return;
      }
      const perm = await getContactsPermission();
      if (perm.status === 'granted') loadContacts();
      else if (perm.status === 'denied' && !perm.canAskAgain) setStage('blocked');
      else setStage('ask');
    })();
  }, [loadContacts]);

  const allow = async () => {
    const perm = await askContactsPermission();
    if (perm.status === 'granted') loadContacts();
    else setStage(perm.canAskAgain ? 'ask' : 'blocked');
  };

  // --- per-contact helpers ------------------------------------------------
  const validNumbers = (c: PhoneContact) => c.numbers.filter((n) => n.valid);

  const chosenNumber = (c: PhoneContact) => {
    const valid = validNumbers(c);
    if (valid.length === 0) return null;
    return valid[(chosenIndex[c.id] ?? 0) % valid.length];
  };

  type RowState = 'ok' | 'existing' | 'invalid';
  const rowState = (c: PhoneContact): RowState => {
    const n = chosenNumber(c);
    if (!n) return 'invalid';
    if (existing.has(n.normalized)) return 'existing';
    return 'ok';
  };

  const nextNumber = (c: PhoneContact) => {
    setChosenIndex((m) => ({ ...m, [c.id]: (m[c.id] ?? 0) + 1 }));
    setSelected((s) => {
      // the new number may already be a lead; drop the mark to be safe
      const next = new Set(s);
      next.delete(c.id);
      return next;
    });
  };

  // --- search -------------------------------------------------------------
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    const digits = normalizePhone(q);
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (digits.length >= 3 && c.numbers.some((n) => n.normalized.includes(digits))),
    );
  }, [contacts, search]);

  const selectable = visible.filter((c) => rowState(c) === 'ok');
  const allVisibleMarked = selectable.length > 0 && selectable.every((c) => selected.has(c.id));

  const toggle = (c: PhoneContact) => {
    if (rowState(c) !== 'ok') return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  };

  const markAllVisible = () => {
    setSelected((s) => {
      const next = new Set(s);
      if (allVisibleMarked) selectable.forEach((c) => next.delete(c.id));
      else selectable.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const markedRows = contacts
    .filter((c) => selected.has(c.id))
    .map((c) => ({ name: c.name, phone: chosenNumber(c)?.normalized ?? '' }))
    .filter((r) => r.phone);

  const counts = useMemo(() => {
    let ok = 0;
    let ex = 0;
    let bad = 0;
    for (const c of contacts) {
      const s = rowState(c);
      if (s === 'ok') ok++;
      else if (s === 'existing') ex++;
      else bad++;
    }
    return { ok, ex, bad };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, existing, chosenIndex]);

  // --- after saving ---------------------------------------------------------
  const onSaved = (r: SaveContactResult) => {
    setSheetOpen(false);
    setResult(r);
    // Mark the saved numbers as leads now, without reloading
    setExisting((s) => {
      const next = new Set(s);
      markedRows.forEach((row) => next.add(row.phone));
      return next;
    });
    setSelected(new Set());
  };

  const undo = async () => {
    if (!result) return;
    setUndoing(true);
    try {
      await undoContactsSave(result.createdIds);
      setResult(null);
      await loadContacts(); // refresh the "already a lead" marks
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo.');
    } finally {
      setUndoing(false);
    }
  };

  // --- screens before the list ------------------------------------------
  if (stage === 'checking' || stage === 'loading') {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Phone contacts' }} />
        <ActivityIndicator size="large" color={colors.primary} />
        {stage === 'loading' && <Text style={styles.muted}>Reading your contacts…</Text>}
      </View>
    );
  }

  if (stage === 'no_access') {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Phone contacts' }} />
        <Ionicons name="lock-closed" size={40} color={colors.textMuted} />
        <Text style={styles.bigTitle}>Not available for you</Text>
        <Text style={styles.centerText}>An admin can turn this on for you in Settings → Phone contacts access.</Text>
      </View>
    );
  }

  if (stage === 'ask' || stage === 'blocked') {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Phone contacts' }} />
        <View style={styles.bigIcon}>
          <Ionicons name="people" size={40} color={colors.primary} />
        </View>
        <Text style={styles.bigTitle}>Add leads from your contacts</Text>
        <Text style={styles.centerText}>
          Pick people from your phone’s contact list and save them as leads in one go. Only the contacts you mark are
          saved. Nothing else leaves your phone.
        </Text>
        {stage === 'ask' ? (
          <Button title="Allow access to contacts" onPress={allow} fullWidth />
        ) : (
          <>
            <Text style={styles.warn}>Contacts permission is turned off for this app.</Text>
            <Button title="Open phone settings" onPress={() => Linking.openSettings()} fullWidth />
          </>
        )}
      </View>
    );
  }

  // --- the list -------------------------------------------------------------
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Phone contacts' }} />

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or number"
            placeholderTextColor={colors.textMuted}
            style={styles.search}
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
        <Pressable onPress={loadContacts} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Reload">
          <Ionicons name="refresh" size={20} color={colors.text} />
        </Pressable>
      </View>

      {/* Counts + mark all */}
      <View style={styles.infoRow}>
        <Text style={styles.infoText}>
          {contacts.length} contacts · {counts.ex} already leads
          {counts.bad > 0 ? ` · ${counts.bad} not mobile` : ''}
        </Text>
        {selectable.length > 0 && (
          <Pressable onPress={markAllVisible} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>
              {allVisibleMarked ? 'Unmark all' : `Mark all ${selectable.length}`}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Saved message with Undo */}
      {result && (
        <View style={styles.resultBox}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <View style={styles.flex}>
            <Text style={styles.resultTitle}>
              {result.created} {result.created === 1 ? 'lead' : 'leads'} saved
            </Text>
            {(result.alreadyLeads > 0 || result.invalid > 0) && (
              <Text style={styles.resultText}>
                {[
                  result.alreadyLeads > 0 ? `${result.alreadyLeads} already leads` : null,
                  result.invalid > 0 ? `${result.invalid} invalid numbers` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}{' '}
                skipped
              </Text>
            )}
          </View>
          {result.created > 0 && (
            <Pressable onPress={undo} disabled={undoing} hitSlop={8} accessibilityRole="button">
              {undoing ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.link}>Undo</Text>}
            </Pressable>
          )}
          <Pressable onPress={() => router.push('/leads' as Href)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>View</Text>
          </Pressable>
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        data={visible}
        keyExtractor={(c) => c.id}
        extraData={[selected, existing, chosenIndex]}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        initialNumToRender={20}
        windowSize={10}
        contentContainerStyle={{ paddingBottom: 110 + insets.bottom }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.muted}>{search ? 'No contact matches.' : 'No contacts with phone numbers.'}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const state = rowState(item);
          const on = selected.has(item.id);
          const n = chosenNumber(item);
          const moreNumbers = validNumbers(item).length - 1;
          return (
            <Pressable
              onPress={() => toggle(item)}
              disabled={state !== 'ok'}
              style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.pressed]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: state !== 'ok' }}
              accessibilityLabel={`${item.name}${state === 'existing' ? ', already a lead' : ''}`}
            >
              <View style={[styles.check, on && styles.checkOn, state !== 'ok' && styles.checkOff]}>
                {on && <Ionicons name="checkmark" size={16} color={colors.textOnPrimary} />}
              </View>

              <View style={styles.flex}>
                <Text style={[styles.name, state !== 'ok' && styles.greyText]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[styles.number, state !== 'ok' && styles.greyText]} numberOfLines={1}>
                  {n ? n.normalized : item.numbers[0]?.raw}
                  {state === 'existing' ? '  ·  Already a lead' : ''}
                  {state === 'invalid' ? '  ·  Not a mobile number' : ''}
                </Text>
              </View>

              {moreNumbers > 0 && (
                <Pressable
                  onPress={() => nextNumber(item)}
                  hitSlop={8}
                  style={styles.moreBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Use another number"
                >
                  <Text style={styles.moreText}>+{moreNumbers} ⇄</Text>
                </Pressable>
              )}
            </Pressable>
          );
        }}
      />

      {/* Save bar */}
      {selected.size > 0 && (
        <View style={[styles.saveBar, { paddingBottom: insets.bottom + spacing.md }]}>
          <Button title={`Save ${selected.size} as leads`} onPress={() => setSheetOpen(true)} fullWidth />
        </View>
      )}

      <SaveSheet
        visible={sheetOpen}
        rows={markedRows}
        onClose={() => setSheetOpen(false)}
        onSaved={onSaved}
      />
    </View>
  );
}

// =====================================================================
// Save sheet: source, rating, tags, courses, assignment
// =====================================================================
function SaveSheet({
  visible,
  rows,
  onClose,
  onSaved,
}: {
  visible: boolean;
  rows: { name: string; phone: string }[];
  onClose: () => void;
  onSaved: (r: SaveContactResult) => void;
}) {
  const insets = useSafeAreaInsets();
  const { profile, hasPermission, canAssign } = useAuth();
  const seesAll = hasPermission('leads.view_all');

  const [sources, setSources] = useState<Option[]>([]);
  const [tags, setTags] = useState<Option[]>([]);
  const [courses, setCourses] = useState<Option[]>([]);
  const [users, setUsers] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [rating, setRating] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string>(AUTO);

  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setProgress(null);
    setLoading(true);
    Promise.all([
      listItems('lead_sources'),
      listItems('tags'),
      listCourses(),
      canAssign ? listAssignableUsers(seesAll ? {} : { teamLeadId: profile?.id }) : Promise.resolve([]),
    ])
      .then(([src, tg, crs, ppl]) => {
        const srcOpts = src.map((s) => ({ value: s.id, label: s.name }));
        setSources(srcOpts);
        // Default source: "Phone contact"
        setSourceId(
          (current) => current ?? srcOpts.find((s) => s.label.toLowerCase() === 'phone contact')?.value ?? null,
        );
        setTags(tg.map((t) => ({ value: t.id, label: t.name, color: t.color as string })));
        setCourses(crs.map((c) => ({ value: c.id, label: c.name })));
        setUsers(ppl.map((p) => ({ value: p.id, label: p.full_name ?? 'No name' })));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the options.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const toggleIn = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await saveContactsAsLeads(
        rows,
        {
          sourceId,
          rating,
          tagIds,
          courseIds,
          assignManual: canAssign && assignee !== AUTO,
          assignedTo: assignee === AUTO || assignee === UNASSIGNED ? null : assignee,
        },
        (done, total) => setProgress(`${done} / ${total}`),
      );
      onSaved(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Save {rows.length} as leads</Text>
            <Text style={styles.muted}>These details go on every lead. You can change them later.</Text>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : (
            <ScrollView contentContainerStyle={styles.sheetContent}>
              <Field label="Source">
                <ChipRow options={sources} selected={sourceId ? [sourceId] : []} onPress={(v) => setSourceId(sourceId === v ? null : v)} />
              </Field>

              <Field label="Rating">
                <ChipRow options={RATINGS} selected={rating ? [rating] : []} onPress={(v) => setRating(rating === v ? null : v)} />
              </Field>

              {tags.length > 0 && (
                <Field label="Tags">
                  <ChipRow options={tags} selected={tagIds} onPress={(v) => toggleIn(tagIds, setTagIds, v)} />
                </Field>
              )}

              {courses.length > 0 && (
                <Field label="Interested courses">
                  <ChipRow options={courses} selected={courseIds} onPress={(v) => toggleIn(courseIds, setCourseIds, v)} />
                </Field>
              )}

              {canAssign && (
                <Field label="Assigned to">
                  <ChipRow
                    options={[
                      { value: AUTO, label: 'Auto (assignment rules)' },
                      { value: UNASSIGNED, label: 'Unassigned' },
                      ...users,
                    ]}
                    selected={[assignee]}
                    onPress={setAssignee}
                  />
                </Field>
              )}

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Button
                title={saving ? `Saving… ${progress ?? ''}` : `Save ${rows.length} leads`}
                onPress={save}
                loading={saving && !progress}
                disabled={saving}
                fullWidth
              />
              <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function ChipRow({
  options,
  selected,
  onPress,
}: {
  options: Option[];
  selected: string[];
  onPress: (v: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        const tint = o.color ?? colors.primary;
        return (
          <Pressable
            key={o.value}
            onPress={() => onPress(o.value)}
            style={[styles.chip, on && { backgroundColor: tint, borderColor: tint }]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
          >
            {o.color && !on && <View style={[styles.dot, { backgroundColor: o.color }]} />}
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  bigIcon: {
    width: 80,
    height: 80,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  bigTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  centerText: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
  warn: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning, textAlign: 'center' },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  pressed: { opacity: 0.7 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },

  searchRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  search: { flex: 1, fontSize: fontSize.body, color: colors.text, paddingVertical: 0 },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  infoText: { flex: 1, fontSize: fontSize.caption, color: colors.textMuted },

  resultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  resultTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  resultText: { fontSize: fontSize.caption, color: colors.textMuted },

  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowOn: { backgroundColor: colors.primarySoft },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkOff: { backgroundColor: colors.background, borderStyle: 'dashed' },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  number: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  greyText: { color: colors.textMuted, opacity: 0.6 },
  moreBtn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
  },
  moreText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl },

  saveBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  errorBox: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  // Sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '85%',
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
  sheetHeader: {
    gap: 2,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sheetContent: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
  loader: { paddingVertical: spacing.xxl },
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
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
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
});