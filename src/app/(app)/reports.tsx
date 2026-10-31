import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers } from '@/features/leads/api';
import {
  DEFAULT_REPORTS,
  PERIODS,
  canSeeReports,
  formatTalk,
  getCallHeatmap,
  getLeadReport,
  getCollectionReport,
  getReportSettings,
  getTemplateReport,
  getWhatsAppReport,
  pct,
  periodRange,
  type HeatCell,
  type LeadReport,
  type PipelineStep,
  type Period,
  type CollectionReport,
  type ReportSettings,
  type TemplateReport,
  type WhatsAppReport,
} from '@/features/reports/api';
import { BarList, Heatmap, PipelineBars, StatTile } from '@/features/reports/charts';
import { getLeadsAdded, type LeadsAddedRow } from '@/features/leads/added';
import { listCourses } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

type Option = { id: string; name: string };

const taka = (n: number) => `৳${Math.round(n).toLocaleString('en-IN')}`;

export default function ReportsScreen() {
  const { profile, hasPermission, sharedMode } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  // Managers pick a person; others only ever see their own leads
  const seesOthers = sharedMode || hasPermission('leads.view_all') || hasPermission('leads.view_team');

  const [settings, setSettings] = useState<ReportSettings>(DEFAULT_REPORTS);
  const [ready, setReady] = useState(false);

  const [period, setPeriod] = useState<Period>('month');
  // Pipeline now: every lead (like the board) or only the ones added in the period
  const [pipeMode, setPipeMode] = useState<'all' | 'period'>('all');
  const [person, setPerson] = useState<Option | null>(null);
  const [course, setCourse] = useState<Option | null>(null);
  const [people, setPeople] = useState<Option[]>([]);
  const [courses, setCourses] = useState<Option[]>([]);
  const [picker, setPicker] = useState<'person' | 'course' | null>(null);

  const [report, setReport] = useState<LeadReport | null>(null);
  const [heat, setHeat] = useState<HeatCell[]>([]);
  const [wa, setWa] = useState<WhatsAppReport | null>(null);
  const [tpl, setTpl] = useState<TemplateReport | null>(null);
  const [money, setMoney] = useState<CollectionReport | null>(null);
  const [added, setAdded] = useState<LeadsAddedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getReportSettings()
      .then(setSettings)
      .finally(() => setReady(true));
    listCourses()
      .then((c) => setCourses(c.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setCourses([]));
    if (seesOthers) {
      listAssignableUsers(hasPermission('leads.view_all') || sharedMode ? {} : { teamLeadId: profile?.id })
        .then((u) => setPeople(u.map((p) => ({ id: p.id, name: p.full_name ?? 'No name' }))))
        .catch(() => setPeople([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const range = periodRange(period);
  const show = settings.sections;

  const load = useCallback(async () => {
    const q = { ...periodRange(period), userId: person?.id ?? null, courseId: course?.id ?? null };
    try {
      setError(null);
      const [r, h, w, t, c, a] = await Promise.all([
        getLeadReport(q, show.team),
        show.heatmap ? getCallHeatmap(q) : Promise.resolve([]),
        show.whatsapp ? getWhatsAppReport(q) : Promise.resolve(null),
        // An older database without the report: just leave the card out
        show.templates ? getTemplateReport(q).catch(() => null) : Promise.resolve(null),
        show.collection ? getCollectionReport(q).catch(() => null) : Promise.resolve(null),
        getLeadsAdded(q.from, q.to).catch(() => [] as LeadsAddedRow[]),
      ]);
      setMoney(c);
      setAdded(person ? a.filter((x) => x.user_id === person.id) : a);
      setReport(r);
      setHeat(h);
      setWa(w);
      setTpl(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the report.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period, person, course, show.team, show.heatmap, show.whatsapp, show.templates, show.collection]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    load();
  }, [ready, load]);

  // Pipeline bar → the leads now in that stage
  const openStage = (step: PipelineStep) => {
    router.push({ pathname: '/leads', params: { stage: step.stage_id } } as unknown as Href);
  };

  // --- states ----------------------------------------------------------
  if (!ready) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Reports' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (!canSeeReports(settings, profile, isAdmin)) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Reports' }} />
        <Text style={styles.muted}>Reports are not turned on for you. (Settings → Reports)</Text>
      </View>
    );
  }

  const s = report?.summary;
  const v = report?.visits;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Reports' }} />

      {/* Period */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsScroll}
        contentContainerStyle={styles.chips}
      >
        {PERIODS.map((p) => {
          const on = p.value === period;
          return (
            <Pressable
              key={p.value}
              onPress={() => setPeriod(p.value)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Person / course */}
      <View style={styles.pickRow}>
        {seesOthers && (
          <PickButton
            icon="person"
            label={person?.name ?? 'Whole team'}
            on={!!person}
            onPress={() => setPicker('person')}
          />
        )}
        <PickButton icon="school" label={course?.name ?? 'All courses'} on={!!course} onPress={() => setPicker('course')} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
      >
        <Text style={styles.rangeText}>
          {range.from} → {range.to}
          {!seesOthers ? ' · your leads' : ''}
        </Text>

        {loading || !report ? (
          error ? (
            <Text style={styles.error}>{error}</Text>
          ) : (
            <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
          )
        ) : (
          <>
            {error && <Text style={styles.error}>{error}</Text>}

            {/* ① Summary */}
            {show.summary && s && (
              <Card title="Summary">
                <View style={styles.tiles}>
                  <StatTile label="New leads" value={String(s.new_leads)} />
                  <StatTile label="Contacted" value={pct(s.contacted, s.new_leads)} hint={`${s.contacted} of ${s.new_leads}`} />
                  <StatTile label="Admitted" value={String(s.admitted)} hint="in this period" />
                  <StatTile
                    label="Conversion"
                    value={pct(s.cohort_admitted, s.new_leads)}
                    hint={`${s.cohort_admitted} of the new leads`}
                  />
                  <StatTile label="Lost" value={String(s.lost)} hint="in this period" />
                  <StatTile
                    label="Days to admit"
                    value={s.avg_days_to_admit != null ? String(s.avg_days_to_admit) : '—'}
                    hint="on average"
                  />
                </View>
              </Card>
            )}

            {/* ② Pipeline now (same numbers as the board) */}
            {show.funnel && (
              <Card title="📋 Pipeline now" subtitle="How many leads are in each stage right now">
                <View style={styles.segment}>
                  {(['all', 'period'] as const).map((m) => {
                    const on = pipeMode === m;
                    return (
                      <Pressable
                        key={m}
                        onPress={() => setPipeMode(m)}
                        style={[styles.segBtn, on && styles.segBtnOn]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                      >
                        <Text style={[styles.segText, on && styles.segTextOn]}>
                          {m === 'all' ? 'All leads' : 'Added in this period'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {report.pipeline.every((p) => p[pipeMode] === 0) ? (
                  <Text style={styles.empty}>
                    {pipeMode === 'all' ? 'No leads yet.' : 'No new leads in this period.'}
                  </Text>
                ) : (
                  <PipelineBars steps={report.pipeline} mode={pipeMode} onPressStep={openStage} />
                )}
                <Text style={styles.hint}>
                  Each lead counts once, in the stage it is in now. “All leads” matches the board (without filters).
                  Tap a stage to see its leads.
                </Text>
              </Card>
            )}

            {/* ③ Campus visits */}
            {show.visits && v && (
              <Card title="🏫 Campus visits" subtitle="Leads added in this period">
                <View style={styles.tiles}>
                  <StatTile label="Visited" value={String(v.visited)} />
                  <StatTile label="Didn’t come" value={String(v.missed)} />
                  <StatTile label="Planned now" value={String(v.planned_now)} />
                </View>
                <BarList
                  empty="No leads in this period."
                  rows={[
                    {
                      key: 'visited',
                      name: 'Admitted after a visit',
                      value: v.visited_admitted,
                      right: pct(v.visited_admitted, v.visited),
                    },
                    {
                      key: 'not',
                      name: 'Admitted without a visit',
                      value: v.not_visited_admitted,
                      right: pct(v.not_visited_admitted, v.not_visited),
                    },
                  ]}
                />
                <Text style={styles.hint}>% = of the leads who visited / didn’t visit.</Text>
              </Card>
            )}

            {/* ④ Sources and campaigns */}
            {show.sources && (
              <Card title="📣 Sources" subtitle="Leads added in this period · admitted · conversion">
                <BarList
                  empty="No new leads in this period."
                  rows={report.sources.map((x) => ({
                    key: x.name,
                    name: x.name,
                    value: x.leads,
                    right: `🎓 ${x.admitted ?? 0} · ${pct(x.admitted ?? 0, x.leads)}`,
                  }))}
                />
                {report.campaigns.length > 0 && (
                  <>
                    <Text style={styles.subTitle}>Campaigns</Text>
                    <BarList
                      empty=""
                      rows={report.campaigns.map((x) => ({
                        key: x.name,
                        name: x.name,
                        value: x.leads,
                        right: `🎓 ${x.admitted ?? 0} · ${pct(x.admitted ?? 0, x.leads)}`,
                      }))}
                    />
                  </>
                )}
              </Card>
            )}

            {/* ⑤ Team */}
            {show.team && seesOthers && (
              <Card title="👥 Team" subtitle="New leads given · calls · talk time · admitted">
                {report.team.length === 0 ? (
                  <Text style={styles.empty}>No one has leads or calls in this period.</Text>
                ) : (
                  report.team.map((t) => (
                    <View key={t.user_id} style={styles.person}>
                      <View style={styles.personTop}>
                        <Text style={styles.personName} numberOfLines={1}>
                          {t.name ?? 'No name'}
                        </Text>
                        <Text style={styles.personAdmitted}>🎓 {t.admitted}</Text>
                      </View>
                      <Text style={styles.personLine}>
                        {t.leads} new leads · 📞 {t.calls} calls ({pct(t.connected, t.calls)} answered) · ⏱{' '}
                        {formatTalk(t.talk_sec)}
                      </Text>
                      {t.overdue > 0 && <Text style={styles.personOverdue}>⚠ {t.overdue} calls overdue now</Text>}
                    </View>
                  ))
                )}
              </Card>
            )}

            {/* ➕ Who added the leads (tap one: those leads) */}
            <Card title="➕ Leads added by" subtitle="Leads each person added in this period (imported ones too)">
              <BarList
                empty="No leads added in this period."
                rows={added.map((x) => ({
                  key: x.user_id,
                  name: x.name ?? 'No name',
                  value: x.total,
                  right: x.imported > 0 ? `${x.imported} imported` : undefined,
                }))}
              />
              {added.length > 0 && (
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/leads',
                      params: { addedDay: 'custom', addedFrom: range.from, addedTo: range.to, ...(person ? { addedBy: person.id } : {}) },
                    } as unknown as Href)
                  }
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text style={styles.addedLink}>Show these leads ›</Text>
                </Pressable>
              )}
            </Card>

            {/* 💬 WhatsApp (apart from phone calls) */}
            {show.whatsapp && wa && (
              <Card title="💬 WhatsApp" subtitle="WhatsApp calls and messages in this period (not in the phone call numbers)">
                {wa.totals.calls + wa.totals.messages_sent + wa.totals.messages_received === 0 ? (
                  <Text style={styles.empty}>No WhatsApp calls or messages saved in this period.</Text>
                ) : (
                  <>
                    <View style={styles.tiles}>
                      <StatTile
                        label="Calls"
                        value={String(wa.totals.calls)}
                        hint={`${wa.totals.outgoing} out · ${wa.totals.incoming} in${wa.totals.video ? ` · ${wa.totals.video} video` : ''}`}
                      />
                      <StatTile
                        label="Answered"
                        value={pct(wa.totals.connected, wa.totals.calls)}
                        hint={`${wa.totals.connected} of ${wa.totals.calls}`}
                      />
                      <StatTile label="Talk time" value={formatTalk(wa.totals.talk_sec)} />
                      <StatTile label="Missed" value={String(wa.totals.missed)} />
                      <StatTile
                        label="Messages"
                        value={String(wa.totals.messages_sent + wa.totals.messages_received)}
                        hint={`${wa.totals.messages_sent} sent · ${wa.totals.messages_received} received`}
                      />
                      <StatTile label="Leads" value={String(wa.totals.leads)} hint="talked to on WhatsApp" />
                    </View>

                    {seesOthers &&
                      wa.people.map((p) => (
                        <View key={p.user_id} style={styles.person}>
                          <View style={styles.personTop}>
                            <Text style={styles.personName} numberOfLines={1}>
                              {p.full_name ?? 'No name'}
                            </Text>
                          </View>
                          <Text style={styles.personLine}>
                            💬 {p.calls} calls ({pct(p.connected, p.calls)} answered) · ⏱ {formatTalk(p.talk_sec)} ·{' '}
                            {p.messages} messages · {p.leads} leads
                          </Text>
                        </View>
                      ))}

                    <Pressable onPress={() => router.push('/whatsapp' as Href)} hitSlop={8} accessibilityRole="link">
                      <Text style={styles.waLink}>See every WhatsApp call and message ›</Text>
                    </Pressable>
                  </>
                )}
              </Card>
            )}

            {/* 💵 Collection */}
            {show.collection && money && (
              <Card title="💵 Collection" subtitle="Money taken in this period; due and late are as of now">
                <View style={styles.tiles}>
                  <StatTile
                    label="Collected"
                    value={taka(money.totals.collected)}
                    hint={`${money.totals.receipts} receipts · ${money.totals.students} students`}
                  />
                  {money.totals.refunded > 0 && <StatTile label="Refunded" value={taka(money.totals.refunded)} />}
                  {money.totals.refunded > 0 && <StatTile label="Net" value={taka(money.totals.net)} />}
                  <StatTile label="Due now" value={taka(money.due_now.due)} hint={`${money.due_now.with_due} students`} />
                  <StatTile
                    label="Late"
                    value={taka(money.due_now.late_amount)}
                    hint={`${money.due_now.late} students`}
                  />
                  <StatTile
                    label="Discounts"
                    value={taka(money.discounts.amount)}
                    hint={`${money.discounts.given} given · ${money.discounts.admitted}/${money.discounts.leads} admitted`}
                  />
                </View>

                {money.by_method.length > 0 && (
                  <>
                    <Text style={styles.subTitle}>By method</Text>
                    <BarList
                      empty=""
                      rows={money.by_method.map((m) => ({
                        key: m.method,
                        name: m.method,
                        value: Math.round(Number(m.amount)),
                        right: `${m.receipts}×`,
                      }))}
                    />
                  </>
                )}

                {seesOthers && money.by_person.length > 0 && (
                  <>
                    <Text style={styles.subTitle}>Taken by</Text>
                    <BarList
                      empty=""
                      rows={money.by_person.map((p) => ({
                        key: p.user_id ?? 'none',
                        name: p.full_name ?? 'No name',
                        value: Math.round(Number(p.amount)),
                        right: `${p.receipts}×`,
                      }))}
                    />
                  </>
                )}

                {money.discount_by.length > 0 && (
                  <>
                    <Text style={styles.subTitle}>Discounts approved by</Text>
                    {money.discount_by.map((d) => (
                      <Text key={d.user_id ?? 'none'} style={styles.personLine}>
                        {d.full_name ?? 'No name'}: {d.given} · {taka(Number(d.amount))}
                      </Text>
                    ))}
                  </>
                )}

                {money.voided.length > 0 && (
                  <>
                    <Text style={styles.subTitle}>✕ Void in this period</Text>
                    {money.voided.map((v) => (
                      <Pressable key={v.receipt_no} onPress={() => router.push(`/leads/${v.lead_id}` as Href)}>
                        <Text style={styles.personLine}>
                          {v.receipt_no} · {taka(Number(v.amount))} · {v.lead_name}
                          {v.void_reason ? ` · ${v.void_reason}` : ''}
                          {v.voided_by ? ` · by ${v.voided_by}` : ''}
                        </Text>
                      </Pressable>
                    ))}
                  </>
                )}
                <Pressable onPress={() => router.push('/students' as Href)} hitSlop={8} accessibilityRole="link">
                  <Text style={styles.waLink}>See students with money due ›</Text>
                </Pressable>
              </Card>
            )}

            {/* 📝 Message templates */}
            {show.templates && tpl && (
              <Card
                title="📝 Message templates"
                subtitle="Templates sent in this period, and what the leads did in the 7 days after"
              >
                {tpl.totals.sent === 0 ? (
                  <Text style={styles.empty}>No templates sent in this period.</Text>
                ) : (
                  <>
                    <View style={styles.tiles}>
                      <StatTile
                        label="Sent"
                        value={String(tpl.totals.sent)}
                        hint={`${tpl.totals.whatsapp} WhatsApp · ${tpl.totals.sms} SMS`}
                      />
                      <StatTile label="Leads" value={String(tpl.totals.leads)} hint={`${tpl.totals.edited} changed before sending`} />
                      <StatTile
                        label="Replied"
                        value={pct(tpl.totals.replied, tpl.totals.leads)}
                        hint={`${tpl.totals.replied} answered or wrote back`}
                      />
                      <StatTile
                        label="Moved on"
                        value={pct(tpl.totals.moved, tpl.totals.leads)}
                        hint={`${tpl.totals.moved} changed stage`}
                      />
                      <StatTile
                        label="Admitted"
                        value={pct(tpl.totals.admitted, tpl.totals.leads)}
                        hint={`${tpl.totals.admitted} within 7 days`}
                      />
                    </View>

                    <Text style={styles.subTitle}>By template</Text>
                    {tpl.templates.map((t) => (
                      <View key={t.id} style={styles.person}>
                        <View style={styles.personTop}>
                          <Text style={styles.personName} numberOfLines={1}>
                            {t.name}
                            {!t.is_shared && <Text style={styles.personLine}>  · personal</Text>}
                          </Text>
                          <Text style={styles.personAdmitted}>{t.sent}×</Text>
                        </View>
                        <Text style={styles.personLine}>
                          💬 {t.whatsapp} · ✉️ {t.sms} · {t.leads} leads · ↩ {pct(t.replied, t.leads)} replied · ➜{' '}
                          {pct(t.moved, t.leads)} moved · 🎓 {t.admitted} admitted
                        </Text>
                      </View>
                    ))}

                    {seesOthers && tpl.people.length > 0 && (
                      <>
                        <Text style={styles.subTitle}>By person</Text>
                        <BarList
                          empty=""
                          rows={tpl.people.map((p) => ({
                            key: p.user_id,
                            name: `${p.full_name ?? 'No name'}${p.top_template ? ` · ${p.top_template}` : ''}`,
                            value: p.sent,
                            right: `${p.leads} leads`,
                          }))}
                        />
                      </>
                    )}

                    {tpl.unused.length > 0 && (
                      <Text style={styles.hint}>Not sent in this period: {tpl.unused.join(', ')}</Text>
                    )}
                  </>
                )}
                <Pressable onPress={() => router.push('/templates' as Href)} hitSlop={8} accessibilityRole="link">
                  <Text style={styles.waLink}>Manage templates ›</Text>
                </Pressable>
              </Card>
            )}

            {/* ⑥ Lost */}
            {show.lost && (
              <Card title="✕ Why leads are lost" subtitle="Lost in this period">
                <BarList
                  empty="No leads lost in this period. 🎉"
                  rows={report.lost_reasons.map((x) => ({ key: x.name, name: x.name, value: x.leads }))}
                />
                {report.lost_from.length > 0 && (
                  <>
                    <Text style={styles.subTitle}>Lost from stage</Text>
                    <BarList
                      empty=""
                      rows={report.lost_from.map((x) => ({ key: x.name, name: x.name, value: x.leads }))}
                    />
                  </>
                )}
              </Card>
            )}

            {/* ⑦ Best time to call */}
            {show.heatmap && (
              <Card title="🕐 Best time to call" subtitle="Calls from the app: share answered by day and hour">
                <Heatmap cells={heat} />
                {course && <Text style={styles.hint}>Calls are not split by course.</Text>}
              </Card>
            )}
          </>
        )}
      </ScrollView>

      <PickerSheet
        visible={picker !== null}
        title={picker === 'person' ? 'Whose leads?' : 'Which course?'}
        allLabel={picker === 'person' ? 'Whole team' : 'All courses'}
        options={picker === 'person' ? people : courses}
        value={picker === 'person' ? person?.id ?? null : course?.id ?? null}
        onClose={() => setPicker(null)}
        onPick={(o) => {
          if (picker === 'person') setPerson(o);
          else setCourse(o);
          setPicker(null);
        }}
      />
    </View>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View>
        <Text style={styles.cardTitle}>{title}</Text>
        {subtitle && <Text style={styles.cardSubtitle}>{subtitle}</Text>}
      </View>
      {children}
    </View>
  );
}

function PickButton({
  icon,
  label,
  on,
  onPress,
}: {
  icon: 'person' | 'school';
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pick, on && styles.pickOn, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={14} color={on ? colors.primary : colors.textMuted} />
      <Text style={[styles.pickText, on && styles.pickTextOn]} numberOfLines={1}>
        {label}
      </Text>
      <Ionicons name="chevron-down" size={12} color={on ? colors.primary : colors.textMuted} />
    </Pressable>
  );
}

function PickerSheet({
  visible,
  title,
  allLabel,
  options,
  value,
  onClose,
  onPick,
}: {
  visible: boolean;
  title: string;
  allLabel: string;
  options: Option[];
  value: string | null;
  onClose: () => void;
  onPick: (o: Option | null) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView contentContainerStyle={styles.sheetList}>
            {[{ id: '', name: allLabel }, ...options].map((o) => {
              const on = (o.id || null) === value;
              return (
                <Pressable
                  key={o.id || 'all'}
                  onPress={() => onPick(o.id ? o : null)}
                  style={({ pressed }) => [styles.sheetRow, on && styles.sheetRowOn, pressed && styles.pressed]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.sheetRowText, on && styles.sheetRowTextOn]}>{o.name}</Text>
                  {on && <Text style={styles.tick}>✓</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  loader: { paddingVertical: spacing.xxl },
  error: { fontSize: fontSize.small, color: colors.danger, textAlign: 'center' },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.md },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },

  chipsScroll: { flexGrow: 0, flexShrink: 0 },
  chips: { flexDirection: 'row', gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.xl, paddingTop: spacing.md },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },

  pickRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  pick: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pickOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  pickText: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  pickTextOn: { color: colors.primary },

  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  rangeText: { fontSize: fontSize.caption, color: colors.textMuted },
  addedLink: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: spacing.sm },

  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  cardSubtitle: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  subTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text, marginTop: spacing.sm },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  waLink: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: spacing.sm },
  segment: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  segBtn: { paddingVertical: 6, paddingHorizontal: spacing.md },
  segBtnOn: { backgroundColor: colors.text },
  segText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  segTextOn: { color: colors.surface },

  person: { gap: 2, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  personTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  personName: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  personAdmitted: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  personLine: { fontSize: fontSize.caption, color: colors.textMuted },
  personOverdue: { fontSize: fontSize.caption, color: colors.danger, fontWeight: fontWeight.semibold },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '75%',
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
  sheetTitle: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  sheetList: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sheetRowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  sheetRowText: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  sheetRowTextOn: { color: colors.primary },
  tick: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
});
