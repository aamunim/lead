import { router, Stack, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MenuSheet, NextContactPicker, Sheet } from '@/features/alumni/sheets';
import { s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { card, MIcon, md, Tap, type MIconName } from '@/features/home/md';
import {
  KEEP_MAX,
  listLeadIds,
  listLeads,
  listLeadsByIds,
  type LeadListItem,
  type LeadQuery,
} from '@/features/leads/api';
import { LeadFilterSheet } from '@/features/leads/LeadFilterSheet';
import { countActiveFilters, type LeadFilters } from '@/features/leads/filters';
import { listPipelineStages, type PipelineStage } from '@/features/pipeline/api';
import { AiSmsPlanCard } from '@/features/sms/AiSmsPlanCard';
import { AiSmsSheet } from '@/features/sms/AiSmsSheet';
import {
  canSendSms,
  fillLeadSms,
  GROUP_LABEL,
  KIND_LABEL,
  LEAD_PLACEHOLDERS,
  leadSmsBadNumbers,
  mySenders,
  previewLeadSms,
  sendLeadSms,
  smsDraft,
  smsLength,
  type BadNumber,
  type LeadSmsPreview,
  type MySender,
  type SmsGroup,
} from '@/features/sms/api';
import { listTemplates, saveTemplate, type MessageTemplate } from '@/features/templates/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📨 SMS Center: one SMS to many — Active leads, Not Now, Admitted
//   (every filter of the lead list), or Alumni.
//   🤖 AI suggestions on top · ① Recipients (counted as you filter)
//   ② Message (template / AI / fields, an SMS-bubble preview)
//   ③ From & when · a bar at the bottom: how many, and Send
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
const fmt = (n: number) => n.toLocaleString('en-US');

type Tab = SmsGroup | 'alumni';
const TABS: { key: Tab; label: string; icon: MIconName }[] = [
  { key: 'active', label: 'Active', icon: 'person-search' },
  { key: 'not_now', label: 'Not Now', icon: 'do-not-disturb-on' },
  { key: 'admitted', label: 'Admitted', icon: 'school' },
  { key: 'alumni', label: 'Alumni', icon: 'workspace-premium' },
];

export default function SmsCenterScreen() {
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<LeadFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  // 📌 chosen on the lead list or by an AI suggestion (instead of the filters)
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [chosenLabel, setChosenLabel] = useState<string | null>(null);
  const scrollRef = useRef<KeyboardAwareScrollViewRef>(null);
  const whoY = useRef(0);

  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState<LeadListItem[]>([]);
  const [ids, setIds] = useState<string[] | null>(null);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<LeadSmsPreview | null>(null);
  const [counting, setCounting] = useState(false);
  const [showNames, setShowNames] = useState(false);
  const [allNames, setAllNames] = useState(false);

  const [senders, setSenders] = useState<MySender[]>([]);
  const [sender, setSender] = useState('');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [at, setAt] = useState<Date | null>(null);
  const [later, setLater] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [sheet, setSheet] = useState<null | 'ai' | 'templates' | 'bad'>(null);
  // 📵 who gets no SMS, and why
  const [bad, setBad] = useState<BadNumber[] | null>(null);
  const openBad = async () => {
    if (!ids || !group) return;
    setBad(null);
    setSheet('bad');
    try {
      // the ones taken out by hand are not listed
      setBad(await leadSmsBadNumbers(ids, group));
    } catch (e) {
      setSheet((now) => (now === 'bad' ? null : now));
      say('Could not load', errText(e));
    }
  };
  const [showFields, setShowFields] = useState(false);
  const [busy, setBusy] = useState(false);
  // one send at a time (a double tap opens one dialog)
  const sending = useRef(false);
  // every id that matches, before names are taken out
  const [allIds, setAllIds] = useState<string[] | null>(null);
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
        setChosenLabel('Marked on the lead list');
        setTab(d.group);
      }
    }, []),
  );

  const group: SmsGroup | null = tab === 'alumni' ? null : tab;
  const lostIds = useMemo(() => stages.filter((s) => s.kind === 'lost').map((s) => s.id), [stages]);
  const nFilters = countActiveFilters(filters);
  const searchKey = search.trim();

  // the lead list's own query for this group
  const query: LeadQuery | null = useMemo(() => {
    if (!group) return null;
    if (chosen) return { onlyIds: chosen, closedMode: 'show', userId: profile?.id };
    const q: LeadQuery = { search: searchKey, filters, userId: profile?.id, sort: 'newest' as LeadQuery['sort'] };
    if (group === 'active') return { ...q, closedMode: 'hide' };
    if (group === 'admitted') return { ...q, students: true };
    // Not Now: the "not now" stages (unless stages are chosen in the filter)
    return {
      ...q,
      closedMode: 'show',
      filters: { ...filters, stageIds: filters.stageIds?.length ? filters.stageIds : lostIds },
    };
  }, [group, chosen, searchKey, filters, profile?.id, lostIds]);

  // ① as the filters change: the matches and the first names (the old numbers stay
  //    on screen, greyed by "counting", until the new ones are in)
  const seq = useRef(0);
  const pseq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    pseq.current++; // an answer for the old choice is dropped
    setLeft(new Set());
    setAllIds(null);
    if (!query || !group || (group === 'not_now' && !chosen && lostIds.length === 0)) {
      setCount(null);
      setSample([]);
      setIds(null);
      setPreview(null);
      setCounting(false);
      return;
    }
    setCounting(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        if (chosen) {
          // marked on the lead list / an AI group: the ids are known — no long links,
          // just the first names
          const page = await listLeadsByIds(chosen.slice(0, 30));
          if (my !== seq.current) return;
          setCount(chosen.length);
          setSample(page);
          setAllIds(chosen);
        } else {
          const [page, all] = await Promise.all([listLeads({ ...query, page: 0 }), listLeadIds(query)]);
          if (my !== seq.current) return;
          setCount(page.total ?? all.length);
          setSample(page.items);
          setAllIds(all);
        }
      } catch (e) {
        if (my === seq.current) {
          // no old numbers left to send to by mistake
          setError(errText(e));
          setIds(null);
          setPreview(null);
          setCounting(false);
        }
      }
    }, 450);
    return () => clearTimeout(t);
  }, [query, group, chosen, lostIds.length]);

  // ② who really gets it (the server's count) — again only this when a name is taken out
  useEffect(() => {
    if (!allIds || !group) return;
    const my = ++pseq.current;
    const use = allIds.filter((id) => !left.has(id));
    setCounting(true);
    (use.length ? previewLeadSms(use, group) : Promise.resolve(null))
      .then((p) => {
        if (my !== pseq.current) return;
        setIds(use);
        setPreview(p);
      })
      .catch((e) => {
        if (my !== pseq.current) return;
        setError(errText(e));
        setIds(null);
        setPreview(null);
      })
      .finally(() => my === pseq.current && setCounting(false));
  }, [allIds, left, group]);

  const filterLabel = useMemo(() => {
    if (!group) return '';
    if (chosen) return `${GROUP_LABEL[group]} · ${chosenLabel ?? 'chosen'} · ${chosen.length} leads`;
    return [
      GROUP_LABEL[group],
      nFilters ? `${nFilters} filter${nFilters === 1 ? '' : 's'}` : 'all',
      search.trim() ? `search “${search.trim()}”` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }, [group, chosen, chosenLabel, nFilters, search]);

  const len = smsLength(text);
  const limit = len.unicode ? (len.parts === 1 ? 70 : 67 * len.parts) : len.parts === 1 ? 160 : 153 * len.parts;
  const first = sample.find((l) => !left.has(l.id));
  const chosenSender = senders.find((s) => s.id === sender);
  const willGet = preview?.will_get ?? 0;
  const ready = !!preview && willGet > 0 && !!text.trim() && !!sender && (!later || !!at) && !counting;

  const switchTab = (t: Tab) => {
    setTab(t);
    setChosen(null);
    setChosenLabel(null);
    setFilters({});
    setSearch('');
    setLeft(new Set());
    setShowNames(false);
  };

  const send = async () => {
    if (!group || !ids || !preview || sending.current) return;
    const when = later && at ? at : null;
    if (when && when.getTime() <= Date.now() + 60_000) {
      return say('Pick a later time', 'The time you chose has passed. Choose a time ahead, or Send now.');
    }
    sending.current = true;
    try {
      await sendNow(when);
    } finally {
      sending.current = false;
    }
  };
  const sendNow = async (when: Date | null) => {
    if (!group || !ids || !preview) return;
    const ok = await confirm(
      `Send to ${fmt(willGet)} ${willGet === 1 ? 'person' : 'people'}?`,
      `${GROUP_LABEL[group]} · from ${chosenSender?.sender_id ?? ''}${
        chosenSender ? ` (${KIND_LABEL[chosenSender.kind]})` : ''
      }\nAbout ${fmt(willGet * len.parts)} SMS (${len.parts} each).\n${
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
        name: name.trim() || chosenLabel || null,
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
    const title = name.trim() || chosenLabel || t.slice(0, 30);
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

  const header = (
    <Stack.Screen
      options={{
        title: 'SMS Center',
        headerRight: () => (
          <Tap onPress={() => router.push('/alumni/sms' as Href)} style={styles.headerBtn} label="SMS sent" borderless>
            <MIcon name="history" color={Platform.OS === 'web' ? colors.primary : colors.textOnPrimary} />
          </Tap>
        ),
      }}
    />
  );

  if (allowed === null) {
    return (
      <View style={styles.center}>
        {header}
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!allowed) {
    return (
      <View style={styles.center}>
        {header}
        <MIcon name="sms-failed" size={48} color={colors.textMuted} />
        <Text style={[ui.muted, styles.pad]}>
          SMS is off, or you are not allowed to send SMS. An admin sets it in Settings → SMS.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {header}
      <KeyboardAwareScrollView
        ref={scrollRef}
        bottomOffset={spacing.xl}
        contentContainerStyle={[styles.content, group && { paddingBottom: 120 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* 🤖 AI: which leads, which SMS today */}
        <AiSmsPlanCard
          onUse={(sug) => {
            setTab(sug.group);
            setFilters({});
            setSearch('');
            setLeft(new Set());
            setChosen(sug.lead_ids);
            setChosenLabel(sug.title);
            if (sug.message) setText(sug.message);
            // after the card has its new size
            setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, whoY.current - 8), animated: true }), 250);
          }}
        />

        {/* Who: one segmented bar */}
        <View style={styles.segment} onLayout={(e) => (whoY.current = e.nativeEvent.layout.y)}>
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => switchTab(t.key)}
                style={[styles.segItem, on && styles.segOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
              >
                <MIcon name={t.icon} size={20} color={on ? md.onPrimaryC : colors.textMuted} />
                <Text style={[styles.segText, on && styles.segTextOn]} numberOfLines={1}>
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === 'alumni' ? (
          <View style={styles.card}>
            <View style={styles.emptyArt}>
              <MIcon name="workspace-premium" size={40} color={md.onPurpleC} />
            </View>
            <Text style={styles.cardTitle}>Alumni have their own list</Text>
            <Text style={ui.muted}>
              Open Alumni, filter as you like, tap “Mark all”, then SMS. The AI can write it there too.
            </Text>
            <Button title="Open Alumni" onPress={() => router.push('/alumni' as Href)} />
          </View>
        ) : (
          <>
            {/* ① Recipients */}
            <View style={styles.card}>
              <StepHead n={1} title="Recipients" />
              {chosen ? (
                <View style={styles.chosen}>
                  <MIcon name="push-pin" size={18} color={md.onPrimaryC} />
                  <Text style={styles.chosenText} numberOfLines={2}>
                    {chosenLabel ?? 'Chosen'} · {fmt(chosen.length)} leads
                  </Text>
                  <Tap
                    onPress={() => {
                      setChosen(null);
                      setChosenLabel(null);
                    }}
                    borderless
                    label="Use filters instead"
                  >
                    <MIcon name="close" size={20} color={md.onPrimaryC} />
                  </Tap>
                </View>
              ) : (
                <View style={styles.searchRow}>
                  <View style={styles.searchBox}>
                    <MIcon name="search" size={20} color={colors.textMuted} />
                    <TextInput
                      value={search}
                      onChangeText={setSearch}
                      placeholder="Search name or phone"
                      placeholderTextColor={colors.textMuted}
                      style={styles.searchInput}
                    />
                    {!!search && (
                      <Tap onPress={() => setSearch('')} borderless label="Clear search">
                        <MIcon name="close" size={18} color={colors.textMuted} />
                      </Tap>
                    )}
                  </View>
                  <Tap
                    onPress={() => setFilterOpen(true)}
                    style={[styles.filterBtn, nFilters > 0 && styles.filterOn]}
                    label="Filter"
                  >
                    <MIcon name="tune" size={20} color={nFilters > 0 ? md.onPrimaryC : colors.text} />
                    {nFilters > 0 && <Text style={styles.filterCount}>{nFilters}</Text>}
                  </Tap>
                </View>
              )}

              {/* the big number */}
              <View style={styles.statRow}>
                <View style={styles.flex}>
                  {counting && preview === null ? (
                    <ActivityIndicator color={colors.primary} style={styles.left} />
                  ) : (
                    <>
                      <Text style={styles.big}>{fmt(willGet)}</Text>
                      <Text style={ui.muted}>
                        will get it{count !== null && count !== willGet ? ` · ${fmt(count)} match` : ''}
                      </Text>
                    </>
                  )}
                </View>
                {counting && preview !== null && <ActivityIndicator size="small" color={colors.primary} />}
              </View>
              {count !== null && count > KEEP_MAX && (
                <Text style={styles.warn}>
                  Only the first {fmt(KEEP_MAX)} are used. Narrow the filter for the rest.
                </Text>
              )}
              {preview && (
                <View style={styles.pills}>
                  {preview.no_number > 0 && (
                    <Pill icon="phone-disabled" text={`${preview.no_number} no good number ›`} onPress={openBad} warn />
                  )}
                  {!!preview.alt_used && <Pill icon="phone-forwarded" text={`${preview.alt_used} on Alt phone`} />}
                  {preview.same_number > 0 && <Pill icon="people" text={`${preview.same_number} same number`} />}
                  {preview.other_group > 0 && (
                    <Pill icon="swap-horiz" text={`${preview.other_group} not ${GROUP_LABEL[group!]}`} />
                  )}
                  {preview.selected > preview.visible && (
                    <Pill icon="lock" text={`${preview.selected - preview.visible} not yours`} />
                  )}
                  {preview.got_sms_before > 0 && (
                    <Pill icon="mark-chat-read" text={`${preview.got_sms_before} had SMS before`} />
                  )}
                  {left.size > 0 && <Pill icon="person-remove" text={`${left.size} taken out`} />}
                </View>
              )}

              {sample.length > 0 && (
                <Tap onPress={() => setShowNames(!showNames)} style={styles.namesToggle} label="Show names">
                  <Text style={styles.link}>
                    {showNames
                      ? 'Hide names'
                      : `See names${sample.length > 1 ? ` (${sample.length}${count && count > sample.length ? '+' : ''})` : ''}`}
                  </Text>
                  <MIcon name={showNames ? 'expand-less' : 'expand-more'} size={20} color={colors.primary} />
                </Tap>
              )}
              {showNames &&
                (allNames ? sample : sample.slice(0, 10)).map((l) => {
                  const out = left.has(l.id);
                  return (
                    <Pressable key={l.id} onPress={() => setLeft((s) => toggle(s, l.id))} style={styles.person}>
                      <MIcon
                        name={out ? 'check-box-outline-blank' : 'check-box'}
                        size={20}
                        color={out ? colors.textMuted : colors.primary}
                      />
                      <View style={styles.flex}>
                        <Text style={[styles.personName, out && styles.struck]} numberOfLines={1}>
                          {l.name}
                        </Text>
                        <Text style={ui.muted} numberOfLines={1}>
                          {l.phone ?? 'No number'} · {l.stage?.name ?? ''}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              {showNames && !allNames && sample.length > 10 && (
                <Tap onPress={() => setAllNames(true)} style={styles.namesToggle} label="Show all names">
                  <Text style={styles.link}>Show {sample.length - 10} more</Text>
                </Tap>
              )}
            </View>

            {/* ② Message */}
            <View style={styles.card}>
              <StepHead n={2} title="Message" />
              <View style={styles.tools}>
                <Tool icon="auto-awesome" label="Write with AI" tone="purple" onPress={() => setSheet('ai')} />
                <Tool
                  icon="description"
                  label={`Templates${templates.length ? ` · ${templates.length}` : ''}`}
                  onPress={() =>
                    templates.length
                      ? setSheet('templates')
                      : say('No templates', 'Save one from here, or in Settings → Templates.')
                  }
                />
                <Tool icon="data-object" label="Fields" on={showFields} onPress={() => setShowFields(!showFields)} />
              </View>
              {showFields && (
                <View style={styles.fields}>
                  {LEAD_PLACEHOLDERS.map((p) => (
                    <Pressable key={p} onPress={() => setText((t) => `${t}${p}`)} style={styles.field}>
                      <Text style={styles.fieldText}>{p}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <View style={styles.editor}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder="আসসালামু আলাইকুম {first_name}, …"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={1000}
                  style={styles.editorInput}
                />
                <View style={styles.editorFoot}>
                  {!!text.trim() && (
                    <Tap onPress={saveAsTemplate} borderless label="Save as a template">
                      <Text style={styles.footLink}>Save as template</Text>
                    </Tap>
                  )}
                  <Text style={[styles.counter, len.parts > 1 && styles.counterWarn]}>
                    {len.chars}/{limit} · {len.parts} SMS{len.unicode ? ' · বাংলা' : ''}
                  </Text>
                </View>
              </View>

              {!!text.trim() && first && (
                <View style={styles.phone}>
                  <Text style={styles.phoneFrom}>{chosenSender?.sender_id ?? 'SMS'}</Text>
                  <View style={styles.bubble}>
                    <Text style={styles.bubbleText}>
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
                  <Text style={styles.phoneFor}>Preview for {first.name}</Text>
                </View>
              )}
            </View>

            {/* ③ From & when */}
            <View style={styles.card}>
              <StepHead n={3} title="From & when" />
              {senders.length === 0 ? (
                <Text style={styles.warn}>No sender ID is ready. An admin adds one in Settings → SMS.</Text>
              ) : (
                <View style={styles.options}>
                  {senders.map((s) => {
                    const on = sender === s.id;
                    return (
                      <Pressable
                        key={s.id}
                        onPress={() => setSender(s.id)}
                        style={[styles.option, on && styles.optionOn]}
                      >
                        <MIcon
                          name={on ? 'radio-button-checked' : 'radio-button-unchecked'}
                          size={20}
                          color={on ? colors.primary : colors.textMuted}
                        />
                        <View style={styles.flex}>
                          <Text style={styles.optionTitle}>{s.sender_id}</Text>
                          <Text style={ui.muted}>
                            {KIND_LABEL[s.kind]}
                            {s.label ? ` · ${s.label}` : ''}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              <View style={styles.when}>
                {[
                  { k: false, label: 'Send now', icon: 'send' as MIconName },
                  { k: true, label: 'Schedule', icon: 'schedule' as MIconName },
                ].map((o) => (
                  <Pressable
                    key={o.label}
                    onPress={() => setLater(o.k)}
                    style={[styles.whenItem, later === o.k && styles.segOn]}
                  >
                    <MIcon name={o.icon} size={18} color={later === o.k ? md.onPrimaryC : colors.textMuted} />
                    <Text style={[styles.segText, later === o.k && styles.segTextOn]}>{o.label}</Text>
                  </Pressable>
                ))}
              </View>
              {later && <NextContactPicker value={at} onChange={setAt} />}

              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={chosenLabel ?? 'Name this send (optional)'}
                placeholderTextColor={colors.textMuted}
                maxLength={80}
                style={styles.nameInput}
              />
            </View>
            {error && <Text style={ui.error}>{error}</Text>}
          </>
        )}
      </KeyboardAwareScrollView>

      {/* the bar: how many, and Send */}
      {group && (
        <View style={[styles.bar, { paddingBottom: spacing.md + insets.bottom }]}>
          <View style={styles.barIn}>
            <View style={styles.flex}>
              <Text style={styles.barMain}>
                {preview ? `${fmt(willGet)} ${willGet === 1 ? 'person' : 'people'}` : counting ? 'Counting…' : '—'}
              </Text>
              <Text style={ui.muted} numberOfLines={1}>
                {!text.trim()
                  ? 'Write the message'
                  : `${fmt(willGet * len.parts)} SMS${later && at ? ` · ${at.toLocaleString()}` : ''}`}
              </Text>
            </View>
            <Pressable
              onPress={send}
              disabled={!ready || busy}
              style={[styles.sendBtn, (!ready || busy) && styles.sendOff]}
              accessibilityRole="button"
              accessibilityLabel={later ? 'Schedule' : 'Send'}
            >
              {busy ? (
                <ActivityIndicator color={colors.textOnPrimary} />
              ) : (
                <>
                  <MIcon name={later ? 'schedule-send' : 'send'} size={20} color={colors.textOnPrimary} />
                  <Text style={styles.sendText}>{later ? 'Schedule' : 'Send'}</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
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
      {sheet === 'ai' && (
        <AiSmsSheet
          group={tab}
          count={preview?.will_get ?? count ?? undefined}
          filter={filterLabel}
          current={text}
          onClose={() => setSheet(null)}
          onPick={(t) => {
            setText(t);
            setSheet(null);
          }}
        />
      )}
      {sheet === 'bad' && (
        <Sheet title="📵 No SMS to these" onClose={() => setSheet(null)}>
          <Text style={ui.muted}>
            Fix the number on the lead (tap a name). A second number in Phone moves to Alt phone by itself.
          </Text>
          {bad === null ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            bad.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => {
                  setSheet(null);
                  router.push(`/leads/${b.id}` as Href);
                }}
                style={styles.badRow}
              >
                <View style={styles.flex}>
                  <Text style={styles.personName} numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text style={ui.muted} numberOfLines={1}>
                    {b.phone || '—'}
                    {b.alt_phone ? ` · Alt ${b.alt_phone}` : ''}
                  </Text>
                </View>
                <Text style={styles.badWhy}>{b.why ?? 'No number'}</Text>
              </Pressable>
            ))
          )}
          {bad !== null && bad.length >= 200 && <Text style={ui.muted}>The first 200 are shown.</Text>}
        </Sheet>
      )}
      {sheet === 'templates' && (
        <MenuSheet
          title="Templates"
          onClose={() => setSheet(null)}
          items={templates.map((t) => ({
            label: t.name,
            icon: 'description' as MIconName,
            onPress: () => {
              setText(t.body);
              setSheet(null);
            },
          }))}
        />
      )}
    </View>
  );
}

function StepHead({ n, title }: { n: number; title: string }) {
  return (
    <View style={styles.stepHead}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <Text style={styles.cardTitle}>{title}</Text>
    </View>
  );
}

function Pill({ icon, text, onPress, warn }: { icon: MIconName; text: string; onPress?: () => void; warn?: boolean }) {
  const body = (
    <>
      <MIcon name={icon} size={14} color={warn ? colors.warning : colors.textMuted} />
      <Text style={[styles.pillText, warn && styles.pillWarn]}>{text}</Text>
    </>
  );
  return onPress ? (
    <Tap onPress={onPress} style={styles.pill} label={text}>
      {body}
    </Tap>
  ) : (
    <View style={styles.pill}>{body}</View>
  );
}

function Tool({
  icon,
  label,
  onPress,
  on,
  tone,
}: {
  icon: MIconName;
  label: string;
  onPress: () => void;
  on?: boolean;
  tone?: 'purple';
}) {
  const bg = tone === 'purple' ? md.purpleC : on ? md.primaryC : md.surface1;
  const fg = tone === 'purple' ? md.onPurpleC : on ? md.onPrimaryC : colors.text;
  return (
    <Tap onPress={onPress} style={[styles.tool, { backgroundColor: bg }]} label={label}>
      <MIcon name={icon} size={18} color={fg} />
      <Text style={[styles.toolText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
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
  content: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 760, alignSelf: 'center' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  pad: { paddingHorizontal: spacing.xl, textAlign: 'center' },
  flex: { flex: 1 },
  left: { alignSelf: 'flex-start' },
  headerBtn: { padding: spacing.sm, marginRight: spacing.xs },

  // segmented bar
  segment: { flexDirection: 'row', padding: 4, gap: 4, borderRadius: 16, backgroundColor: md.surface2 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 8, borderRadius: 12 },
  segOn: { backgroundColor: md.primaryC },
  segText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  segTextOn: { color: md.onPrimaryC },

  // cards
  card: { ...card, padding: spacing.lg, gap: spacing.md, overflow: 'visible' },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.primaryC,
  },
  stepNumText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: md.onPrimaryC },
  emptyArt: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.purpleC,
  },

  // recipients
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: 22,
    backgroundColor: md.surface1,
  },
  searchInput: { flex: 1, fontSize: fontSize.body, color: colors.text, paddingVertical: 0 },
  filterBtn: {
    height: 44,
    minWidth: 44,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  filterOn: { backgroundColor: md.primaryC },
  filterCount: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: md.onPrimaryC },
  chosen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    backgroundColor: md.primaryC,
  },
  chosenText: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
  statRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  big: { fontSize: 34, lineHeight: 40, fontWeight: fontWeight.bold, color: colors.text },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: md.surface1,
  },
  pillText: { fontSize: fontSize.caption, color: colors.textMuted },
  pillWarn: { color: colors.warning, fontWeight: fontWeight.semibold },
  badRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: md.outline,
  },
  badWhy: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.warning, maxWidth: '45%' },
  warn: { fontSize: fontSize.small, color: colors.warning },
  namesToggle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 2, paddingVertical: 4 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 6 },
  personName: { fontSize: fontSize.body, color: colors.text },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },

  // message
  tools: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: 18,
    overflow: 'hidden',
  },
  toolText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  field: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: md.outline },
  fieldText: {
    fontSize: fontSize.caption,
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  editor: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  editorInput: {
    minHeight: 130,
    padding: spacing.md,
    fontSize: fontSize.body,
    color: colors.text,
    textAlignVertical: 'top',
  },
  editorFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: md.surface1,
  },
  footLink: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },
  counter: { marginLeft: 'auto', fontSize: fontSize.caption, color: colors.textMuted },
  counterWarn: { color: colors.warning, fontWeight: fontWeight.semibold },
  phone: { gap: 4, padding: spacing.md, borderRadius: 16, backgroundColor: md.surface1 },
  phoneFrom: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  bubble: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 18,
    borderTopLeftRadius: 4,
    backgroundColor: colors.surface,
  },
  bubbleText: { fontSize: fontSize.body, color: colors.text, lineHeight: 22 },
  phoneFor: { fontSize: fontSize.caption, color: colors.textMuted },

  // from & when
  options: { gap: spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: md.outline,
  },
  optionOn: { borderColor: colors.primary, backgroundColor: md.meC },
  optionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  when: { flexDirection: 'row', padding: 4, gap: 4, borderRadius: 14, backgroundColor: md.surface2 },
  whenItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  nameInput: {
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    backgroundColor: md.surface1,
    fontSize: fontSize.body,
    color: colors.text,
  },

  // the bottom bar
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: md.outline,
    shadowColor: '#101840',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  barIn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
    maxWidth: 728,
    alignSelf: 'center',
  },
  barMain: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.xl,
    borderRadius: 24,
    backgroundColor: colors.primary,
  },
  sendOff: { opacity: 0.4 },
  sendText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
});
