import { router, Stack, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { NextContactPicker } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, md } from '@/features/home/md';
import { countLeads, KEEP_MAX, listLeadIds, listLeads, type LeadListItem, type LeadQuery } from '@/features/leads/api';
import { LeadFilterSheet } from '@/features/leads/LeadFilterSheet';
import { countActiveFilters, type LeadFilters } from '@/features/leads/filters';
import { listPipelineStages, type PipelineStage } from '@/features/pipeline/api';
import { AiSmsSheet } from '@/features/sms/AiSmsSheet';
import {
  canSendSms,
  fillLeadSms,
  GROUP_LABEL,
  KIND_LABEL,
  LEAD_PLACEHOLDERS,
  mySenders,
  previewLeadSms,
  sendLeadSms,
  smsDraft,
  smsLength,
  type LeadSmsPreview,
  type MySender,
  type SmsGroup,
} from '@/features/sms/api';
import { listTemplates, saveTemplate, type MessageTemplate } from '@/features/templates/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📨 SMS Center: one SMS to many — Active leads, Not Now, Admitted
//   (every filter of the lead list: stages, tags, course, batch, person,
//   fee, papers, visit, AI chance…), or Alumni.
//   ① who gets it ② the message (yourself, a template, or 🤖 AI)
//   ③ from which sender ID, now or later ④ send → the queue
// =====================================================================

const say = (title: string, msg: string) =>
  Platform.OS === 'web' ? window.alert(`${title}\n\n${msg}`) : Alert.alert(title, msg);
const confirm = (title: string, msg: string, ok: string): Promise<boolean> =>
  new Promise((resolve) => {
    if (Platform.OS === 'web') resolve(window.confirm(`${title}\n\n${msg}`));
    else
      Alert.alert(title, msg, [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: ok, onPress: () => resolve(true) },
      ]);
  });
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

type Tab = SmsGroup | 'alumni';
const TABS: { key: Tab; label: string; icon: Parameters<typeof MIcon>[0]['name'] }[] = [
  { key: 'active', label: 'Active', icon: 'person-search' },
  { key: 'not_now', label: 'Not Now', icon: 'block' },
  { key: 'admitted', label: 'Admitted', icon: 'school' },
  { key: 'alumni', label: 'Alumni', icon: 'workspace-premium' },
];

export default function SmsCenterScreen() {
  const { profile } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<LeadFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  // 📌 chosen on the lead list (instead of the filters)
  const [chosen, setChosen] = useState<string[] | null>(null);

  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<LeadListItem[]>([]);
  const [ids, setIds] = useState<string[] | null>(null);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<LeadSmsPreview | null>(null);
  const [loadingWho, setLoadingWho] = useState(false);

  const [senders, setSenders] = useState<MySender[]>([]);
  const [sender, setSender] = useState('');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [at, setAt] = useState<Date | null>(null);
  const [later, setLater] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    canSendSms().then(setAllowed);
    mySenders()
      .then((s) => {
        setSenders(s);
        setSender(
          (s.find((x) => x.is_default && x.kind === 'masking') ?? s.find((x) => x.is_default) ?? s[0])?.id ?? '',
        );
      })
      .catch(() => undefined);
    listPipelineStages(true)
      .then(setStages)
      .catch(() => undefined);
    listTemplates()
      .then((t) => setTemplates(t.filter((x) => x.is_active && x.channels !== 'whatsapp')))
      .catch(() => undefined);
  }, []);

  // marked on the lead list → here
  useFocusEffect(
    useCallback(() => {
      const d = smsDraft.take();
      if (d) {
        setChosen(d.ids);
        setTab(d.group);
      }
    }, []),
  );

  const group: SmsGroup | null = tab === 'alumni' ? null : tab;
  const lostIds = useMemo(() => stages.filter((s) => s.kind === 'lost').map((s) => s.id), [stages]);

  // the lead list's own query for this group
  const query: LeadQuery | null = useMemo(() => {
    if (!group) return null;
    if (chosen) return { onlyIds: chosen, closedMode: 'show', userId: profile?.id };
    const q: LeadQuery = { search: search.trim(), filters, userId: profile?.id, sort: 'newest' as LeadQuery['sort'] };
    if (group === 'active') return { ...q, closedMode: 'hide' };
    if (group === 'admitted') return { ...q, students: true };
    // Not Now: the "not now" stages (unless stages are chosen in the filter)
    return {
      ...q,
      closedMode: 'show',
      filters: { ...filters, stageIds: filters.stageIds?.length ? filters.stageIds : lostIds },
    };
  }, [group, chosen, search, filters, profile?.id, lostIds]);

  // count + the first names (as the filters change)
  const seq = useRef(0);
  useEffect(() => {
    setIds(null);
    setPreview(null);
    setLeft(new Set());
    if (!query || (group === 'not_now' && !chosen && lostIds.length === 0)) return;
    const my = ++seq.current;
    setLoadingWho(true);
    const t = setTimeout(() => {
      Promise.all([countLeads(query), listLeads({ ...query, page: 0 })])
        .then(([n, page]) => {
          if (my !== seq.current) return;
          setCount(n ?? page.total ?? page.items.length);
          setSample(page.items);
        })
        .catch((e) => my === seq.current && setError(errText(e)))
        .finally(() => my === seq.current && setLoadingWho(false));
    }, 400);
    return () => clearTimeout(t);
  }, [query, group, chosen, lostIds.length]);

  // who exactly gets it (the ids, then the server's count)
  const check = async () => {
    if (!query || !group) return;
    setLoadingWho(true);
    setError(null);
    try {
      const all = await listLeadIds(query);
      const use = all.filter((id) => !left.has(id));
      setIds(use);
      setPreview(await previewLeadSms(use, group));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingWho(false);
    }
  };
  // a name taken out / put back: count again
  useEffect(() => {
    if (ids) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const filterLabel = useMemo(() => {
    if (!group) return '';
    if (chosen) return `${GROUP_LABEL[group]} · ${chosen.length} marked on the lead list`;
    const n = countActiveFilters(filters);
    return [
      GROUP_LABEL[group],
      n ? `${n} filter${n === 1 ? '' : 's'}` : 'all',
      search.trim() ? `search “${search.trim()}”` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }, [group, chosen, filters, search]);

  const len = smsLength(text);
  const first = sample.find((l) => !left.has(l.id));
  const chosenSender = senders.find((s) => s.id === sender);

  const send = async () => {
    if (!group || !ids || !preview) return;
    const when = later && at ? at : null;
    const ok = await confirm(
      `Send to ${preview.will_get} ${preview.will_get === 1 ? 'person' : 'people'}?`,
      `${GROUP_LABEL[group]} · from ${chosenSender?.sender_id ?? ''}${
        chosenSender ? ` (${KIND_LABEL[chosenSender.kind]})` : ''
      }\nAbout ${preview.will_get * len.parts} SMS (${len.parts} each).\n${
        when ? `Goes out ${when.toLocaleString()}.` : 'Goes out within a few minutes.'
      }`,
      when ? 'Schedule' : 'Send',
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sendLeadSms({
        ids,
        group,
        message: text.trim(),
        senderId: sender,
        name: name.trim() || null,
        filterLabel,
        at: when,
      });
      say(
        r.scheduled_at ? 'Scheduled' : 'Sending',
        r.scheduled_at
          ? `${r.queued} SMS go out at ${new Date(r.scheduled_at).toLocaleString()}.`
          : `${r.queued} SMS are in the queue (${r.parts} in all).`,
      );
      setText('');
      setName('');
      setIds(null);
      setPreview(null);
      router.push(`/alumni/sms?id=${r.batch_id}` as Href);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAsTemplate = async () => {
    const t = text.trim();
    if (!t) return;
    const title = name.trim() || t.slice(0, 30);
    try {
      await saveTemplate(null, {
        name: title,
        body: t,
        channels: 'sms',
        category: 'Other',
        course_ids: null,
        is_shared: false,
        is_active: true,
      });
      setTemplates(await listTemplates().then((x) => x.filter((y) => y.is_active && y.channels !== 'whatsapp')));
      say('Saved', `“${title}” is in your templates.`);
    } catch (e) {
      say('Could not save', errText(e));
    }
  };

  if (allowed === null) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'SMS Center' }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!allowed) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'SMS Center' }} />
        <Text style={[ui.muted, styles.pad]}>
          SMS is off, or you are not allowed to send SMS. An admin sets it in Settings → SMS.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'SMS Center' }} />

      <View style={styles.topRow}>
        <Text style={[styles.h1, styles.flex]}>📨 SMS Center</Text>
        <Button title="📋 Sent" variant="ghost" onPress={() => router.push('/alumni/sms' as Href)} />
      </View>

      {/* ① who */}
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => {
              setTab(t.key);
              setChosen(null);
              setFilters({});
            }}
            style={[styles.tab, tab === t.key && styles.tabOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.key }}
          >
            <MIcon name={t.icon} size={18} color={tab === t.key ? md.onPrimaryC : colors.text} />
            <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'alumni' ? (
        <View style={ui.card}>
          <Text style={styles.text}>
            Alumni have their own list and filters. Open Alumni, filter, tap “Mark all”, then SMS — or ask the AI there.
          </Text>
          <Button title="🎓 Open Alumni" onPress={() => router.push('/alumni' as Href)} />
        </View>
      ) : (
        <>
          <View style={ui.card}>
            <Text style={ui.label}>① WHO GETS IT</Text>
            {chosen ? (
              <View style={styles.rowWrap}>
                <Text style={[styles.text, styles.flex]}>📌 {chosen.length} marked on the lead list</Text>
                <Button title="Use filters instead" variant="ghost" onPress={() => setChosen(null)} />
              </View>
            ) : (
              <>
                <View style={styles.rowWrap}>
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search name, phone…"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, styles.flex]}
                  />
                  <Button
                    title={`🔍 Filter${countActiveFilters(filters) ? ` (${countActiveFilters(filters)})` : ''}`}
                    variant="secondary"
                    onPress={() => setFilterOpen(true)}
                  />
                </View>
                <Text style={ui.muted}>
                  Every filter of the lead list: stage, tags, course, batch, person, source, campaign, fee, papers,
                  visit, AI chance, added / contacted dates…
                </Text>
              </>
            )}

            {loadingWho && <ActivityIndicator color={colors.primary} />}
            {count !== null && !loadingWho && (
              <Text style={styles.big}>
                {count} {count === 1 ? 'lead' : 'leads'} match
                {count > KEEP_MAX ? ` (the first ${KEEP_MAX} are used; narrow the filter to send to the rest)` : ''}
              </Text>
            )}
            {sample.slice(0, 12).map((l) => (
              <Pressable key={l.id} onPress={() => setLeft((s) => toggle(s, l.id))} style={styles.person}>
                <MIcon
                  name={left.has(l.id) ? 'check-box-outline-blank' : 'check-box'}
                  size={20}
                  color={left.has(l.id) ? colors.textMuted : colors.primary}
                />
                <Text style={[styles.text, styles.flex, left.has(l.id) && styles.struck]} numberOfLines={1}>
                  {l.name} · {l.phone ?? 'no number'}
                </Text>
                <Text style={ui.muted} numberOfLines={1}>
                  {l.stage?.name ?? ''}
                </Text>
              </Pressable>
            ))}
            {sample.length > 12 && <Text style={ui.muted}>…and more. Untick a name to leave them out.</Text>}

            <Button
              title={preview ? '↻ Count again' : '✅ Check who gets it'}
              variant="secondary"
              onPress={check}
              loading={loadingWho}
              disabled={!count}
            />
            {preview && (
              <View style={styles.counts}>
                <Text style={styles.big}>✅ {preview.will_get} will get it</Text>
                {preview.no_number > 0 && <Text style={ui.muted}>📵 {preview.no_number} have no mobile number</Text>}
                {preview.same_number > 0 && (
                  <Text style={ui.muted}>👥 {preview.same_number} share a number (one SMS)</Text>
                )}
                {preview.other_group > 0 && (
                  <Text style={ui.muted}>
                    ↪️ {preview.other_group} are not {GROUP_LABEL[group!]} (left out)
                  </Text>
                )}
                {preview.selected > preview.visible && (
                  <Text style={ui.muted}>🔒 {preview.selected - preview.visible} you can’t see (left out)</Text>
                )}
                {preview.got_sms_before > 0 && (
                  <Text style={ui.muted}>ℹ️ {preview.got_sms_before} got an SMS before</Text>
                )}
              </View>
            )}
          </View>

          {/* ② the message */}
          <View style={ui.card}>
            <View style={styles.rowWrap}>
              <Text style={[ui.label, styles.flex]}>② THE MESSAGE</Text>
              <Button title="🤖 Write with AI" variant="secondary" onPress={() => setAiOpen(true)} />
            </View>
            {templates.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hRow}>
                {templates.map((t) => (
                  <Chip key={t.id} text={`📄 ${t.name}`} on={text === t.body} onPress={() => setText(t.body)} />
                ))}
              </ScrollView>
            )}
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="আসসালামু আলাইকুম {first_name}, …"
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={1000}
              style={[styles.input, styles.multi]}
            />
            <Text style={ui.muted}>
              {len.chars} letters · {len.parts} SMS each{len.unicode ? ' (Bangla: 70 letters a SMS)' : ''}
            </Text>
            <View style={ui.chips}>
              {LEAD_PLACEHOLDERS.map((p) => (
                <Chip key={p} text={`+ ${p}`} on={false} onPress={() => setText((t) => `${t}${p}`)} />
              ))}
            </View>
            {!!text.trim() && first && (
              <View style={styles.previewBox}>
                <Text style={ui.muted}>{first.name} gets:</Text>
                <Text style={styles.text}>
                  {fillLeadSms(text.trim(), {
                    name: first.name,
                    course: first.admitted_course?.name ?? first.lead_courses[0]?.course?.name ?? null,
                    stage: first.stage?.name ?? null,
                    student_id: first.student_ref,
                    fee_due: first.fee_due,
                    owner: first.assignee?.full_name ?? null,
                    owner_phone: null,
                  })}
                </Text>
              </View>
            )}
            {!!text.trim() && <Button title="💾 Save as a template" variant="ghost" onPress={saveAsTemplate} />}
          </View>

          {/* ③ from / when */}
          <View style={ui.card}>
            <Text style={ui.label}>③ FROM</Text>
            {senders.length === 0 ? (
              <Text style={ui.muted}>No sender ID is ready (Settings → SMS).</Text>
            ) : (
              <View style={ui.chips}>
                {senders.map((s) => (
                  <Chip
                    key={s.id}
                    text={`${s.sender_id} · ${KIND_LABEL[s.kind]}`}
                    on={sender === s.id}
                    onPress={() => setSender(s.id)}
                  />
                ))}
              </View>
            )}
            <Text style={ui.label}>WHEN</Text>
            <View style={ui.chips}>
              <Chip text="Now" on={!later} onPress={() => setLater(false)} />
              <Chip text="⏰ Later" on={later} onPress={() => setLater(true)} />
            </View>
            {later && <NextContactPicker value={at} onChange={setAt} />}
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="A name for this send (optional), e.g. Admission deadline"
              placeholderTextColor={colors.textMuted}
              maxLength={80}
              style={styles.input}
            />
          </View>

          {error && <Text style={ui.error}>{error}</Text>}
          <Button
            title={
              preview
                ? `${later && at ? '⏰ Schedule' : '📨 Send'} to ${preview.will_get}`
                : 'First tap “Check who gets it”'
            }
            onPress={send}
            loading={busy}
            disabled={!preview || preview.will_get === 0 || !text.trim() || !sender || (later && !at)}
          />
        </>
      )}

      {group && (
        <LeadFilterSheet
          visible={filterOpen}
          value={filters}
          students={group === 'admitted'}
          onClose={() => setFilterOpen(false)}
          onApply={(f) => {
            setFilters(f);
            setFilterOpen(false);
          }}
        />
      )}
      {aiOpen && (
        <AiSmsSheet
          group={tab}
          count={preview?.will_get ?? count ?? undefined}
          filter={filterLabel}
          current={text}
          onClose={() => setAiOpen(false)}
          onPick={(t) => {
            setText(t);
            setAiOpen(false);
          }}
        />
      )}
    </ScrollView>
  );
}

function toggle(s: Set<string>, id: string): Set<string> {
  const n = new Set(s);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 100,
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  pad: { padding: spacing.xl, textAlign: 'center' },
  flex: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center' },
  h1: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    height: 40,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: md.primaryC, borderColor: md.primaryC },
  tabText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  tabTextOn: { color: md.onPrimaryC },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  hRow: { gap: spacing.xs },
  text: { fontSize: fontSize.body, color: colors.text },
  big: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  counts: { gap: 2 },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
    backgroundColor: colors.surface,
  },
  multi: { minHeight: 120, textAlignVertical: 'top' },
  previewBox: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
});
