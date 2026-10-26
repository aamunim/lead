import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers } from '@/features/leads/api';
import {
  ADMITTED_OPTIONS,
  CREATED_OPTIONS,
  FILTER_FIELDS,
  FOLLOW_UP_OPTIONS,
  LAST_CONTACTED_OPTIONS,
  NONE,
  PAPERS_OPTIONS,
  VISIT_OPTIONS,
  cleanFilters,
  countActiveFilters,
  createSavedFilter,
  getFilterConfig,
  type FilterKey,
  type LeadFilters,
  type SavedFilter,
} from '@/features/leads/filters';
import { listCourses, listItems } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

type Option = { value: string; label: string; color?: string };

type Options = {
  stages: Option[];
  tags: Option[];
  users: Option[];
  sources: Option[];
  campaigns: Option[];
  courses: Option[];
  leadTypes: Option[];
  lostReasons: Option[];
};

const EMPTY_OPTIONS: Options = {
  stages: [],
  tags: [],
  users: [],
  sources: [],
  campaigns: [],
  courses: [],
  leadTypes: [],
  lostReasons: [],
};

const RATING_OPTIONS: Option[] = [
  { value: 'hot', label: 'Hot', color: colors.hot },
  { value: 'warm', label: 'Warm', color: colors.warm },
  { value: 'cold', label: 'Cold', color: colors.cold },
  { value: NONE, label: 'No rating', color: colors.textMuted },
];

// Which part of LeadFilters each list field uses
const LIST_KEYS: Partial<Record<FilterKey, keyof LeadFilters>> = {
  rating: 'ratings',
  stage: 'stageIds',
  tags: 'tagIds',
  assigned: 'assigned',
  source: 'sourceIds',
  campaign: 'campaignIds',
  course: 'courseIds',
  lead_type: 'leadTypeIds',
  lost_reason: 'lostReasonIds',
};

type Props = {
  visible: boolean;
  value: LeadFilters;
  onClose: () => void;
  onApply: (filters: LeadFilters) => void;
  /** Called after a filter is saved, so the list can show it */
  onSavedFilter?: (filter: SavedFilter) => void;
};

export function LeadFilterSheet({ visible, value, onClose, onApply, onSavedFilter }: Props) {
  const insets = useSafeAreaInsets();
  const { profile, hasPermission, assignmentOn, sharedMode } = useAuth();
  // Everyone they could filter by: all users (admins, or everyone-sees-all), else own team
  const seesAllPeople = sharedMode || hasPermission('leads.view_all');
  const seesOthers = seesAllPeople || hasPermission('leads.view_team');
  const showAssigned = assignmentOn && seesOthers;
  const isAdmin = hasPermission('settings.manage');

  const [draft, setDraft] = useState<LeadFilters>(value);
  const [fields, setFields] = useState<FilterKey[]>([]);
  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Save as a named filter
  const [saving, setSaving] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [share, setShare] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Start from the current filters each time it opens
  useEffect(() => {
    if (!visible) return;
    setDraft(value);
    setShowSave(false);
    setSaveName('');
    setShare(false);
    setSavedMsg(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Load the field list and all the choices once per opening
  useEffect(() => {
    if (!visible) return;
    setLoading(true);

    const toOpts = (items: { id: string; name: string; color?: unknown }[]): Option[] =>
      items.map((i) => ({ value: i.id, label: i.name, color: typeof i.color === 'string' ? i.color : undefined }));

    Promise.all([
      getFilterConfig(),
      listItems('pipeline_stages', { includeInactive: true }),
      listItems('tags'),
      showAssigned
        ? listAssignableUsers(seesAllPeople ? {} : { teamLeadId: profile?.id })
        : Promise.resolve([]),
      listItems('lead_sources'),
      listItems('campaigns'),
      listCourses(),
      listItems('lead_types'),
      listItems('lost_reasons', { includeInactive: true }),
    ])
      .then(([config, stages, tags, users, sources, campaigns, courses, leadTypes, lostReasons]) => {
        setFields(
          config.fields
            .filter((f) => f.enabled)
            .map((f) => f.key)
            // "Assigned to" only while assignment is on, and only for people who see others' leads
            .filter((k) => k !== 'assigned' || showAssigned),
        );
        setOptions({
          // Switched-off stages hold no leads (e.g. the old "Campus visit")
          stages: toOpts(stages.filter((s) => s.is_active !== false)),
          tags: toOpts(tags),
          users: [
            ...users.map((u) => ({ value: u.id, label: u.full_name ?? 'No name' })),
            { value: NONE, label: 'Unassigned', color: colors.textMuted },
          ],
          sources: toOpts(sources),
          campaigns: toOpts(campaigns),
          courses: courses.map((c) => ({ value: c.id, label: c.name })),
          leadTypes: toOpts(leadTypes),
          lostReasons: toOpts(lostReasons),
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the filters.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // --- changing the draft ---------------------------------------------
  const toggleInList = (key: keyof LeadFilters, v: string) => {
    setDraft((d) => {
      const now = (d[key] as string[] | undefined) ?? [];
      const next = now.includes(v) ? now.filter((x) => x !== v) : [...now, v];
      return { ...d, [key]: next };
    });
  };

  const setSingle = <K extends 'followUp' | 'created' | 'lastContacted' | 'admitted' | 'papers' | 'visit'>(
    key: K,
    v: LeadFilters[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: d[key] === v ? undefined : v }));
  };

  const clearField = (key: FilterKey) => {
    setDraft((d) => {
      const next = { ...d };
      const listKey = LIST_KEYS[key];
      if (listKey) delete next[listKey];
      if (key === 'follow_up') delete next.followUp;
      if (key === 'created') delete next.created;
      if (key === 'last_contacted') delete next.lastContacted;
      if (key === 'admitted') delete next.admitted;
      if (key === 'papers') delete next.papers;
      if (key === 'visit') delete next.visit;
      return next;
    });
  };

  const fieldHasValue = (key: FilterKey): boolean => {
    const listKey = LIST_KEYS[key];
    if (listKey) return ((draft[listKey] as string[] | undefined) ?? []).length > 0;
    if (key === 'follow_up') return !!draft.followUp;
    if (key === 'created') return !!draft.created;
    if (key === 'last_contacted') return !!draft.lastContacted;
    if (key === 'admitted') return !!draft.admitted;
    if (key === 'papers') return !!draft.papers;
    if (key === 'visit') return !!draft.visit;
    return false;
  };

  // Without "Assigned to" on screen, don't keep (or count) an old value for it
  const visibleDraft = (): LeadFilters => {
    if (showAssigned || !draft.assigned) return draft;
    const { assigned, ...rest } = draft; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  };

  const active = countActiveFilters(visibleDraft());

  // --- save as named filter --------------------------------------------
  const handleSave = async () => {
    if (!saveName.trim()) {
      setError('Please give the filter a name.');
      return;
    }
    if (active === 0) {
      setError('Choose at least one filter before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createSavedFilter(saveName, visibleDraft(), isAdmin && share);
      onSavedFilter?.(created);
      setShowSave(false);
      setSaveName('');
      setSavedMsg(`Saved as “${created.name}”.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the filter.');
    } finally {
      setSaving(false);
    }
  };

  // --- one section -------------------------------------------------------
  const renderField = (key: FilterKey) => {
    const meta = FILTER_FIELDS[key];
    let body: React.ReactNode = null;

    const listChips = (opts: Option[], listKey: keyof LeadFilters, emptyText: string) =>
      opts.length === 0 ? (
        <Text style={styles.hint}>{emptyText}</Text>
      ) : (
        <View style={styles.chips}>
          {opts.map((o) => (
            <Chip
              key={o.value}
              label={o.label}
              color={o.color}
              on={((draft[listKey] as string[] | undefined) ?? []).includes(o.value)}
              onPress={() => toggleInList(listKey, o.value)}
            />
          ))}
        </View>
      );

    switch (key) {
      case 'follow_up':
        body = (
          <View style={styles.chips}>
            {FOLLOW_UP_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                color={o.value === 'overdue' ? colors.danger : undefined}
                on={draft.followUp === o.value}
                onPress={() => setSingle('followUp', o.value)}
              />
            ))}
          </View>
        );
        break;
      case 'rating':
        body = listChips(RATING_OPTIONS, 'ratings', '');
        break;
      case 'stage':
        body = listChips(options.stages, 'stageIds', 'No stages.');
        break;
      case 'tags':
        body = listChips(options.tags, 'tagIds', 'No tags yet.');
        break;
      case 'assigned':
        body = listChips(options.users, 'assigned', 'No users.');
        break;
      case 'source':
        body = listChips(options.sources, 'sourceIds', 'No sources yet.');
        break;
      case 'campaign':
        body = listChips(options.campaigns, 'campaignIds', 'No campaigns yet.');
        break;
      case 'course':
        body = listChips(options.courses, 'courseIds', 'No courses yet.');
        break;
      case 'lead_type':
        body = listChips(options.leadTypes, 'leadTypeIds', 'No lead types yet.');
        break;
      case 'created':
        body = (
          <View style={styles.chips}>
            {CREATED_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                on={draft.created === o.value}
                onPress={() => setSingle('created', o.value)}
              />
            ))}
          </View>
        );
        break;
      case 'last_contacted':
        body = (
          <View style={styles.chips}>
            {LAST_CONTACTED_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                on={draft.lastContacted === o.value}
                onPress={() => setSingle('lastContacted', o.value)}
              />
            ))}
          </View>
        );
        break;
      case 'admitted':
        body = (
          <View style={styles.chips}>
            {ADMITTED_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                color={colors.success}
                on={draft.admitted === o.value}
                onPress={() => setSingle('admitted', o.value)}
              />
            ))}
          </View>
        );
        break;
      case 'lost_reason':
        body = listChips(options.lostReasons, 'lostReasonIds', 'No lost reasons yet.');
        break;
      case 'papers':
        body = (
          <>
            <View style={styles.chips}>
              {PAPERS_OPTIONS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  color={o.value === 'complete' ? colors.success : o.value === 'missing' ? colors.warning : undefined}
                  on={draft.papers === o.value}
                  onPress={() => setSingle('papers', o.value)}
                />
              ))}
            </View>
            <Text style={styles.hint}>Open leads and admitted students (lost and cancelled left out).</Text>
          </>
        );
        break;
      case 'visit':
        body = (
          <View style={styles.chips}>
            {VISIT_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                color={o.value === 'visited' ? colors.success : o.value === 'overdue' ? colors.danger : undefined}
                on={draft.visit === o.value}
                onPress={() => setSingle('visit', o.value)}
              />
            ))}
          </View>
        );
        break;
    }

    return (
      <View key={key} style={styles.section}>
        <View style={styles.sectionHeader}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Ionicons name={meta.icon as any} size={16} color={colors.textMuted} />
          <Text style={styles.sectionTitle}>{meta.label}</Text>
          {fieldHasValue(key) && (
            <Pressable onPress={() => clearField(key)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.clearOne}>Clear</Text>
            </Pressable>
          )}
        </View>
        {body}
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header: starts below the phone's status bar */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.title}>Filter leads</Text>
          <Pressable
            onPress={() => setDraft({})}
            disabled={active === 0}
            hitSlop={10}
            accessibilityRole="button"
          >
            <Text style={[styles.clearAll, active === 0 && styles.disabledText]}>Clear all</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {fields.map(renderField)}

            {/* Save as a named filter */}
            <View style={styles.saveBox}>
              {showSave ? (
                <>
                  <Text style={styles.sectionTitle}>Save this filter</Text>
                  <TextInput
                    value={saveName}
                    onChangeText={setSaveName}
                    placeholder="e.g. My hot leads"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    maxLength={40}
                    autoFocus
                  />
                  {isAdmin && (
                    <View style={styles.shareRow}>
                      <View style={styles.flex}>
                        <Text style={styles.shareTitle}>Share with everyone</Text>
                        <Text style={styles.hint}>All users will see this filter.</Text>
                      </View>
                      <Switch value={share} onValueChange={setShare} />
                    </View>
                  )}
                  <View style={styles.row}>
                    <Pressable onPress={() => setShowSave(false)} style={[styles.btn, styles.btnGhost]}>
                      <Text style={styles.btnGhostText}>Cancel</Text>
                    </Pressable>
                    <Pressable onPress={handleSave} disabled={saving} style={[styles.btn, styles.btnPrimary]}>
                      {saving ? (
                        <ActivityIndicator color={colors.textOnPrimary} size="small" />
                      ) : (
                        <Text style={styles.btnPrimaryText}>Save</Text>
                      )}
                    </Pressable>
                  </View>
                </>
              ) : (
                <Pressable
                  onPress={() => setShowSave(true)}
                  disabled={active === 0}
                  style={styles.saveLink}
                  accessibilityRole="button"
                >
                  <Ionicons name="bookmark-outline" size={18} color={active === 0 ? colors.textMuted : colors.primary} />
                  <Text style={[styles.saveLinkText, active === 0 && styles.disabledText]}>
                    Save this filter for later
                  </Text>
                </Pressable>
              )}
              {savedMsg && <Text style={styles.savedMsg}>✓ {savedMsg}</Text>}
            </View>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>
        )}

        {/* Footer: stays above the phone's navigation bar */}
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Pressable
            onPress={() => onApply(cleanFilters(visibleDraft()))}
            style={({ pressed }) => [styles.apply, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.applyText}>
              {active > 0 ? `Show results (${active} filter${active > 1 ? 's' : ''})` : 'Show all leads'}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// =====================================================================
// Chip
// =====================================================================
function Chip({
  label,
  on,
  color,
  onPress,
}: {
  label: string;
  on: boolean;
  color?: string;
  onPress: () => void;
}) {
  const tint = color ?? colors.primary;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && { backgroundColor: tint, borderColor: tint }]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
    >
      {color && !on && <View style={[styles.dot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  clearAll: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },
  disabledText: { color: colors.textMuted },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  section: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTitle: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  clearOne: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dot: { width: 8, height: 8, borderRadius: radius.pill },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  saveBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  saveLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  saveLinkText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  savedMsg: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.success },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: fontSize.body,
    color: colors.text,
  },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  shareTitle: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  row: { flexDirection: 'row', gap: spacing.sm },
  btn: { flex: 1, minHeight: 42, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border },
  btnGhostText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  apply: {
    minHeight: 50,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  applyText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  pressed: { opacity: 0.85 },
});