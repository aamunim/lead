import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  isValidWaNumber,
  isValidWaUsername,
  normalizeWaNumber,
  normalizeWaUsername,
} from '@/features/leads/contact';
import {
  createLead,
  findDuplicates,
  getLead,
  isValidBdMobile,
  listAssignableUsers,
  updateLead,
  type DuplicateLead,
  type LeadInput,
  type Rating,
} from '@/features/leads/api';
import { listCourses, listItems, type ListItem } from '@/features/settings/api';
import { autoAssignee } from '@/features/settings/assignment';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';
import { VoiceNoteButton } from '@/features/voice/VoiceNote';

type Option = { value: string; label: string; color?: string };

// Special values for the "Assigned to" chips
const AUTO = '__auto__';
const UNASSIGNED = '__none__';

type Form = {
  name: string;
  phone: string;
  waNumber: string;
  waUsername: string;
  altPhone: string;
  email: string;
  area: string;
  guardianName: string;
  guardianPhone: string;
  guardianRelation: string;
  sourceId: string | null;
  campaignId: string | null;
  referredBy: string;
  leadTypeId: string | null;
  stageId: string | null;
  rating: Rating | null;
  /** AUTO, UNASSIGNED, or a user id */
  assignee: string;
  notes: string;
  courseIds: string[];
  tagIds: string[];
};

const EMPTY: Form = {
  name: '',
  phone: '',
  waNumber: '',
  waUsername: '',
  altPhone: '',
  email: '',
  area: '',
  guardianName: '',
  guardianPhone: '',
  guardianRelation: '',
  sourceId: null,
  campaignId: null,
  referredBy: '',
  leadTypeId: null,
  stageId: null,
  rating: null,
  assignee: AUTO,
  notes: '',
  courseIds: [],
  tagIds: [],
};

const RATINGS: { value: Rating; label: string; color: string }[] = [
  { value: 'hot', label: 'Hot', color: colors.hot },
  { value: 'warm', label: 'Warm', color: colors.warm },
  { value: 'cold', label: 'Cold', color: colors.cold },
];

const toOptions = (items: ListItem[]): Option[] =>
  items.map((i) => ({ value: i.id, label: i.name, color: typeof i.color === 'string' ? i.color : undefined }));

export default function LeadFormScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { profile, hasPermission, assignment, assignmentOn, canAssign } = useAuth();

  const canChangeSource = hasPermission('leads.edit_all');
  const seesAllLeads = hasPermission('leads.view_all');
  const myRole = (profile as { role_key?: string | null } | null)?.role_key ?? null;

  const [form, setForm] = useState<Form>(EMPTY);
  const [originalSourceId, setOriginalSourceId] = useState<string | null>(null);
  const [originalAssignee, setOriginalAssignee] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(!isNew);

  // options
  const [sources, setSources] = useState<Option[]>([]);
  const [campaigns, setCampaigns] = useState<(Option & { sourceId: string | null })[]>([]);
  const [leadTypes, setLeadTypes] = useState<Option[]>([]);
  const [stages, setStages] = useState<Option[]>([]);
  const [tags, setTags] = useState<Option[]>([]);
  const [courses, setCourses] = useState<Option[]>([]);
  const [users, setUsers] = useState<Option[]>([]);

  const [duplicates, setDuplicates] = useState<DuplicateLead[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // --- load options (and the lead when editing) -----------------------
  const load = useCallback(async () => {
    try {
      const [src, camp, types, stg, tg, crs, ppl] = await Promise.all([
        listItems('lead_sources'),
        listItems('campaigns'),
        listItems('lead_types'),
        listItems('pipeline_stages'),
        listItems('tags'),
        listCourses(),
        canAssign
          ? listAssignableUsers(seesAllLeads ? {} : { teamLeadId: profile?.id })
          : Promise.resolve([]),
      ]);
      setSources(toOptions(src));
      setCampaigns(
        camp.map((c) => ({ value: c.id, label: c.name, sourceId: (c.source_id as string) ?? null })),
      );
      setLeadTypes(toOptions(types));
      setStages(toOptions(stg.filter((s) => s.kind === 'open')));
      setTags(toOptions(tg));
      setCourses(crs.map((c) => ({ value: c.id, label: c.name })));
      setUsers(ppl.map((p) => ({ value: p.id, label: p.full_name ?? 'No name' })));

      if (!isNew && id) {
        const lead = await getLead(id);
        if (!lead) {
          setFormError('Lead not found.');
          return;
        }
        setOriginalSourceId(lead.source_id);
        setOriginalAssignee(lead.assigned_to);
        setForm({
          name: lead.name,
          phone: lead.phone ?? '',
          waNumber: lead.whatsapp_number ?? '',
          waUsername: lead.whatsapp_username ? '@' + lead.whatsapp_username : '',
          altPhone: lead.alt_phone ?? '',
          email: lead.email ?? '',
          area: lead.area ?? '',
          guardianName: lead.guardian_name ?? '',
          guardianPhone: lead.guardian_phone ?? '',
          guardianRelation: lead.guardian_relation ?? '',
          sourceId: lead.source_id,
          campaignId: lead.campaign_id,
          referredBy: lead.referred_by ?? '',
          leadTypeId: lead.lead_type_id,
          stageId: lead.stage_id,
          rating: (lead.rating as Rating | null) ?? null,
          assignee: lead.assigned_to ?? UNASSIGNED,
          notes: lead.notes ?? '',
          courseIds: lead.lead_courses.map((c) => c.course?.id).filter(Boolean) as string[],
          tagIds: lead.lead_tags.map((t) => t.tag?.id).filter(Boolean) as string[],
        });
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not load the form.');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, canAssign, seesAllLeads, profile?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // --- duplicate check while typing the phone / WhatsApp -------------
  useEffect(() => {
    setConfirmDuplicate(false);
    const timer = setTimeout(async () => {
      try {
        setDuplicates(
          await findDuplicates(
            { phone: form.phone, whatsapp_number: form.waNumber, whatsapp_username: form.waUsername },
            isNew ? undefined : id,
          ),
        );
      } catch {
        setDuplicates([]);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [form.phone, form.waNumber, form.waUsername, id, isNew]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const toggleIn = (key: 'courseIds' | 'tagIds', value: string) =>
    set(key, form[key].includes(value) ? form[key].filter((v) => v !== value) : [...form[key], value]);

  const campaignOptions = useMemo(
    () => campaigns.filter((c) => !form.sourceId || !c.sourceId || c.sourceId === form.sourceId),
    [campaigns, form.sourceId],
  );

  const selectedSourceName = sources.find((s) => s.value === form.sourceId)?.label ?? '';
  const sourceLocked = !isNew && !!originalSourceId && !canChangeSource;

  // --- what "Auto" will do (new leads only) ---------------------------
  const auto = useMemo(
    () =>
      profile
        ? autoAssignee(assignment, { id: profile.id, role_key: myRole }, seesAllLeads)
        : { userId: null, reason: '' },
    [assignment, profile, myRole, seesAllLeads],
  );

  const nameOf = (userId: string | null) => {
    if (!userId) return 'Unassigned';
    if (userId === profile?.id) return 'you';
    return users.find((u) => u.value === userId)?.label ?? 'the chosen user';
  };

  const autoText = `Auto → ${nameOf(auto.userId)}`;

  // --- save -------------------------------------------------------------
  const handleSave = async () => {
    const found: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) found.name = 'Please enter the name.';
    const hasPhone = !!form.phone.trim();
    const hasWaNumber = !!form.waNumber.trim();
    const hasWaUsername = !!form.waUsername.trim();
    if (!hasPhone && !hasWaNumber && !hasWaUsername) {
      found.phone = 'Enter a phone number, or a WhatsApp number / username below.';
    } else if (hasPhone && !isValidBdMobile(form.phone)) {
      found.phone = 'Enter an 11-digit mobile number, e.g. 01711234567.';
    }
    if (hasWaNumber && !isValidWaNumber(form.waNumber)) {
      found.waNumber = 'Not a valid WhatsApp number. Other countries: start with +, e.g. +971501234567.';
    }
    if (hasWaUsername && !isValidWaUsername(form.waUsername)) {
      found.waUsername = '3–35 letters, numbers, “.” or “_”.';
    }
    if (form.altPhone.trim() && !isValidBdMobile(form.altPhone)) found.altPhone = 'Not a valid mobile number.';
    if (form.guardianPhone.trim() && !isValidBdMobile(form.guardianPhone)) {
      found.guardianPhone = 'Not a valid mobile number.';
    }
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      if (found.altPhone || found.guardianPhone) setShowMore(true);
      return;
    }

    if (duplicates.length > 0 && !confirmDuplicate) {
      setFormError('This number or username already belongs to another lead. Check below, or tap “Save anyway”.');
      return;
    }

    const input: LeadInput = {
      name: form.name,
      phone: form.phone,
      whatsapp_number: form.waNumber.trim() ? normalizeWaNumber(form.waNumber) : null,
      whatsapp_username: form.waUsername.trim() ? normalizeWaUsername(form.waUsername) : null,
      alt_phone: form.altPhone,
      email: form.email,
      area: form.area,
      guardian_name: form.guardianName,
      guardian_phone: form.guardianPhone,
      guardian_relation: form.guardianRelation,
      lead_type_id: form.leadTypeId,
      source_id: form.sourceId,
      campaign_id: form.campaignId,
      referred_by: form.referredBy,
      rating: form.rating,
      notes: form.notes,
      course_ids: form.courseIds,
      tag_ids: form.tagIds,
      ...(isNew ? {} : { stage_id: form.stageId }),
    };

    // Assignment
    //   New lead + Auto  → send nothing; the database applies the rules
    //   Picked by hand   → send the person (or Unassigned) as "manual"
    //   Editing          → send only if it changed
    if (canAssign && form.assignee !== AUTO) {
      const picked = form.assignee === UNASSIGNED ? null : form.assignee;
      if (isNew || picked !== originalAssignee) {
        input.assigned_to = picked;
        Object.assign(input, { assignment_method: 'manual' });
      }
    }

    setSaving(true);
    try {
      if (isNew) {
        const newId = await createLead(input);
        router.replace(`/leads/${newId}` as Href);
      } else if (id) {
        await updateLead(id, input);
        router.back();
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the lead.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: isNew ? 'New lead' : 'Edit lead' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const assigneeOptions: Option[] = [
    ...(isNew ? [{ value: AUTO, label: autoText }] : []),
    { value: UNASSIGNED, label: 'Unassigned' },
    ...users,
  ];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: isNew ? 'New lead' : 'Edit lead' }} />

      <KeyboardAwareScrollView
        bottomOffset={spacing.xl}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Basic */}
        <View style={styles.card}>
          <TextField
            label="Name"
            required
            value={form.name}
            onChangeText={(v) => set('name', v)}
            error={errors.name}
            autoCapitalize="words"
            autoFocus={isNew}
          />
          <TextField
            label="Phone"
            value={form.phone}
            onChangeText={(v) => set('phone', v)}
            error={errors.phone}
            keyboardType="phone-pad"
            placeholder="01711234567"
          />

          {/* WhatsApp: for leads with no phone, or a different WhatsApp number */}
          <View style={styles.waRow}>
            <View style={styles.flex}>
              <TextField
                label="💬 WhatsApp number"
                value={form.waNumber}
                onChangeText={(v) => set('waNumber', v)}
                error={errors.waNumber}
                keyboardType="phone-pad"
                placeholder="If not the phone"
              />
            </View>
            <View style={styles.flex}>
              <TextField
                label="💬 WhatsApp username"
                value={form.waUsername}
                onChangeText={(v) => set('waUsername', v)}
                error={errors.waUsername}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="@username"
              />
            </View>
          </View>
          <Text style={styles.hint}>Phone, WhatsApp number or WhatsApp username: at least one is needed.</Text>

          {duplicates.length > 0 && (
            <View style={styles.dupBox}>
              <Text style={styles.dupTitle}>
                ⚠️{' '}
                {duplicates.some((d) => d.matched === 'whatsapp_username')
                  ? 'This WhatsApp username is already a lead'
                  : 'This number is already a lead'}
              </Text>
              {duplicates.map((d) => (
                <View key={d.id} style={styles.dupRow}>
                  <View style={styles.flex}>
                    <Text style={styles.dupName}>{d.name}</Text>
                    <Text style={styles.dupMeta}>
                      {d.stage_name} · {d.assigned_to_name ?? 'Unassigned'}
                    </Text>
                  </View>
                  {d.can_open && (
                    <Button
                      title="Open"
                      variant="ghost"
                      onPress={() => router.push(`/leads/${d.id}` as Href)}
                    />
                  )}
                </View>
              ))}
              {!confirmDuplicate ? (
                <Button title="Save anyway" variant="secondary" onPress={() => setConfirmDuplicate(true)} />
              ) : (
                <Text style={styles.dupMeta}>OK, it will be saved as a separate lead.</Text>
              )}
            </View>
          )}

          <Field label="Source">
            <Chips
              options={sources}
              selected={form.sourceId ? [form.sourceId] : []}
              onPress={(v) => set('sourceId', form.sourceId === v ? null : v)}
              disabled={sourceLocked}
            />
            {sourceLocked && <Text style={styles.hint}>The original source cannot be changed.</Text>}
          </Field>

          {/* Who gets it (shown only to people who can't choose) */}
          {isNew && assignmentOn && !canAssign && (
            <Text style={styles.hint}>
              {auto.userId === profile?.id
                ? 'This lead will be assigned to you.'
                : 'This lead will be saved as Unassigned. An admin will give it to someone.'}
            </Text>
          )}
        </View>

        <Button
          title={showMore ? 'Hide extra details' : 'More details (course, guardian, rating…)'}
          variant="ghost"
          onPress={() => setShowMore((s) => !s)}
        />

        {showMore && (
          <>
            {/* Interest */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Interest</Text>
              <Field label="Interested courses">
                {courses.length === 0 ? (
                  <Text style={styles.hint}>No courses yet. Add them in Settings.</Text>
                ) : (
                  <Chips options={courses} selected={form.courseIds} onPress={(v) => toggleIn('courseIds', v)} />
                )}
              </Field>
              <Field label="Rating">
                <Chips
                  options={RATINGS}
                  selected={form.rating ? [form.rating] : []}
                  onPress={(v) => set('rating', form.rating === v ? null : (v as Rating))}
                />
              </Field>
              {!isNew && (
                <Field label="Stage">
                  <Chips
                    options={stages}
                    selected={form.stageId ? [form.stageId] : []}
                    onPress={(v) => set('stageId', v)}
                  />
                  <Text style={styles.hint}>Admitted and Lost are set from the lead page.</Text>
                </Field>
              )}
            </View>

            {/* Contact */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Contact</Text>
              <TextField
                label="Alternative phone"
                value={form.altPhone}
                onChangeText={(v) => set('altPhone', v)}
                error={errors.altPhone}
                keyboardType="phone-pad"
              />
              <TextField
                label="Email"
                value={form.email}
                onChangeText={(v) => set('email', v)}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <TextField label="Area / thana" value={form.area} onChangeText={(v) => set('area', v)} />
            </View>

            {/* Guardian */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Guardian</Text>
              <TextField
                label="Guardian name"
                value={form.guardianName}
                onChangeText={(v) => set('guardianName', v)}
                autoCapitalize="words"
              />
              <TextField
                label="Guardian phone"
                value={form.guardianPhone}
                onChangeText={(v) => set('guardianPhone', v)}
                error={errors.guardianPhone}
                keyboardType="phone-pad"
              />
              <TextField
                label="Relation"
                value={form.guardianRelation}
                onChangeText={(v) => set('guardianRelation', v)}
                placeholder="e.g. Father"
              />
            </View>

            {/* More */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>More</Text>
              {campaignOptions.length > 0 && (
                <Field label="Campaign">
                  <Chips
                    options={campaignOptions}
                    selected={form.campaignId ? [form.campaignId] : []}
                    onPress={(v) => set('campaignId', form.campaignId === v ? null : v)}
                  />
                </Field>
              )}
              {selectedSourceName.toLowerCase().includes('referral') && (
                <TextField
                  label="Referred by"
                  value={form.referredBy}
                  onChangeText={(v) => set('referredBy', v)}
                  placeholder="Name of the student or agent"
                />
              )}
              <Field label="Lead type">
                <Chips
                  options={leadTypes}
                  selected={form.leadTypeId ? [form.leadTypeId] : []}
                  onPress={(v) => set('leadTypeId', form.leadTypeId === v ? null : v)}
                />
              </Field>
              <Field label="Tags">
                <Chips options={tags} selected={form.tagIds} onPress={(v) => toggleIn('tagIds', v)} />
              </Field>
              {canAssign && (
                <Field label="Assigned to">
                  <Chips
                    options={assigneeOptions}
                    selected={[form.assignee]}
                    onPress={(v) => set('assignee', v)}
                  />
                  {isNew && form.assignee === AUTO && auto.reason !== '' && (
                    <Text style={styles.hint}>{auto.reason}. Pick a person to choose by hand.</Text>
                  )}
                </Field>
              )}
              <TextField label="Notes" value={form.notes} onChangeText={(v) => set('notes', v)} multiline />
              {!isNew && <VoiceNoteButton leadId={id} context="lead" />}
            </View>
          </>
        )}

        {formError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{formError}</Text>
          </View>
        )}

        <Button title={isNew ? 'Save lead' : 'Save changes'} onPress={handleSave} loading={saving} fullWidth />
      </KeyboardAwareScrollView>
    </View>
  );
}

// =====================================================================
// Small helpers
// =====================================================================
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Chips({
  options,
  selected,
  onPress,
  disabled,
}: {
  options: Option[];
  selected: string[];
  onPress: (value: string) => void;
  disabled?: boolean;
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
            disabled={disabled}
            style={[
              styles.chip,
              on && { backgroundColor: tint, borderColor: tint },
              disabled && !on && styles.chipDisabled,
            ]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled }}
          >
            {o.color && !on && <View style={[styles.chipDot, { backgroundColor: o.color }]} />}
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  card: {
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  waRow: { flexDirection: 'row', gap: spacing.sm },
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
  chipDisabled: { opacity: 0.4 },
  chipDot: { width: 8, height: 8, borderRadius: radius.pill },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  dupBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
  },
  dupTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.warning },
  dupRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dupName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  dupMeta: { fontSize: fontSize.caption, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});