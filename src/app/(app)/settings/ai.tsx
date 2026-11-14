import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import {
  getAiCreditOverview,
  getAiCreditSettings,
  getAiKeyStatus,
  queueAllAdmissions,
  removeAiKey,
  saveAiCreditSettings,
  saveAiKey,
  testAiKey,
  wakeAiCredit,
  type AiCreditOverview,
  type AiCreditSettings,
  type AiKeyStatus,
} from '@/features/aiCredit/api';
import {
  getAiChanceOverview,
  getAiChanceSettings,
  saveAiChanceSettings,
  wakeAiChance,
  type AiChanceOverview,
  type AiChanceSettings,
} from '@/features/aiChance/api';
import { ChanceControls } from '@/features/aiChance/ChanceControls';
import {
  getAiProviders,
  getAiProviderStats,
  getGeminiKeyStatus,
  saveAiProviders,
  type AiProviderStats,
  type AiProvidersSetting,
  type GeminiKeyStatus,
} from '@/features/aiProviders/api';
import {
  ClaudeModelPicker,
  GeminiCard,
  LastProblem,
  ModePicker,
  ProviderNumbers,
} from '@/features/aiProviders/AiProvidersSection';
import { useAuth } from '@/features/auth/AuthProvider';
import { listRoles, type RoleOption } from '@/features/users/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🤖 Settings → AI (admins)
//   · Claude and Gemini (free): an on/off switch for each, their keys
//     (paste, Test, change or remove any time; only the server can read
//     them; here only "sk-ant-…abcd" / "AIza…abcd" is shown), the Gemini
//     model, and which AI each feature uses
//   · admission credit: on/off, who sees it, how far back, extra rules
//   · work out every past admission once
// =====================================================================

type Person = { id: string; full_name: string | null; role_key: string | null };

const WINDOWS = [60, 90, 180, 365];

function confirm(title: string, text: string, ok: string, run: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${text}`)) run();
    return;
  }
  Alert.alert(title, text, [
    { text: 'Cancel', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: run },
  ]);
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';

export default function AiSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [s, setS] = useState<AiCreditSettings | null>(null);
  const [key, setKey] = useState<AiKeyStatus | null>(null);
  const [ov, setOv] = useState<AiCreditOverview | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // 🔮 chance of admission
  const [cs, setCs] = useState<AiChanceSettings | null>(null);
  const [cov, setCov] = useState<AiChanceOverview | null>(null);
  // 🤖 the two AIs
  const [prov, setProv] = useState<AiProvidersSetting | null>(null);
  const [gkey, setGkey] = useState<GeminiKeyStatus | null>(null);
  const [pstats, setPstats] = useState<AiProviderStats | null>(null);

  const loadStatus = useCallback(() => {
    getAiKeyStatus()
      .then(setKey)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
    getAiCreditOverview()
      .then(setOv)
      .catch(() => undefined);
    getAiChanceOverview()
      .then(setCov)
      .catch(() => undefined);
    getGeminiKeyStatus()
      .then(setGkey)
      .catch(() => undefined);
    getAiProviderStats()
      .then(setPstats)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!canManage) return;
    getAiCreditSettings().then(setS);
    getAiChanceSettings().then(setCs);
    getAiProviders().then(setProv);
    loadStatus();
    listRoles()
      .then(setRoles)
      .catch(() => undefined);
    supabase
      .from('profiles')
      .select('id, full_name, role_key')
      .eq('is_active', true)
      .order('full_name')
      .then(({ data }) => setPeople((data ?? []) as Person[]));
  }, [canManage, loadStatus]);

  const patch = (p: Partial<AiCreditSettings>) => {
    setS((now) => (now ? { ...now, ...p } : now));
    setDirty(true);
  };
  const patchC = (p: Partial<AiChanceSettings>) => {
    setCs((now) => (now ? { ...now, ...p } : now));
    setDirty(true);
  };
  const patchProv = (f: (p: AiProvidersSetting) => AiProvidersSetting) => {
    setProv((now) => (now ? f(now) : now));
    setDirty(true);
  };
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const run = async (what: string, job: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const onSaveKey = () =>
    run('key', async () => {
      await saveAiKey(newKey);
      setNewKey('');
      // check it at once
      const r = await testAiKey();
      setNote(r.ok ? { ok: true, text: '✅ Saved. The key works.' } : { ok: false, text: `Saved, but: ${r.error}` });
      loadStatus();
      if (r.ok) {
        wakeAiCredit();
        wakeAiChance();
      }
    });

  const onTest = () =>
    run('test', async () => {
      const r = await testAiKey();
      setNote(r.ok ? { ok: true, text: '✅ The key works.' } : { ok: false, text: r.error ?? 'It did not work.' });
      loadStatus();
      if (r.ok) {
        wakeAiCredit();
        wakeAiChance();
      }
    });

  const onRemove = () =>
    confirm('Remove the key?', 'The AI stops until a new key is saved. Shares already worked out stay.', 'Remove', () =>
      run('remove', async () => {
        await removeAiKey();
        loadStatus();
      }),
    );

  const onQueueAll = () =>
    run('all', async () => {
      const n = await queueAllAdmissions();
      setNote({
        ok: true,
        text:
          n > 0
            ? `${n} admissions are in the queue. The server works through them in the background (a few a minute); you can close this screen.`
            : 'Nothing new: every admission is worked out or already waiting.',
      });
      loadStatus();
    });

  const onSave = () =>
    run('save', async () => {
      if (!s) return;
      if (prov) await saveAiProviders(prov);
      if (cs) await saveAiChanceSettings(cs);
      await saveAiCreditSettings(s);
      setDirty(false);
      // an AI switched on / a new mode: start on what is waiting
      wakeAiCredit();
      wakeAiChance();
      router.back();
    });

  if (!canManage)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'AI' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  if (!s || !cs || !prov)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'AI' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );

  // can a feature run now? (the server's view: an AI on, with a key, model, not resting)
  const chanceReady = pstats ? pstats.plan.chance.providers.length > 0 : !!key?.set;
  const creditReady = pstats ? pstats.plan.credit.providers.length > 0 : !!key?.set;

  const keyLine = !key
    ? 'Checking…'
    : !key.set
      ? 'No key saved yet.'
      : key.last_error
        ? `⚠️ ${key.last_error}`
        : key.last_ok_at
          ? `✅ Working (last used ${when(key.last_ok_at)})`
          : 'Saved, not checked yet. Press Test.';

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'AI' }} />
      <Text style={styles.intro}>
        When a lead is marked Admitted, the AI (Claude or Gemini) reads the lead’s whole story — who called, how many
        times, how many minutes, what each note says, visits, fee talks, papers, hand-overs — and shares the admission
        out among the people who worked on it, with a reason for each. Credits use these shares for “Admitted”. It all
        happens on the server in the background: nothing in the app waits for it. Names and phone numbers are not sent
        to the AI.
      </Text>

      {/* 🔑 Claude */}
      <Text style={styles.sectionLabel}>CLAUDE</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Claude (paid)</Text>
            <Text style={styles.rowText}>
              {prov.claude.on
                ? 'On: the features set to use Claude below use it (paid from your Claude API credit).'
                : 'Off: Claude is never used and its key is never sent anywhere.'}
            </Text>
          </View>
          <Switch
            value={prov.claude.on}
            onValueChange={(v) => patchProv((p) => ({ ...p, claude: { ...p.claude, on: v } }))}
            accessibilityLabel="Claude on or off"
          />
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>{key?.set ? key.hint : 'Not set'}</Text>
            <Text style={[styles.rowText, key?.last_error ? styles.bad : null]}>{keyLine}</Text>
            {key?.set && key.updated_at && <Text style={styles.rowText}>Saved {when(key.updated_at)}</Text>}
            {!key?.last_error && <LastProblem text={key?.last_problem} at={key?.last_problem_at} />}
          </View>
        </View>
        <TextInput
          value={newKey}
          onChangeText={setNewKey}
          placeholder={key?.set ? 'Paste a new key to change it' : 'Paste the key (sk-ant-…)'}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={styles.input}
          accessibilityLabel="Claude API key"
        />
        <Text style={styles.hint}>
          Get it at console.anthropic.com → API keys. It is kept on the server only; nobody can read it back from the
          app.
        </Text>
        <View style={styles.buttons}>
          <View style={styles.flex}>
            <Button
              title={key?.set ? 'Change key' : 'Save key'}
              onPress={onSaveKey}
              loading={busy === 'key'}
              disabled={!newKey.trim() || !!busy}
              fullWidth
            />
          </View>
          {key?.set && (
            <View style={styles.flex}>
              <Button
                title="Test"
                variant="secondary"
                onPress={onTest}
                loading={busy === 'test'}
                disabled={!!busy}
                fullWidth
              />
            </View>
          )}
        </View>
        {key?.set && (
          <Pressable onPress={onRemove} disabled={!!busy} accessibilityRole="button" style={styles.linkBtn}>
            <Text style={styles.linkDanger}>Remove the key</Text>
          </Pressable>
        )}
      </View>

      {/* 🔑 Gemini (an older database without it: nothing shown) */}
      {gkey && (
        <>
          <Text style={styles.sectionLabel}>GEMINI</Text>
          <GeminiCard
            prov={prov}
            patchProv={patchProv}
            status={gkey}
            reload={loadStatus}
            busy={busy}
            setBusy={setBusy}
            onNote={(n) => {
              setError(null);
              setNote(n);
            }}
          />
        </>
      )}

      {note && (
        <View style={[styles.noteBox, !note.ok && styles.errorBox]}>
          <Text style={[styles.noteText, !note.ok && styles.errorText]}>{note.text}</Text>
        </View>
      )}

      {pstats && (
        <>
          <Text style={styles.sectionLabel}>EACH AI SO FAR</Text>
          <ProviderNumbers stats={pstats} />
        </>
      )}

      {/* 🔮 chance of admission */}
      <Text style={styles.sectionLabel}>🔮 CHANCE OF ADMISSION</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>AI chance and what to say</Text>
            <Text style={styles.rowText}>
              {cs.enabled
                ? 'On: open leads get a chance (%), the doubts heard, next steps and lines to say (lead page, lists, Home).'
                : 'Off: nothing is shown and nothing is sent to the AI.'}
            </Text>
          </View>
          <Switch value={cs.enabled} onValueChange={(v) => patchC({ enabled: v })} />
        </View>
        {gkey && <ModePicker value={cs.provider} onChange={(m) => patchC({ provider: m })} prov={prov} />}
        {cs.provider !== 'gemini' && <ClaudeModelPicker value={cs.model} onChange={(m) => patchC({ model: m })} />}
      </View>

      <ChanceControls cs={cs} patch={patchC} keySet={chanceReady} onNote={setNote} />

      {cov && (
        <View style={styles.card}>
          <View style={styles.stats}>
            <Stat n={cov.done} label="Looked at" />
            <Stat n={cov.pending} label="Waiting" />
            <Stat n={cov.today} label="Today" />
            <Stat n={cov.failed} label="Failed" bad={cov.failed > 0} />
          </View>
          {(['hot', 'warm', 'cold'] as const).some((l) => cov.accuracy[l]) && (
            <Text style={styles.rowText}>
              How right so far (closed leads, by the last look):{' '}
              {(['hot', 'warm', 'cold'] as const)
                .filter((l) => cov.accuracy[l])
                .map((l) => {
                  const a = cov.accuracy[l]!;
                  const n = a.admitted + a.lost;
                  const icon = l === 'hot' ? '🔥' : l === 'warm' ? '🌤' : '❄️';
                  return `${icon} ${Math.round((a.admitted / n) * 100)}% admitted (${n})`;
                })
                .join(' · ')}
            </Text>
          )}
          {cov.failed > 0 && cov.last_error && (
            <Text style={[styles.rowText, styles.bad]}>Last problem: {cov.last_error}</Text>
          )}
          <Text style={styles.rowText}>
            Claude used so far: {cov.tokens_in.toLocaleString()} tokens in, {cov.tokens_out.toLocaleString()} out (about
            ${(cov.cost_usd ?? (cov.tokens_in * 2 + cov.tokens_out * 10) / 1_000_000).toFixed(2)})
          </Text>
        </View>
      )}

      <Text style={styles.sectionLabel}>WHO SEES THE CHANCE</Text>
      <View style={styles.card}>
        <Text style={styles.rowText}>Admins always. Everyone else only on the leads they can already see.</Text>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Everyone</Text>
          </View>
          <Switch value={cs.view.all} onValueChange={(v) => patchC({ view: { ...cs.view, all: v } })} />
        </View>
        {!cs.view.all && (
          <>
            <Text style={styles.small}>Roles</Text>
            <View style={styles.chips}>
              {roles.map((r) => (
                <Chip
                  key={r.key}
                  label={r.name}
                  on={cs.view.roles.includes(r.key)}
                  onPress={() => patchC({ view: { ...cs.view, roles: toggleIn(cs.view.roles, r.key) } })}
                />
              ))}
            </View>
            <Text style={styles.small}>People</Text>
            <View style={styles.chips}>
              {people.map((p) => (
                <Chip
                  key={p.id}
                  label={p.full_name ?? 'No name'}
                  on={cs.view.people.includes(p.id)}
                  onPress={() => patchC({ view: { ...cs.view, people: toggleIn(cs.view.people, p.id) } })}
                />
              ))}
            </View>
          </>
        )}
      </View>

      <Text style={styles.sectionLabel}>WHAT THE AI SHOULD KNOW ABOUT THE COLLEGE (OPTIONAL)</Text>
      <TextInput
        value={cs.guidance}
        onChangeText={(t) => patchC({ guidance: t })}
        placeholder="e.g. Installments: 3 parts. Classes on Friday and Saturday. Hostel for women. Admission closes 30 Dec."
        placeholderTextColor={colors.textMuted}
        multiline
        style={[styles.input, styles.multi]}
        maxLength={2000}
      />
      <Text style={styles.hint}>
        The AI uses this when it suggests what to say (it never promises anything that is not written here).
      </Text>

      <Text style={styles.sectionLabel}>🤝 ADMISSION CREDIT</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Share admissions with AI</Text>
            <Text style={styles.rowText}>
              {s.enabled
                ? 'On: “Admitted” credits follow the AI’s shares. Until a lead is worked out, the one who marked it Admitted gets it.'
                : 'Off: the one who marks a lead Admitted gets the whole credit (as before).'}
            </Text>
          </View>
          <Switch value={s.enabled} onValueChange={(v) => patch({ enabled: v })} />
        </View>
        {gkey && <ModePicker value={s.provider} onChange={(m) => patch({ provider: m })} prov={prov} />}
        {s.provider !== 'gemini' && <ClaudeModelPicker value={s.model} onChange={(m) => patch({ model: m })} />}
      </View>

      {ov && (
        <View style={styles.card}>
          <View style={styles.stats}>
            <Stat n={ov.done} label="Worked out" />
            <Stat n={ov.pending} label="Waiting" />
            <Stat n={ov.not_queued} label="Not started" />
            <Stat n={ov.failed} label="Failed" bad={ov.failed > 0} />
          </View>
          {ov.manual > 0 && <Text style={styles.rowText}>✍️ {ov.manual} set by hand</Text>}
          {ov.failed > 0 && ov.last_error && (
            <Text style={[styles.rowText, styles.bad]}>Last problem: {ov.last_error}</Text>
          )}
          <Text style={styles.rowText}>
            Claude used so far: {ov.tokens_in.toLocaleString()} tokens in, {ov.tokens_out.toLocaleString()} out (about $
            {(ov.cost_usd ?? (ov.tokens_in * 2 + ov.tokens_out * 10) / 1_000_000).toFixed(2)})
          </Text>
          <Button
            title={
              ov.not_queued + ov.failed > 0
                ? `Work out past admissions (${ov.not_queued + ov.failed})`
                : 'Work out past admissions'
            }
            variant="secondary"
            onPress={onQueueAll}
            loading={busy === 'all'}
            disabled={!!busy || !creditReady}
            fullWidth
          />
          <Text style={styles.hint}>
            Once is enough: new admissions are worked out by themselves. Ones already worked out are not sent again (on
            a lead page an admin can press “Work out again”).
          </Text>
        </View>
      )}

      <Text style={styles.sectionLabel}>WHO SEES THE SHARES</Text>
      <View style={styles.card}>
        <Text style={styles.rowText}>Admins always see them (lead page, Credits, Admission Contribution). Also:</Text>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Everyone</Text>
          </View>
          <Switch value={s.view.all} onValueChange={(v) => patch({ view: { ...s.view, all: v } })} />
        </View>
        {!s.view.all && (
          <>
            <Text style={styles.small}>Roles</Text>
            <View style={styles.chips}>
              {roles.map((r) => (
                <Chip
                  key={r.key}
                  label={r.name}
                  on={s.view.roles.includes(r.key)}
                  onPress={() =>
                    patch({
                      view: { ...s.view, roles: toggleIn(s.view.roles, r.key) },
                    })
                  }
                />
              ))}
            </View>
            <Text style={styles.small}>People</Text>
            <View style={styles.chips}>
              {people.map((p) => (
                <Chip
                  key={p.id}
                  label={p.full_name ?? 'No name'}
                  on={s.view.people.includes(p.id)}
                  onPress={() =>
                    patch({
                      view: {
                        ...s.view,
                        people: toggleIn(s.view.people, p.id),
                      },
                    })
                  }
                />
              ))}
            </View>
          </>
        )}
      </View>

      <Text style={styles.sectionLabel}>LOOK BACK BEFORE THE ADMISSION</Text>
      <View style={styles.chips}>
        {WINDOWS.map((d) => (
          <Chip key={d} label={`${d} days`} on={s.window_days === d} onPress={() => patch({ window_days: d })} />
        ))}
      </View>
      <Text style={styles.hint}>Calls and notes older than this are not counted.</Text>

      <Text style={styles.sectionLabel}>EXTRA RULES FOR THE AI (OPTIONAL)</Text>
      <TextInput
        value={s.guidance}
        onChangeText={(t) => patch({ guidance: t })}
        placeholder="e.g. The campus visit matters most. Whoever brings a referral gets at least 20%."
        placeholderTextColor={colors.textMuted}
        multiline
        style={[styles.input, styles.multi]}
        maxLength={1500}
      />

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Button title="Save" onPress={onSave} loading={busy === 'save'} disabled={!dirty || !!busy} fullWidth />
      <Text style={styles.hint}>
        Claude (paid from your Claude API credit): Sonnet 5.5 about $0.02–0.05 a lead, Haiku 5.5 about $0.001–0.003.
        Gemini: the free tier, $0 (it has a daily limit; when it is used up Gemini rests a while and the work waits).
      </Text>
    </KeyboardAwareScrollView>
  );
}

function Stat({ n, label, bad }: { n: number; label: string; bad?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statN, bad && styles.bad]}>{n}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  intro: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginLeft: spacing.xs,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  rowTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  rowText: {
    fontSize: fontSize.caption,
    lineHeight: 18,
    color: colors.textMuted,
    marginTop: 2,
  },
  small: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  bad: { color: colors.danger },
  input: {
    minHeight: 46,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 90, paddingTop: spacing.sm, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  linkBtn: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  linkDanger: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.danger,
  },
  stats: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', flex: 1 },
  statN: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    maxWidth: '100%',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  chipTextOn: { color: colors.textOnPrimary },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  noteBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  noteText: { fontSize: fontSize.small, color: colors.success },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
