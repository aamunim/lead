import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { countLeadsForExport, exportLeads, type ExportFilters } from '@/features/import-export/api';
import { listAssignableUsers } from '@/features/leads/api';
import { listItems } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

type Option = { value: string; label: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL = '__all__';

const toDateText = (d: Date) => d.toISOString().slice(0, 10);

const PRESETS: { label: string; range: () => [string, string] | [null, null] }[] = [
  { label: 'All time', range: () => [null, null] },
  {
    label: 'This month',
    range: () => {
      const now = new Date();
      return [toDateText(new Date(now.getFullYear(), now.getMonth(), 1)), toDateText(now)];
    },
  },
  {
    label: 'Last 30 days',
    range: () => {
      const now = new Date();
      return [toDateText(new Date(now.getTime() - 29 * 86_400_000)), toDateText(now)];
    },
  },
];

export default function ExportScreen() {
  const { profile, hasPermission } = useAuth();

  const [stages, setStages] = useState<Option[]>([]);
  const [sources, setSources] = useState<Option[]>([]);
  const [users, setUsers] = useState<Option[]>([]);

  const [stageId, setStageId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- options -----------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [stg, src, ppl] = await Promise.all([
          listItems('pipeline_stages'),
          listItems('lead_sources'),
          listAssignableUsers(),
        ]);
        setStages(stg.map((s) => ({ value: s.id, label: s.name })));
        setSources(src.map((s) => ({ value: s.id, label: s.name })));
        setUsers(ppl.map((p) => ({ value: p.id, label: p.full_name ?? 'No name' })));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load filters.');
      }
    })();
  }, []);

  const datesValid = (!from || DATE_RE.test(from)) && (!to || DATE_RE.test(to));

  const filters: ExportFilters = {
    stageId,
    sourceId,
    assignedTo,
    createdFrom: from || null,
    createdTo: to || null,
  };

  // --- live count whenever a filter changes ---------------------------
  useEffect(() => {
    if (!datesValid) {
      setCount(null);
      return;
    }
    setMessage(null);
    setCounting(true);
    const timer = setTimeout(async () => {
      try {
        setCount(await countLeadsForExport(filters));
      } catch {
        setCount(null);
      } finally {
        setCounting(false);
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, sourceId, assignedTo, from, to, datesValid]);

  const handleExport = async () => {
    if (!profile) return;
    if (!datesValid) {
      setError('Dates must look like 2026-01-31.');
      return;
    }
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const exported = await exportLeads(filters, profile.id);
      setMessage(`Exported ${exported} leads.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export.');
    } finally {
      setExporting(false);
    }
  };

  if (!hasPermission('leads.export')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Export leads' }} />
        <Text style={styles.title}>No access</Text>
        <Text style={styles.muted}>Only admins can export leads.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Export leads' }} />

      <View style={styles.notice}>
        <Text style={styles.noticeText}>
          The file contains personal details. Every export is recorded with your name and the number of
          leads.
        </Text>
      </View>

      {/* Stage */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Stage</Text>
        <Chips
          options={[{ value: ALL, label: 'All' }, ...stages]}
          selected={stageId ?? ALL}
          onPress={(v) => setStageId(v === ALL ? null : v)}
        />
      </View>

      {/* Source */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Source</Text>
        <Chips
          options={[{ value: ALL, label: 'All' }, ...sources]}
          selected={sourceId ?? ALL}
          onPress={(v) => setSourceId(v === ALL ? null : v)}
        />
      </View>

      {/* Assigned to */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Assigned to</Text>
        <Chips
          options={[{ value: ALL, label: 'Everyone' }, ...users]}
          selected={assignedTo ?? ALL}
          onPress={(v) => setAssignedTo(v === ALL ? null : v)}
        />
      </View>

      {/* Dates */}
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Added between</Text>
        <View style={styles.chips}>
          {PRESETS.map((p) => (
            <Pressable
              key={p.label}
              onPress={() => {
                const [a, b] = p.range();
                setFrom(a ?? '');
                setTo(b ?? '');
              }}
              style={styles.preset}
              accessibilityRole="button"
            >
              <Text style={styles.presetText}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.row}>
          <TextField
            label="From"
            value={from}
            onChangeText={setFrom}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            containerStyle={styles.flex}
            error={from && !DATE_RE.test(from) ? 'e.g. 2026-01-31' : null}
          />
          <TextField
            label="To"
            value={to}
            onChangeText={setTo}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            containerStyle={styles.flex}
            error={to && !DATE_RE.test(to) ? 'e.g. 2026-12-31' : null}
          />
        </View>
      </View>

      {/* Count */}
      <View style={styles.countBox}>
        {counting ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text style={styles.countText}>
            {count === null ? '—' : `${count} ${count === 1 ? 'lead' : 'leads'} will be exported`}
          </Text>
        )}
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      {message && (
        <View style={styles.successBox}>
          <Text style={styles.successText}>{message}</Text>
        </View>
      )}

      <Button
        title="Export to Excel"
        onPress={handleExport}
        loading={exporting}
        disabled={!count}
        fullWidth
      />
    </ScrollView>
  );
}

function Chips({
  options,
  selected,
  onPress,
}: {
  options: Option[];
  selected: string;
  onPress: (value: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = o.value === selected;
        return (
          <Pressable
            key={o.value}
            onPress={() => onPress(o.value)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.md },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  notice: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.warningSoft },
  noticeText: { fontSize: fontSize.small, lineHeight: 20, color: colors.warning },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  preset: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  presetText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primaryDark },
  countBox: {
    alignItems: 'center',
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  countText: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  successBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.successSoft },
  successText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
});