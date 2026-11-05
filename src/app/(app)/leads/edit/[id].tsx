import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { isValidWaNumber, isValidWaUsername, normalizeWaNumber, normalizeWaUsername } from '@/features/leads/contact';
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
import { isWeb } from '@/features/web/api';
import { MIcon, type MIconName } from '@/features/home/md';
import { readSaved, writeSaved } from '@/shared/lib/saved';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';
import { VoiceNoteButton } from '@/features/voice/VoiceNote';
import { PickNumberButtons } from '@/features/leads/PickNumber';

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
  { value: 'hot', label: '🔥 Hot', color: colors.hot },
  { value: 'warm', label: '☀️ Warm', color: colors.warm },
  { value: 'cold', label: '❄️ Cold', color: colors.cold },
];

/** 💾 Last source and courses, for the next new lead */
const LAST_KEY = 'leadform:last';
type Last = { sourceId: string | null; courseIds: string[] };

type Section = 'contact' | 'guardian' | 'more';

const toOptions = (items: ListItem[]): Option[] =>
  items.map((i) => ({ value: i.id, label: i.name, color: typeof i.color === 'string' ? i.color : undefined }));

export default function LeadFormScreen() {
  // phone = from the caller card's "➕ Add as lead" (an unknown number calling)
  const { id, phone: phoneParam } = useLocalSearchParams<{ id: string; phone?: string }>();
  const isNew = id === 'new';
  const { profile, hasPermission, assignment, assignmentOn, canAssign } = useAuth();

  const canChangeSource = hasPermission('leads.edit_all');
  const seesAllLeads = hasPermission('leads.view_all');
  const myRole = (profile as { role_key?: string | null } | null)?.role_key ?? null;

  const [form, setForm] = useState<Form>(() =>
    isNew && typeof phoneParam === 'string' && phoneParam ? { ...EMPTY, phone: phoneParam } : EMPTY,
  );
  const [originalSourceId, setOriginalSourceId] = useState<string | null>(null);
  const [originalAssignee, setOriginalAssignee] = useState<string | null>(null);
  // 💬 WhatsApp on the phone number (the two WhatsApp boxes stay hidden)
  const [waSame, setWaSame] = useState(true);
  const [openSec, setOpenSec] = useState<Record<Section, boolean>>({ contact: false, guardian: false, more: false });
  const [addedCount, setAddedCount] = useState(0);
  const [formKey, setFormKey] = useState(0);
  const lastRef = useRef<Last | null>(null);
  const { width } = useWindowDimensions();
  const wide = isWeb && width >= 980;
  const insets = useSafeAreaInsets();

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
        canAssign ? listAssignableUsers(seesAllLeads ? {} : { teamLeadId: profile?.id }) : Promise.resolve([]),
      ]);
      setSources(toOptions(src));
      setCampaigns(camp.map((c) => ({ value: c.id, label: c.name, sourceId: (c.source_id as string) ?? null })));
      setLeadTypes(toOptions(types));
      setStages(toOptions(stg.filter((s) => s.kind === 'open')));
      setTags(toOptions(tg));
      const courseOpts = crs.map((c) => ({ value: c.id, label: c.name }));
      setCourses(courseOpts);
      setUsers(ppl.map((p) => ({ value: p.id, label: p.full_name ?? 'No name' })));

      if (isNew) {
        // 💾 Same source and course as last time; one course only → chosen already
        const last = await readSaved<Last>(LAST_KEY).catch(() => null);
        const okCourses = (last?.courseIds ?? []).filter((c) => courseOpts.some((o) => o.value === c));
        const okSource = last?.sourceId && src.some((x) => x.id === last.sourceId) ? last.sourceId : null;
        lastRef.current = { sourceId: okSource, courseIds: okCourses };
        setForm((f) => ({
          ...f,
          sourceId: f.sourceId ?? okSource,
          courseIds:
            f.courseIds.length > 0
              ? f.courseIds
              : okCourses.length > 0
                ? okCourses
                : courseOpts.length === 1
                  ? [courseOpts[0].value]
                  : [],
        }));
      }

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
        setWaSame(!lead.whatsapp_number && !lead.whatsapp_username);
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

  // --- live checks -------------------------------------------------------
  const phoneDigits = form.phone.replace(/\D/g, '');
  const phoneOk = !!form.phone.trim() && isValidBdMobile(form.phone);
  const phoneLive =
    errors.phone ?? (phoneDigits.length >= 11 && !phoneOk ? 'This is not a valid mobile number.' : undefined);
  const needCourse = courses.length > 0;

  const filled = {
    contact: [form.altPhone, form.email, form.area].filter((v) => v.trim()).length,
    guardian: [form.guardianName, form.guardianPhone, form.guardianRelation].filter((v) => v.trim()).length,
    more:
      [form.referredBy, form.notes].filter((v) => v.trim()).length +
      (form.campaignId ? 1 : 0) +
      (form.leadTypeId ? 1 : 0) +
      form.tagIds.length,
  };

  const flip = (k: Section) => setOpenSec((o) => ({ ...o, [k]: !o[k] }));

  // --- save -------------------------------------------------------------
  const handleSave = async (another = false) => {
    const found: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) found.name = 'Please enter the name.';
    const hasPhone = !!form.phone.trim();
    const hasWaNumber = !waSame && !!form.waNumber.trim();
    const hasWaUsername = !waSame && !!form.waUsername.trim();
    if (!hasPhone && !hasWaNumber && !hasWaUsername) {
      found.phone = waSame
        ? 'Enter the phone number (or turn off “WhatsApp on this number” to give a WhatsApp number).'
        : 'Enter a phone number, or a WhatsApp number / username.';
    } else if (hasPhone && !isValidBdMobile(form.phone)) {
      found.phone = 'Enter an 11-digit mobile number.';
    }
    if (hasWaNumber && !isValidWaNumber(form.waNumber)) {
      found.waNumber = 'Not a valid WhatsApp number. Other countries: start with + and the country code.';
    }
    if (hasWaUsername && !isValidWaUsername(form.waUsername)) {
      found.waUsername = '3–35 letters, numbers, “.” or “_”.';
    }
    if (needCourse && form.courseIds.length === 0) found.courseIds = 'Choose at least one course.';
    if (form.altPhone.trim() && !isValidBdMobile(form.altPhone)) found.altPhone = 'Not a valid mobile number.';
    if (form.guardianPhone.trim() && !isValidBdMobile(form.guardianPhone)) {
      found.guardianPhone = 'Not a valid mobile number.';
    }
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      if (found.altPhone) setOpenSec((o) => ({ ...o, contact: true }));
      if (found.guardianPhone) setOpenSec((o) => ({ ...o, guardian: true }));
      setFormError('Please fix the fields marked in red.');
      return;
    }

    if (duplicates.length > 0 && !confirmDuplicate) {
      setFormError('This number or username already belongs to another lead. Check above, or tap “Save anyway”.');
      return;
    }

    const input: LeadInput = {
      name: form.name,
      phone: form.phone,
      whatsapp_number: hasWaNumber ? normalizeWaNumber(form.waNumber) : null,
      whatsapp_username: hasWaUsername ? normalizeWaUsername(form.waUsername) : null,
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
        const last: Last = { sourceId: form.sourceId, courseIds: form.courseIds };
        lastRef.current = last;
        writeSaved(LAST_KEY, last);
        if (another) {
          // ➕ Next one: empty form, same source / course / assignee
          setForm({ ...EMPTY, sourceId: last.sourceId, courseIds: last.courseIds, assignee: form.assignee });
          setWaSame(true);
          setErrors({});
          setDuplicates([]);
          setOpenSec({ contact: false, guardian: false, more: false });
          setAddedCount((n) => n + 1);
          setFormKey((k) => k + 1);
        } else {
          router.replace(`/leads/${newId}` as Href);
        }
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

  // ---------------------------------------------------------------------
  // 👤 Who
  // ---------------------------------------------------------------------
  const whoCard = (
    <Card icon="person" title="Who">
      {isNew && (
        <PickNumberButtons
          onPick={({ number, name }) => {
            set('phone', number);
            if (name && !form.name.trim()) set('name', name);
          }}
        />
      )}
      <TextField
        key={`name-${formKey}`}
        label="Name"
        required
        value={form.name}
        onChangeText={(v) => set('name', v)}
        error={errors.name}
        autoCapitalize="words"
        autoFocus={isNew}
      />
      <View>
        <TextField
          label="Phone"
          value={form.phone}
          onChangeText={(v) => set('phone', v)}
          error={phoneLive}
          keyboardType="phone-pad"
          maxLength={20}
        />
        {phoneOk && !phoneLive && <Text style={styles.okText}>✓ Looks right</Text>}
      </View>

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
                <Button title="Open" variant="ghost" onPress={() => router.push(`/leads/${d.id}` as Href)} />
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

      {/* 💬 WhatsApp */}
      <Pressable
        onPress={() => setWaSame((v) => !v)}
        style={[styles.toggle, waSame && styles.toggleOn]}
        accessibilityRole="switch"
        accessibilityState={{ checked: waSame }}
      >
        <View style={[styles.box, waSame && styles.boxOn]}>
          {waSame && <MIcon name="check" size={14} color={colors.textOnPrimary} />}
        </View>
        <View style={styles.flex}>
          <Text style={styles.toggleText}>💬 WhatsApp on this phone number</Text>
          {!waSame && <Text style={styles.hint}>Give a different WhatsApp number or a username below.</Text>}
        </View>
      </Pressable>
      {!waSame && (
        <View style={styles.waRow}>
          <View style={styles.flex}>
            <TextField
              label="WhatsApp number"
              value={form.waNumber}
              onChangeText={(v) => set('waNumber', v)}
              error={errors.waNumber}
              keyboardType="phone-pad"
            />
          </View>
          <View style={styles.flex}>
            <TextField
              label="WhatsApp username"
              value={form.waUsername}
              onChangeText={(v) => set('waUsername', v)}
              error={errors.waUsername}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="@username"
            />
          </View>
        </View>
      )}
    </Card>
  );

  // ---------------------------------------------------------------------
  // 🎓 Interested course (required)
  // ---------------------------------------------------------------------
  const courseCard = (
    <Card icon="school" title="Interested course" required={needCourse} error={!!errors.courseIds}>
      {courses.length === 0 ? (
        <Text style={styles.hint}>No course is open for you. Ask an admin (Settings → Courses / Roles).</Text>
      ) : (
        <>
          <Chips options={courses} selected={form.courseIds} onPress={(v) => toggleIn('courseIds', v)} big check />
          {errors.courseIds ? (
            <Text style={styles.errText}>{errors.courseIds}</Text>
          ) : (
            <Text style={styles.hint}>One or more.</Text>
          )}
        </>
      )}
    </Card>
  );

  // ---------------------------------------------------------------------
  // ⚡ Rating, source, who gets it
  // ---------------------------------------------------------------------
  const quickCard = (
    <Card icon="bolt" title="Quick details">
      <Field label="Rating">
        <View style={styles.segment}>
          {RATINGS.map((r) => {
            const on = form.rating === r.value;
            return (
              <Pressable
                key={r.value}
                onPress={() => set('rating', on ? null : r.value)}
                style={[styles.segBtn, { borderColor: r.color }, on && { backgroundColor: r.color }]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <Text style={[styles.segText, { color: on ? colors.textOnPrimary : r.color }]}>{r.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Field>
      <Field label="Source">
        <Chips
          options={sources}
          selected={form.sourceId ? [form.sourceId] : []}
          onPress={(v) => set('sourceId', form.sourceId === v ? null : v)}
          disabled={sourceLocked}
        />
        {sourceLocked && <Text style={styles.hint}>The original source cannot be changed.</Text>}
      </Field>
      {selectedSourceName.toLowerCase().includes('referral') && (
        <TextField
          label="Referred by"
          value={form.referredBy}
          onChangeText={(v) => set('referredBy', v)}
          placeholder="Name of the student or agent"
        />
      )}
      {!isNew && (
        <Field label="Stage">
          <Chips options={stages} selected={form.stageId ? [form.stageId] : []} onPress={(v) => set('stageId', v)} />
          <Text style={styles.hint}>Admitted and Lost are set from the lead page.</Text>
        </Field>
      )}
      {canAssign ? (
        <Field label="Assigned to">
          <Chips options={assigneeOptions} selected={[form.assignee]} onPress={(v) => set('assignee', v)} />
          {isNew && form.assignee === AUTO && auto.reason !== '' && (
            <Text style={styles.hint}>{auto.reason}. Pick a person to choose by hand.</Text>
          )}
        </Field>
      ) : (
        isNew &&
        assignmentOn && (
          <Text style={styles.hint}>
            {auto.userId === profile?.id
              ? '👤 This lead will be assigned to you.'
              : '👤 This lead will be saved as Unassigned. An admin will give it to someone.'}
          </Text>
        )
      )}
    </Card>
  );

  // ---------------------------------------------------------------------
  // More details (folded)
  // ---------------------------------------------------------------------
  const moreCards = (
    <>
      <Fold
        icon="call"
        title="Other contact"
        count={filled.contact}
        open={openSec.contact}
        onPress={() => flip('contact')}
      >
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
      </Fold>

      <Fold
        icon="family-restroom"
        title="Guardian"
        count={filled.guardian}
        open={openSec.guardian}
        onPress={() => flip('guardian')}
      >
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
      </Fold>

      <Fold
        icon="tune"
        title="Campaign, type, tags, notes"
        count={filled.more}
        open={openSec.more}
        onPress={() => flip('more')}
      >
        {campaignOptions.length > 0 && (
          <Field label="Campaign">
            <Chips
              options={campaignOptions}
              selected={form.campaignId ? [form.campaignId] : []}
              onPress={(v) => set('campaignId', form.campaignId === v ? null : v)}
            />
          </Field>
        )}
        {leadTypes.length > 0 && (
          <Field label="Lead type">
            <Chips
              options={leadTypes}
              selected={form.leadTypeId ? [form.leadTypeId] : []}
              onPress={(v) => set('leadTypeId', form.leadTypeId === v ? null : v)}
            />
          </Field>
        )}
        {tags.length > 0 && (
          <Field label="Tags">
            <Chips options={tags} selected={form.tagIds} onPress={(v) => toggleIn('tagIds', v)} />
          </Field>
        )}
        <TextField label="Notes" value={form.notes} onChangeText={(v) => set('notes', v)} multiline />
        {!isNew && <VoiceNoteButton leadId={id} context="lead" />}
      </Fold>
    </>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: isNew ? 'New lead' : 'Edit lead' }} />

      <KeyboardAwareScrollView
        bottomOffset={spacing.xl}
        contentContainerStyle={[styles.content, wide && styles.contentWide]}
        keyboardShouldPersistTaps="handled"
      >
        {addedCount > 0 && (
          <View style={styles.addedBox}>
            <Text style={styles.addedText}>
              ✅ {addedCount} {addedCount === 1 ? 'lead' : 'leads'} saved. Next one — same source and course.
            </Text>
          </View>
        )}

        {wide ? (
          <View style={styles.cols}>
            <View style={styles.col}>
              {whoCard}
              {courseCard}
            </View>
            <View style={styles.col}>
              {quickCard}
              {moreCards}
            </View>
          </View>
        ) : (
          <>
            {whoCard}
            {courseCard}
            {quickCard}
            {moreCards}
          </>
        )}

        {formError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{formError}</Text>
          </View>
        )}
      </KeyboardAwareScrollView>

      {/* Always in reach */}
      <View style={[styles.footer, { paddingBottom: spacing.md + (isWeb ? 0 : insets.bottom) }]}>
        <View style={[styles.footerIn, wide && styles.footerWide]}>
          {isNew && (
            <View style={styles.flex}>
              <Button
                title="Save & next"
                variant="secondary"
                onPress={() => handleSave(true)}
                disabled={saving}
                fullWidth
              />
            </View>
          )}
          <View style={styles.flex}>
            <Button
              title={isNew ? 'Save lead' : 'Save changes'}
              onPress={() => handleSave(false)}
              loading={saving}
              fullWidth
            />
          </View>
        </View>
      </View>
    </View>
  );
}

// =====================================================================
// Small helpers
// =====================================================================
function Card({
  icon,
  title,
  required,
  error,
  children,
}: {
  icon: MIconName;
  title: string;
  required?: boolean;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.card, error && styles.cardError]}>
      <View style={styles.cardHead}>
        <View style={styles.cardIcon}>
          <MIcon name={icon} size={18} color={colors.primary} />
        </View>
        <Text style={styles.sectionTitle}>
          {title}
          {required && <Text style={styles.star}> *</Text>}
        </Text>
      </View>
      {children}
    </View>
  );
}

function Fold({
  icon,
  title,
  count,
  open,
  onPress,
  children,
}: {
  icon: MIconName;
  title: string;
  count: number;
  open: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onPress}
        style={styles.cardHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={styles.cardIcon}>
          <MIcon name={icon} size={18} color={colors.primary} />
        </View>
        <Text style={[styles.sectionTitle, styles.flex]}>{title}</Text>
        {count > 0 && (
          <View style={styles.countPill}>
            <Text style={styles.countText}>{count}</Text>
          </View>
        )}
        <MIcon name={open ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
      </Pressable>
      {open && children}
    </View>
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

function Chips({
  options,
  selected,
  onPress,
  disabled,
  big,
  check,
}: {
  options: Option[];
  selected: string[];
  onPress: (value: string) => void;
  disabled?: boolean;
  big?: boolean;
  check?: boolean;
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
              big && styles.chipBig,
              on && { backgroundColor: tint, borderColor: tint },
              disabled && !on && styles.chipDisabled,
            ]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled }}
          >
            {check && on && <MIcon name="check" size={16} color={colors.textOnPrimary} />}
            {o.color && !on && <View style={[styles.chipDot, { backgroundColor: o.color }]} />}
            <Text style={[styles.chipText, big && styles.chipTextBig, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    // 🌐 Website: a readable column in the middle
    ...(isWeb ? { maxWidth: 720, width: '100%', alignSelf: 'center' } : {}),
  },
  contentWide: { maxWidth: 1180 },
  cols: { flexDirection: 'row', gap: spacing.lg, alignItems: 'flex-start' },
  col: { flex: 1, gap: spacing.md },
  flex: { flex: 1 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardError: { borderColor: colors.danger, borderWidth: 1.5 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  star: { color: colors.danger },
  countPill: {
    minWidth: 22,
    paddingHorizontal: 6,
    height: 22,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  countText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  okText: { fontSize: fontSize.caption, color: colors.success, fontWeight: fontWeight.semibold, marginTop: 4 },
  errText: { fontSize: fontSize.caption, color: colors.danger, fontWeight: fontWeight.semibold },
  waRow: { flexDirection: 'row', gap: spacing.sm },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: { backgroundColor: colors.successSoft, borderColor: colors.successSoft },
  toggleText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.success, borderColor: colors.success },
  segment: { flexDirection: 'row', gap: spacing.sm },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    borderWidth: 1.5,
  },
  segText: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
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
  chipBig: { paddingVertical: spacing.md - 2, paddingHorizontal: spacing.lg - 2 },
  chipDisabled: { opacity: 0.4 },
  chipDot: { width: 8, height: 8, borderRadius: radius.pill },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextBig: { fontSize: fontSize.body },
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
  addedBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.successSoft },
  addedText: { fontSize: fontSize.small, color: colors.success, fontWeight: fontWeight.semibold },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  footer: {
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  footerIn: {
    flexDirection: 'row',
    gap: spacing.sm,
    ...(isWeb ? { maxWidth: 720, width: '100%', alignSelf: 'center' } : {}),
  },
  footerWide: { maxWidth: 1180 },
});
