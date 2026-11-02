import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  DEFAULT_UPLOAD,
  addPdfAccount,
  canEditUploadRules,
  deletePdfAccount,
  getUploadDefaults,
  listPaperRules,
  listPdfAccounts,
  savePaperRule,
  saveUploadDefaults,
  updatePdfAccount,
  type PaperRule,
  type PdfAccount,
  type UploadDefaults,
} from '@/features/files/uploadRules';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📎 Settings → Upload rules (website; admins and the Admission Officer)
//   • Defaults: pictures (longest side, KB) and PDFs (KB)
//   • Each paper: what it takes, the exact picture size, picture KB, PDF KB
//   • iLovePDF accounts that make big PDFs smaller (tried in order)
// =====================================================================

const num = (t: string) => {
  const n = Number(t.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export default function UploadRulesScreen() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [defaults, setDefaults] = useState<UploadDefaults>(DEFAULT_UPLOAD);
  const [papers, setPapers] = useState<PaperRule[]>([]);
  const [accounts, setAccounts] = useState<PdfAccount[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const say = (text: string, bad = false) => {
    setMsg({ text, bad });
    setTimeout(() => setMsg(null), 4000);
  };

  const load = useCallback(async () => {
    const ok = await canEditUploadRules();
    setAllowed(ok);
    if (!ok) return;
    const [d, p, a] = await Promise.all([getUploadDefaults(), listPaperRules(), listPdfAccounts().catch(() => [])]);
    setDefaults(d);
    setPapers(p);
    setAccounts(a);
  }, []);

  useEffect(() => {
    load().catch((e) => say(e instanceof Error ? e.message : 'Could not load.', true));
  }, [load]);

  if (allowed === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!allowed) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Only admins and the Admission Officer can change the upload rules.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Upload rules' }} />

      <Text style={styles.h1}>📎 Upload rules</Text>
      <Text style={styles.muted}>
        On the website a picture is made to the set size and weight before it is uploaded. A PDF over its limit is made
        smaller with iLovePDF; if it is still too big, the person is asked to make it smaller by hand.
      </Text>
      {msg && <Text style={[styles.msg, msg.bad && styles.msgBad]}>{msg.text}</Text>}

      {/* Defaults */}
      <Section title="Defaults" hint="For papers without their own rule, and for other files.">
        <View style={styles.row}>
          <Field
            label="Picture: longest side (px)"
            value={defaults.img_max_side}
            onChange={(n) => setDefaults({ ...defaults, img_max_side: n ?? 0 })}
          />
          <Field
            label="Picture: at most (KB)"
            value={defaults.img_max_kb}
            onChange={(n) => setDefaults({ ...defaults, img_max_kb: n ?? 0 })}
          />
          <Field
            label="PDF: at most (KB)"
            value={defaults.pdf_max_kb}
            onChange={(n) => setDefaults({ ...defaults, pdf_max_kb: n ?? 0 })}
          />
          <SmallButton
            title="Save"
            onPress={async () => {
              try {
                await saveUploadDefaults(defaults);
                say('✓ Defaults saved.');
              } catch (e) {
                say(e instanceof Error ? e.message : 'Could not save.', true);
              }
            }}
          />
        </View>
      </Section>

      {/* Papers */}
      <Section
        title="Each paper"
        hint="Width × height: the picture is made exactly that size (stretched, nothing cut off). Empty = the defaults."
      >
        <View style={styles.headRow}>
          <Text style={[styles.th, styles.colName]}>Paper</Text>
          <Text style={[styles.th, styles.colAccept]}>Takes</Text>
          <Text style={[styles.th, styles.colSize]}>Picture size (px)</Text>
          <Text style={[styles.th, styles.colKb]}>Picture KB</Text>
          <Text style={[styles.th, styles.colKb]}>PDF KB</Text>
          <View style={styles.colSave} />
        </View>
        {papers.length === 0 && <Text style={styles.muted}>No papers yet (Settings → Required papers).</Text>}
        {papers.map((p) => (
          <PaperRow key={p.id} rule={p} onSaved={(t, bad) => (bad ? say(t, true) : (say(t), load()))} />
        ))}
      </Section>

      {/* iLovePDF */}
      <Section
        title="📄 PDF compressor (iLovePDF)"
        hint="Accounts are tried from the top; when one runs out of files for the month (or fails), the next one is used. The keys stay on the server."
      >
        {accounts.length === 0 && (
          <Text style={styles.warn}>
            No account yet: big PDFs can't be made smaller, so people are asked to do it by hand.
          </Text>
        )}
        {accounts.map((a, i) => (
          <View key={a.id} style={[styles.account, !a.is_active && styles.accountOff]}>
            <View style={styles.flex}>
              <Text style={styles.accName}>
                {i + 1}. {a.label}
              </Text>
              <Text style={styles.accMeta}>
                {a.key_hint} · {a.files_month} file{a.files_month === 1 ? '' : 's'} this month
                {a.last_used_at ? ` · last used ${new Date(a.last_used_at).toLocaleDateString('en-GB')}` : ''}
              </Text>
              {!!a.last_error && <Text style={styles.accError}>⚠ {a.last_error}</Text>}
            </View>
            <SmallButton
              title="↑"
              ghost
              onPress={async () => {
                if (i === 0) return;
                const prev = accounts[i - 1];
                await updatePdfAccount(a.id, { sort_order: prev.sort_order });
                await updatePdfAccount(prev.id, {
                  sort_order: a.sort_order === prev.sort_order ? a.sort_order + 1 : a.sort_order,
                });
                load();
              }}
            />
            <Switch
              value={a.is_active}
              onValueChange={async (v) => {
                await updatePdfAccount(a.id, { is_active: v });
                load();
              }}
              trackColor={{ true: colors.primary, false: colors.border }}
              accessibilityLabel={`${a.label} in use`}
            />
            <SmallButton
              title="Remove"
              ghost
              onPress={async () => {
                await deletePdfAccount(a.id);
                say('Account removed.');
                load();
              }}
            />
          </View>
        ))}
        <AddAccount
          onAdded={() => {
            say('✓ Account added.');
            load();
          }}
          onError={(t) => say(t, true)}
        />
        <Pressable onPress={() => Linking.openURL('https://developer.ilovepdf.com/')} accessibilityRole="link">
          <Text style={styles.link}>
            How to get a key: developer.ilovepdf.com → sign up (free: 250 files a month) → Projects → copy the Public
            key ↗
          </Text>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function PaperRow({ rule, onSaved }: { rule: PaperRule; onSaved: (text: string, bad?: boolean) => void }) {
  const [r, setR] = useState(rule);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setR(rule);
    setDirty(false);
  }, [rule]);
  const set = (patch: Partial<PaperRule>) => {
    setR({ ...r, ...patch });
    setDirty(true);
  };
  return (
    <View style={[styles.paperRow, !r.is_active && styles.accountOff]}>
      <Text style={[styles.cellText, styles.colName]} numberOfLines={2}>
        {r.name}
      </Text>
      <View style={[styles.colAccept, styles.chips]}>
        {(
          [
            ['any', 'Any'],
            ['image', 'Picture'],
            ['pdf', 'PDF'],
          ] as const
        ).map(([k, label]) => (
          <Pressable
            key={k}
            onPress={() => set({ accept: k })}
            style={[styles.chip, r.accept === k && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: r.accept === k }}
          >
            <Text style={[styles.chipText, r.accept === k && styles.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={[styles.colSize, styles.sizeRow]}>
        <Input value={r.img_width} onChange={(n) => set({ img_width: n })} placeholder="W" />
        <Text style={styles.times}>×</Text>
        <Input value={r.img_height} onChange={(n) => set({ img_height: n })} placeholder="H" />
      </View>
      <View style={styles.colKb}>
        <Input value={r.img_max_kb} onChange={(n) => set({ img_max_kb: n })} placeholder="default" />
      </View>
      <View style={styles.colKb}>
        <Input value={r.pdf_max_kb} onChange={(n) => set({ pdf_max_kb: n })} placeholder="default" />
      </View>
      <View style={styles.colSave}>
        {dirty && (
          <SmallButton
            title="Save"
            onPress={async () => {
              try {
                await savePaperRule(r);
                onSaved(`✓ ${r.name} saved.`);
              } catch (e) {
                onSaved(e instanceof Error ? e.message : 'Could not save.', true);
              }
            }}
          />
        )}
      </View>
    </View>
  );
}

function AddAccount({ onAdded, onError }: { onAdded: () => void; onError: (t: string) => void }) {
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.addRow}>
      <TextInput
        value={label}
        onChangeText={setLabel}
        placeholder="Name, e.g. Office account 2"
        placeholderTextColor={colors.textMuted}
        style={[styles.input, styles.inputName]}
      />
      <TextInput
        value={key}
        onChangeText={setKey}
        placeholder="Public key (project_public_…)"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, styles.flex]}
      />
      <SmallButton
        title={busy ? '…' : '＋ Add account'}
        onPress={async () => {
          setBusy(true);
          try {
            await addPdfAccount(label, key);
            setLabel('');
            setKey('');
            onAdded();
          } catch (e) {
            onError(e instanceof Error ? e.message : 'Could not add it.');
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>{title}</Text>
      <Text style={styles.muted}>{hint}</Text>
      {children}
    </View>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (n: number | null) => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Input value={value} onChange={onChange} />
    </View>
  );
}

function Input({
  value,
  onChange,
  placeholder,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  placeholder?: string;
}) {
  return (
    <TextInput
      value={value == null ? '' : String(value)}
      onChangeText={(t) => onChange(num(t))}
      keyboardType="number-pad"
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      style={styles.input}
    />
  );
}

function SmallButton({ title, onPress, ghost }: { title: string; onPress: () => void; ghost?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.btn, ghost && styles.btnGhost]} accessibilityRole="button">
      <Text style={[styles.btnText, ghost && styles.btnGhostText]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl, gap: spacing.lg, maxWidth: 1100, width: '100%', alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  h1: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  h2: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  warn: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning },
  msg: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.successSoft,
    color: colors.success,
    fontWeight: fontWeight.semibold,
  },
  msgBad: { backgroundColor: colors.dangerSoft, color: colors.danger },
  card: {
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md, flexWrap: 'wrap' },
  field: { gap: 4, width: 200 },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  input: {
    height: 38,
    minWidth: 60,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.small,
  },
  headRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingBottom: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  th: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, textTransform: 'uppercase' },
  paperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cellText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  colName: { flex: 1, minWidth: 140 },
  colAccept: { width: 210 },
  colSize: { width: 170 },
  colKb: { width: 96 },
  colSave: { width: 70 },
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  times: { color: colors.textMuted },
  chips: { flexDirection: 'row', gap: 6 },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  accountOff: { opacity: 0.55 },
  accName: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  accMeta: { fontSize: fontSize.caption, color: colors.textMuted },
  accError: { fontSize: fontSize.caption, color: colors.danger },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  inputName: { width: 220 },
  btn: {
    height: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  btnGhostText: { color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});
