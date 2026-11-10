import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { OBJECTION_LABEL } from '@/features/aiChance/api';
import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { MIcon, md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import {
  askSupervisor,
  getForecast,
  getImpact,
  getObjections,
  getPlaybook,
  getReport,
  getRuleStats,
  latestReports,
  makeReport,
  RULES,
  type Forecast,
  type PlaybookItem,
  type Report,
  type ReportBody,
  type RuleStat,
} from './api';

// =====================================================================
// 🤖 The supervisor's AI parts: today's tip, a one-to-one page, the
//   Reports tab (AI reports, targets and forecast, objections with the
//   college's answers, before / after, how often each rule was right)
//   and the Ask tab. The AI only reads and suggests.
// =====================================================================

const dayText = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** What the AI wrote: a summary, what went well, what to watch, what to do */
export function ReportBodyView({ body, compact }: { body: ReportBody; compact?: boolean }) {
  return (
    <View style={styles.body}>
      {!!body.summary && <Text style={styles.summary}>{body.summary}</Text>}
      {body.wins.length > 0 && <Bullets icon="✅" title={compact ? null : 'ভালো হয়েছে'} items={body.wins} />}
      {body.concerns.length > 0 && <Bullets icon="⚠️" title={compact ? null : 'নজর দিন'} items={body.concerns} />}
      {body.actions.length > 0 && <Bullets icon="👉" title={compact ? null : 'যা করবেন'} items={body.actions} />}
    </View>
  );
}

function Bullets({ icon, title, items }: { icon: string; title: string | null; items: string[] }) {
  return (
    <View style={styles.bullets}>
      {title && <Text style={styles.bulletsTitle}>{title}</Text>}
      {items.map((x, i) => (
        <Text key={i} style={styles.bullet}>
          {icon} {x}
        </Text>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------
// 💡 Today's tip (on the Today tab)
// ---------------------------------------------------------------------
export function TipCard() {
  const [tip, setTip] = useState<Report | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getReport('tip')
      .then((r) => live && setTip(r))
      .catch(() => live && setTip(null));
    return () => {
      live = false;
    };
  }, []);

  const make = async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      setTip(await makeReport('tip', null, refresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'তৈরি করা যায়নি।');
    } finally {
      setBusy(false);
    }
  };

  if (tip === undefined) return null;
  return (
    <View style={styles.tip}>
      <View style={styles.row}>
        <Text style={[styles.cardTitle, styles.flex]}>💡 আজকের পরামর্শ (AI)</Text>
        {tip && (
          <Tap onPress={() => make(true)} label="আবার তৈরি করুন" style={styles.iconBtn}>
            <MIcon name="refresh" size={20} color={md.onGoldC} />
          </Tap>
        )}
      </View>
      {tip ? (
        <ReportBodyView body={tip.body} compact />
      ) : (
        <>
          <Text style={styles.tipText}>আপনার গত ৭ দিনের কাজ দেখে আজ কী করলে ভালো হয়, ৩টা ছোট পরামর্শ।</Text>
          <Button title="পরামর্শ দেখুন" variant="secondary" onPress={() => make()} loading={busy} />
        </>
      )}
      {busy && tip && <ActivityIndicator color={md.onGoldC} />}
      {error && <Text style={ui.error}>{error}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------
// 🧑‍🏫 A one-to-one page about a person (Team Leads / admins)
// ---------------------------------------------------------------------
export function CoachSheet({ person, onClose }: { person: { id: string; name: string }; onClose: () => void }) {
  const [page, setPage] = useState<Report | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const make = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        setPage(await makeReport('coach', person.id, refresh));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'তৈরি করা যায়নি।');
        setPage((p) => p ?? null);
      } finally {
        setBusy(false);
      }
    },
    [person.id],
  );

  useEffect(() => {
    let live = true;
    getReport('coach', person.id)
      .then((r) => {
        if (!live) return;
        if (r) setPage(r);
        else make(false);
      })
      .catch((e) => live && (setError(e instanceof Error ? e.message : 'লোড করা যায়নি।'), setPage(null)));
    return () => {
      live = false;
    };
  }, [person.id, make]);

  return (
    <Sheet title={`🧑‍🏫 ${person.name}-এর সাথে আলোচনা`} onClose={onClose}>
      <Text style={ui.muted}>গত ১৪ দিন বনাম তার আগের ১৪ দিন। আলোচনা হোক সহায়ক, দোষারোপ নয়।</Text>
      {page ? <ReportBodyView body={page.body} /> : busy ? <ActivityIndicator color={colors.primary} /> : null}
      {error && <Text style={ui.error}>{error}</Text>}
      {page && (
        <Button title="🔄 আবার তৈরি করুন" variant="secondary" onPress={() => make(true)} loading={busy} fullWidth />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// 📊 The Reports tab (Team Leads / admins)
// ---------------------------------------------------------------------
export function ReportsTab({ admin }: { admin: boolean }) {
  const [reports, setReports] = useState<{ daily: Report | null; weekly: Report | null } | null>(null);
  const [which, setWhich] = useState<'daily' | 'weekly'>('daily');
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [objections, setObjections] = useState<{ kind: string; leads: number }[] | null>(null);
  const [playbook, setPlaybook] = useState<PlaybookItem[]>([]);
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof getImpact>> | null>(null);
  const [rules, setRules] = useState<RuleStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const fail = (e: unknown) => live && setError(e instanceof Error ? e.message : 'লোড করা যায়নি।');
    latestReports()
      .then((r) => live && setReports(r))
      .catch(fail);
    getForecast()
      .then((f) => live && setForecast(f))
      .catch(fail);
    getObjections(30)
      .then((o) => live && setObjections(o.kinds))
      .catch(() => live && setObjections([]));
    getPlaybook()
      .then((p) => live && setPlaybook(p))
      .catch(() => undefined);
    if (admin) {
      getImpact()
        .then((i) => live && setImpact(i))
        .catch(() => undefined);
      getRuleStats(30)
        .then((r) => live && setRules(r))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [admin]);

  const shown = reports ? reports[which] : null;
  const maxObj = Math.max(1, ...(objections ?? []).map((o) => o.leads));

  return (
    <View style={styles.tabBody}>
      {error && <Text style={ui.error}>{error}</Text>}

      {/* the AI's report */}
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={[styles.cardTitle, styles.flex]}>🧠 AI রিপোর্ট</Text>
          <Chip text="দিনের" on={which === 'daily'} onPress={() => setWhich('daily')} />
          <Chip text="সপ্তাহের" on={which === 'weekly'} onPress={() => setWhich('weekly')} />
        </View>
        {reports === null ? (
          <ActivityIndicator color={colors.primary} />
        ) : shown ? (
          <>
            <Text style={ui.muted}>{dayText(shown.day)}</Text>
            <ReportBodyView body={shown.body} />
          </>
        ) : (
          <Text style={ui.muted}>
            {which === 'daily'
              ? 'প্রতিদিন কাজ শেষের পর AI রিপোর্ট লেখে। প্রথমটা আজ রাতে আসবে।'
              : 'সপ্তাহের রিপোর্ট সপ্তাহে একবার আসে (Settings → Supervisor-এ দিন ঠিক করা যায়)।'}
          </Text>
        )}
      </View>

      {/* targets and the forecast */}
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={[styles.cardTitle, styles.flex]}>🎯 এই মাসের লক্ষ্য ও পূর্বাভাস</Text>
          {admin && (
            <Tap
              onPress={() => router.push('/settings/supervisor-targets' as Href)}
              label="লক্ষ্য ঠিক করুন"
              style={styles.link}
            >
              <Text style={styles.linkText}>লক্ষ্য ›</Text>
            </Tap>
          )}
        </View>
        {forecast === null ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <>
            <Text style={ui.muted}>
              {forecast.days_past}/{forecast.days} দিন গেছে · মোট ভর্তি {forecast.total.admitted}
              {forecast.total.target ? ` / লক্ষ্য ${forecast.total.target}` : ''}
              {forecast.total.pace != null ? ` · এই হারে মাস শেষে ~${forecast.total.pace}` : ''}
            </Text>
            {forecast.courses
              .filter((c) => c.target || c.admitted || c.hot_open)
              .map((c) => {
                const pct = c.target ? Math.min(100, Math.round((c.admitted / c.target) * 100)) : 0;
                const behind = c.target != null && c.pace != null && c.pace < c.target;
                return (
                  <View key={c.course_id} style={styles.fc}>
                    <View style={styles.row}>
                      <Text style={[styles.fcName, styles.flex]} numberOfLines={1}>
                        {c.name}
                      </Text>
                      <Text style={[styles.fcNum, behind && styles.bad]}>
                        {c.admitted}
                        {c.target != null ? ` / ${c.target}` : ''}
                      </Text>
                    </View>
                    {c.target != null && (
                      <View style={styles.bar}>
                        <View
                          style={[
                            styles.barFill,
                            { width: `${pct}%`, backgroundColor: behind ? md.onWarnC : md.onOkC },
                          ]}
                        />
                      </View>
                    )}
                    <Text style={ui.muted}>
                      {[
                        c.pace != null ? `এই হারে ~${c.pace}` : null,
                        c.need_per_day != null && c.need_per_day > 0 ? `দিনে ${c.need_per_day} লাগবে` : null,
                        c.hot_open ? `🔥 ${c.hot_open} সম্ভাবনাময়` : null,
                        c.ai_expected ? `AI chance যোগফল ~${c.ai_expected}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                );
              })}
            {forecast.courses.every((c) => c.target == null) && (
              <Text style={ui.muted}>কোনো লক্ষ্য দেওয়া নেই{admin ? ' — “লক্ষ্য ›” থেকে দিন।' : '।'}</Text>
            )}
          </>
        )}
      </View>

      {/* objections, with the college's answers */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>💬 গত ৩০ দিনের আপত্তি</Text>
        {objections === null ? (
          <ActivityIndicator color={colors.primary} />
        ) : objections.length === 0 ? (
          <Text style={ui.muted}>এখনো কোনো আপত্তি ধরা পড়েনি (AI note পড়া শুরু করলে আসবে)।</Text>
        ) : (
          objections.map((o) => {
            const answer = playbook.find((p) => p.kind === o.kind)?.answer;
            return (
              <View key={o.kind} style={styles.obj}>
                <View style={styles.row}>
                  <Text style={[styles.fcName, styles.flex]}>{OBJECTION_LABEL[o.kind] ?? o.kind}</Text>
                  <Text style={styles.fcNum}>{o.leads} জন</Text>
                </View>
                <View style={styles.bar}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${Math.round((o.leads / maxObj) * 100)}%`, backgroundColor: md.onPrimaryC },
                    ]}
                  />
                </View>
                {!!answer && <Text style={styles.answer}>📚 {answer}</Text>}
              </View>
            );
          })
        )}
        {admin && (
          <Tap
            onPress={() => router.push('/settings/supervisor-playbook' as Href)}
            label="উত্তর ভান্ডার"
            style={styles.link}
          >
            <Text style={styles.linkText}>📚 আপত্তির উত্তর লিখুন ›</Text>
          </Tap>
        )}
      </View>

      {/* before / after (admins) */}
      {admin && impact && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📈 সুপারভাইজারের আগে ও পরে</Text>
          <Text style={ui.muted}>
            চালু হয়েছে {dayText(impact.started_at)} · পরের {impact.days_after} দিন বনাম আগের ৩০ দিন
            {impact.days_after < 7 ? ' (এখনো কম দিন, মিলিয়ে দেখতে সময় লাগবে)' : ''}
          </Text>
          <Compare
            label="নতুন lead-এ প্রথম কল (মিনিট)"
            before={impact.before.first_call_min}
            after={impact.after.first_call_min}
            lowerBetter
          />
          <Compare
            label="সময়মতো follow-up (%)"
            before={impact.before.followups_on_time_pct}
            after={impact.after.followups_on_time_pct}
          />
          <Compare
            label="সপ্তাহে ভর্তি"
            before={impact.before.admitted_per_week}
            after={impact.after.admitted_per_week}
          />
          <Compare label="দিনে কল" before={impact.before.calls_per_day} after={impact.after.calls_per_day} />
        </View>
      )}

      {/* how often each rule was right (admins) */}
      {admin && rules && rules.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🎯 নিয়মগুলো কতটা ঠিক (৩০ দিন)</Text>
          <Text style={ui.muted}>“ভুল” বেশি হলে সেই নিয়মের সংখ্যা Settings-এ বদলান বা বন্ধ করুন।</Text>
          {rules.map((r) => {
            const meta = RULES.find((x) => x.key === r.rule);
            return (
              <View key={r.rule} style={styles.row}>
                <Text style={[styles.ruleName, styles.flex]} numberOfLines={1}>
                  {meta ? `${meta.icon} ${meta.title}` : r.rule}
                </Text>
                <Text style={[styles.ruleNum, (r.wrong_pct ?? 0) >= 30 && styles.bad]}>
                  {r.raised} · ✅{r.done + r.fixed} · ❌{r.wrong}
                  {r.wrong_pct != null ? ` (${r.wrong_pct}%)` : ''}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function Compare({
  label,
  before,
  after,
  lowerBetter,
}: {
  label: string;
  before: number | null;
  after: number | null;
  lowerBetter?: boolean;
}) {
  const better = before != null && after != null && (lowerBetter ? after < before : after > before);
  const worse = before != null && after != null && (lowerBetter ? after > before : after < before);
  return (
    <View style={styles.row}>
      <Text style={[styles.ruleName, styles.flex]}>{label}</Text>
      <Text style={[styles.ruleNum, better && styles.good, worse && styles.bad]}>
        {before ?? '–'} → {after ?? '–'}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------
// 💬 Ask the supervisor
// ---------------------------------------------------------------------
const SUGGEST_MANAGER = [
  'এই সপ্তাহে কার কাজ সবচেয়ে কমেছে, কেন?',
  'কোন আপত্তি সবচেয়ে বেশি, কীভাবে সামলাব?',
  'এই মাসের লক্ষ্য পূরণ হবে?',
  'Follow-up সময়মতো হচ্ছে না কার?',
];
const SUGGEST_CALLER = [
  'গত মাসের তুলনায় আমার কাজ কেমন?',
  'আমার lead-রা কোন আপত্তি বেশি দেয়?',
  'ভর্তি বাড়াতে আমি কী করতে পারি?',
];

type Qa = { q: string; a?: string; points?: string[]; error?: string };

export function AskTab({ manager }: { manager: boolean }) {
  const [text, setText] = useState('');
  const [list, setList] = useState<Qa[]>([]);
  const [busy, setBusy] = useState(false);

  const go = async (q: string) => {
    const question = q.trim();
    if (question.length < 3 || busy) return;
    setBusy(true);
    setText('');
    setList((l) => [{ q: question }, ...l]);
    try {
      const r = await askSupervisor(question);
      setList((l) => l.map((x, i) => (i === 0 ? { ...x, a: r.answer, points: r.points } : x)));
    } catch (e) {
      setList((l) =>
        l.map((x, i) => (i === 0 ? { ...x, error: e instanceof Error ? e.message : 'উত্তর পাওয়া যায়নি।' } : x)),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.tabBody}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>💬 সুপারভাইজারকে জিজ্ঞেস করুন</Text>
        <Text style={ui.muted}>
          {manager ? 'আপনার টিমের' : 'আপনার নিজের'} গত ৩০ দিনের সংখ্যা দেখে AI উত্তর দেয় (দিনে ২০টা প্রশ্ন)।
        </Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="যেমন: এই সপ্তাহে কার কল কম?"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          multiline
          maxLength={300}
          onSubmitEditing={() => go(text)}
        />
        <Button
          title="জিজ্ঞেস করুন"
          onPress={() => go(text)}
          loading={busy}
          disabled={text.trim().length < 3}
          fullWidth
        />
        <View style={ui.chips}>
          {(manager ? SUGGEST_MANAGER : SUGGEST_CALLER).map((s) => (
            <Chip key={s} text={s} on={false} onPress={() => go(s)} />
          ))}
        </View>
      </View>
      {list.map((x, i) => (
        <View key={`${i}-${x.q}`} style={styles.card}>
          <Text style={styles.q}>❓ {x.q}</Text>
          {x.a ? (
            <>
              <Text style={styles.summary}>{x.a}</Text>
              {(x.points ?? []).map((p, j) => (
                <Text key={j} style={styles.bullet}>
                  • {p}
                </Text>
              ))}
            </>
          ) : x.error ? (
            <Text style={ui.error}>{x.error}</Text>
          ) : (
            <ActivityIndicator color={colors.primary} />
          )}
        </View>
      ))}
    </View>
  );
}

/** A promise in a note: set the follow-up for that day in one tap */
export function promiseTime(at: string | undefined): Date {
  const when = at ? new Date(at) : new Date();
  // a day already passed: in an hour
  return when.getTime() > Date.now() + 15 * 60_000 ? when : new Date(Date.now() + 60 * 60_000);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tabBody: { gap: spacing.md },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, backgroundColor: md.surface1 },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  tip: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: md.goldC,
    marginBottom: spacing.sm,
  },
  tipText: { fontSize: fontSize.small, color: md.onGoldC },
  iconBtn: { padding: 4, borderRadius: 16, overflow: 'hidden' },
  body: { gap: spacing.sm },
  summary: { fontSize: fontSize.body, color: colors.text, lineHeight: 22 },
  bullets: { gap: 2 },
  bulletsTitle: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary, letterSpacing: 0.4 },
  bullet: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  link: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: 14,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  linkText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  fc: { gap: 4, paddingVertical: 4 },
  fcName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  fcNum: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  bar: { height: 6, borderRadius: 3, backgroundColor: md.surface2, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  bad: { color: md.onErrorC },
  good: { color: md.onOkC },
  obj: { gap: 4, paddingVertical: 4 },
  answer: { fontSize: fontSize.small, color: md.primarySub },
  ruleName: { fontSize: fontSize.small, color: colors.text },
  ruleNum: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    minHeight: 64,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
    textAlignVertical: 'top',
    backgroundColor: colors.background,
  },
  q: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
