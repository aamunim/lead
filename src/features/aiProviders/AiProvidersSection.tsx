import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { ask } from '@/features/aiChance/ask';
import {
  MODES,
  removeGeminiKey,
  saveGeminiKey,
  testGeminiKey,
  type AiMode,
  type AiProviderStats,
  type AiProvidersSetting,
  type GeminiKeyStatus,
  type GeminiModel,
} from '@/features/aiProviders/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🤖 Settings → AI: Gemini (free) next to Claude
//   · GeminiCard: on/off, the key (paste, Test, Remove), the model
//   · ModePicker: which AI a feature uses
//   · ProviderNumbers: each AI's answers and runs
// =====================================================================

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : '';

/** The last time an AI could not answer (shown even when the other AI answered in its place) */
export function LastProblem({ text, at }: { text?: string | null; at?: string | null }) {
  if (!text) return null;
  return (
    <Text style={[styles.rowText, styles.bad]} selectable>
      Last problem{at ? ` (${when(at)})` : ''}: {text}
    </Text>
  );
}

const GEMINI_DATA_NOTE =
  'Gemini’s free tier: Google may use what is sent to improve its products, and people at Google may read it. ' +
  'Names and phone numbers are never sent, but call notes, course, area and fee talks are. ' +
  'Turn it on only if the college is fine with that.';

export function GeminiCard({
  prov,
  patchProv,
  status,
  reload,
  busy,
  setBusy,
  onNote,
}: {
  prov: AiProvidersSetting;
  patchProv: (f: (p: AiProvidersSetting) => AiProvidersSetting) => void;
  status: GeminiKeyStatus | null;
  reload: () => void;
  busy: string | null;
  setBusy: (b: string | null) => void;
  onNote: (n: { ok: boolean; text: string }) => void;
}) {
  const [newKey, setNewKey] = useState('');
  const [models, setModels] = useState<GeminiModel[] | null>(null);
  const on = prov.gemini.on;
  const model = prov.gemini.model;

  const run = async (what: string, job: () => Promise<void>) => {
    setBusy(what);
    try {
      await job();
    } catch (e) {
      onNote({ ok: false, text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const r = await testGeminiKey();
    reload();
    if (!r.ok) {
      onNote({ ok: false, text: r.error ?? 'It did not work.' });
      return;
    }
    setModels(r.models ?? []);
    // no model chosen yet (or the chosen one is gone): take the first one offered
    const names = (r.models ?? []).map((m) => m.name);
    if (names.length > 0 && (!model || !names.includes(model))) {
      patchProv((p) => ({ ...p, gemini: { ...p.gemini, model: names[0] } }));
    }
    onNote({
      ok: true,
      text:
        names.length > 0
          ? `✅ The Gemini key works. ${names.length} Flash models can be used; pick one below, then Save.`
          : '✅ The Gemini key works, but no Flash model was offered for it.',
    });
  };

  const onSaveKey = () =>
    run('gkey', async () => {
      await saveGeminiKey(newKey);
      setNewKey('');
      await test();
    });

  const onTest = () => run('gtest', test);

  const onRemove = () =>
    ask('Remove the Gemini key?', 'Gemini stops until a new key is saved. Answers it gave stay.', [
      {
        label: 'Remove',
        danger: true,
        run: () =>
          run('gremove', async () => {
            await removeGeminiKey();
            setModels(null);
            reload();
          }),
      },
    ]);

  const onSwitch = (v: boolean) => {
    if (!v) {
      patchProv((p) => ({ ...p, gemini: { ...p.gemini, on: false } }));
      return;
    }
    ask('Turn Gemini on?', GEMINI_DATA_NOTE, [
      { label: 'Turn on', run: () => patchProv((p) => ({ ...p, gemini: { ...p.gemini, on: true } })) },
    ]);
  };

  const keyLine = !status
    ? 'Checking…'
    : !status.set
      ? 'No key saved yet.'
      : status.last_error
        ? `⚠️ ${status.last_error}`
        : status.paused_until
          ? `⏸ The free limit is used up; it rests until ${when(status.paused_until)}.`
          : status.last_ok_at
            ? `✅ Working (last used ${when(status.last_ok_at)})`
            : 'Saved, not checked yet. Press Test.';

  const shownModels: GeminiModel[] = models ?? (model ? [{ name: model, label: model.replace(/^models\//, '') }] : []);

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.rowTitle}>Gemini (free)</Text>
          <Text style={styles.rowText}>
            {on
              ? 'On: the features set to use Gemini below use it.'
              : 'Off: Gemini is never used and its key is never sent anywhere.'}
          </Text>
        </View>
        <Switch value={on} onValueChange={onSwitch} accessibilityLabel="Gemini on or off" />
      </View>
      {on && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>⚠️ {GEMINI_DATA_NOTE}</Text>
        </View>
      )}

      <View style={styles.divider} />
      <Text style={styles.rowTitle}>{status?.set ? status.hint : 'Gemini API key: not set'}</Text>
      <Text style={[styles.rowText, (status?.last_error || status?.paused_until) && styles.bad]}>{keyLine}</Text>
      {!status?.last_error && <LastProblem text={status?.last_problem} at={status?.last_problem_at} />}
      <TextInput
        value={newKey}
        onChangeText={setNewKey}
        placeholder={status?.set ? 'Paste a new key to change it' : 'Paste the Gemini key (AIza…)'}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
        accessibilityLabel="Gemini API key"
      />
      <Text style={styles.hint}>
        Get it free at aistudio.google.com → Get API key. It is kept on the server only; nobody can read it back from
        the app.
      </Text>
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button
            title={status?.set ? 'Change key' : 'Save key'}
            onPress={onSaveKey}
            loading={busy === 'gkey'}
            disabled={!newKey.trim() || !!busy}
            fullWidth
          />
        </View>
        {status?.set && (
          <View style={styles.flex}>
            <Button
              title="Test"
              variant="secondary"
              onPress={onTest}
              loading={busy === 'gtest'}
              disabled={!!busy}
              fullWidth
            />
          </View>
        )}
      </View>
      {status?.set && (
        <Pressable onPress={onRemove} disabled={!!busy} accessibilityRole="button" style={styles.linkBtn}>
          <Text style={styles.linkDanger}>Remove the Gemini key</Text>
        </Pressable>
      )}

      {status?.set && (
        <>
          <Text style={styles.small}>MODEL</Text>
          {shownModels.length === 0 ? (
            <Text style={styles.rowText}>Press Test to see the models this key may use.</Text>
          ) : (
            <View style={styles.chips}>
              {shownModels.map((m) => (
                <Chip
                  key={m.name}
                  label={m.label}
                  on={model === m.name}
                  onPress={() => patchProv((p) => ({ ...p, gemini: { ...p.gemini, model: m.name } }))}
                />
              ))}
            </View>
          )}
          {!model && <Text style={[styles.rowText, styles.bad]}>No model chosen: Gemini can’t work until one is.</Text>}
          {models === null && model && <Text style={styles.hint}>Press Test to see every model this key may use.</Text>}
        </>
      )}
    </View>
  );
}

/** Which AI a feature uses */
export function ModePicker({
  value,
  onChange,
  prov,
}: {
  value: AiMode;
  onChange: (m: AiMode) => void;
  prov: AiProvidersSetting;
}) {
  const isOn = (p: 'claude' | 'gemini') => prov[p].on;
  const current = MODES.find((m) => m.key === value) ?? MODES[0];
  const off = current.needs.filter((p) => !isOn(p));
  const allOff = off.length === current.needs.length;
  return (
    <View style={styles.modeBox}>
      <Text style={styles.small}>WHICH AI</Text>
      <View style={styles.chips}>
        {MODES.map((m) => (
          <Chip key={m.key} label={m.label} on={value === m.key} onPress={() => onChange(m.key)} />
        ))}
      </View>
      <Text style={styles.rowText}>{current.text}</Text>
      {off.length > 0 && (
        <Text style={[styles.rowText, styles.bad]}>
          {allOff
            ? `⚠️ ${off.map(name).join(' and ')} ${off.length > 1 ? 'are' : 'is'} switched off: this feature will not run.`
            : `⚠️ ${off.map(name).join(' and ')} is switched off: only ${current.needs
                .filter(isOn)
                .map(name)
                .join(' and ')} is used.`}
        </Text>
      )}
    </View>
  );
}

const name = (p: 'claude' | 'gemini') => (p === 'claude' ? 'Claude' : 'Gemini');

/** Each AI's numbers */
export function ProviderNumbers({ stats }: { stats: AiProviderStats }) {
  return (
    <View style={styles.card}>
      {(['claude', 'gemini'] as const).map((p) => {
        const n = stats.providers?.[p];
        if (!n) return null;
        const acc = (['hot', 'warm', 'cold'] as const)
          .filter((l) => n.accuracy?.[l])
          .map((l) => {
            const a = n.accuracy[l]!;
            const total = a.admitted + a.lost;
            const icon = l === 'hot' ? '🔥' : l === 'warm' ? '🌤' : '❄️';
            return `${icon} ${Math.round((a.admitted / total) * 100)}% (${total})`;
          })
          .join(' · ');
        return (
          <View key={p} style={styles.numRow}>
            <Text style={styles.rowTitle}>
              {name(p)} {stats.ready?.[p] ? '🟢' : '⚪️'}
            </Text>
            <Text style={styles.rowText}>
              {n.chance_answers} chances · {n.credit_answers} admissions · {n.runs_today} runs today · {n.runs_month}{' '}
              this month
            </Text>
            {acc ? <Text style={styles.rowText}>How right (closed leads): {acc}</Text> : null}
          </View>
        );
      })}
      <Text style={styles.hint}>🟢 ready to work · ⚪️ off, no key, no model, or resting</Text>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
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
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  small: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, marginTop: spacing.xs },
  bad: { color: colors.danger },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
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
  buttons: { flexDirection: 'row', gap: spacing.sm },
  linkBtn: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  linkDanger: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  warnBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.warningSoft },
  warnText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.text },
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
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  modeBox: { gap: spacing.xs },
  numRow: { paddingVertical: spacing.xs },
});
