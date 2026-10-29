import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    createItem,
    listCourses,
    listItems,
    reorderItems,
    updateItem,
    type ListItem,
} from '@/features/settings/api';
import { COLOR_CHOICES, getListConfig, type FieldConfig } from '@/features/settings/lists';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

type Option = { value: string; label: string };
type Draft = Record<string, unknown> & { id?: string; name: string; is_active: boolean };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function ListEditorScreen() {
  const { table } = useLocalSearchParams<{ table: string }>();
  const config = getListConfig(table ?? '');

  const [items, setItems] = useState<ListItem[]>([]);
  const [references, setReferences] = useState<Record<string, Option[]>>({});
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  // --- load items and any lists the fields refer to ------------------
  const load = useCallback(async () => {
    if (!config) return;
    try {
      setError(null);
      const list = await listItems(config.table, { includeInactive: true });
      setItems(list);

      const refs: Record<string, Option[]> = {};
      for (const field of config.fields) {
        if (field.type !== 'reference') continue;
        if (field.table === 'lead_sources') {
          refs[field.key] = (await listItems('lead_sources')).map((s) => ({ value: s.id, label: s.name }));
        } else {
          refs[field.key] = (await listCourses()).map((c) => ({ value: c.id, label: c.name }));
        }
      }
      setReferences(refs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this list.');
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => (showInactive ? items : items.filter((i) => i.is_active)),
    [items, showInactive],
  );
  const inactiveCount = items.length - items.filter((i) => i.is_active).length;

  // --- reorder: move one row up or down ------------------------------
  const move = async (id: string, direction: -1 | 1) => {
    if (!config) return;
    const index = items.findIndex((i) => i.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= items.length) return;

    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next); // show the change at once

    try {
      await reorderItems(config.table, next.map((i) => i.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the new order.');
      load();
    }
  };

  // --- open the editor -------------------------------------------------
  const openNew = () => {
    if (!config) return;
    const empty: Draft = { name: '', is_active: true };
    for (const f of config.fields) {
      empty[f.key] = f.type === 'boolean' ? false : f.type === 'color' ? COLOR_CHOICES[0] : null;
    }
    setDraft(empty);
  };

  const openEdit = (item: ListItem) => {
    setDraft({ ...item, name: item.name, is_active: item.is_active });
  };

  if (!config) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Settings' }} />
        <Text style={styles.emptyTitle}>List not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: config.title }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Button title={`Add ${config.singular}`} onPress={openNew} fullWidth />

          {visible.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing here yet</Text>
              <Text style={styles.emptyText}>Tap “Add {config.singular}” to create the first one.</Text>
            </View>
          ) : (
            <View style={styles.group}>
              {visible.map((item, index) => (
                <Row
                  key={item.id}
                  item={item}
                  fields={config.fields}
                  references={references}
                  first={index === 0}
                  canMoveUp={items[0]?.id !== item.id}
                  canMoveDown={items[items.length - 1]?.id !== item.id}
                  onPress={() => openEdit(item)}
                  onMove={(d) => move(item.id, d)}
                />
              ))}
            </View>
          )}

          {inactiveCount > 0 && (
            <Button
              title={showInactive ? 'Hide switched-off items' : `Show switched-off items (${inactiveCount})`}
              variant="ghost"
              onPress={() => setShowInactive((s) => !s)}
            />
          )}
        </ScrollView>
      )}

      {draft && (
        <EditorModal
          title={draft.id ? `Edit ${config.singular}` : `New ${config.singular}`}
          draft={draft}
          fields={config.fields}
          references={references}
          lockActive={!!draft.is_system && config.table === 'pipeline_stages'}
          onClose={() => setDraft(null)}
          onSave={async (values) => {
            const { id, ...rest } = values;
            if (id) {
              await updateItem(config.table, id, rest);
            } else {
              await createItem(config.table, rest);
            }
            setDraft(null);
            load();
          }}
        />
      )}
    </View>
  );
}

// =====================================================================
// One row
// =====================================================================
function Row({
  item,
  fields,
  references,
  first,
  canMoveUp,
  canMoveDown,
  onPress,
  onMove,
}: {
  item: ListItem;
  fields: FieldConfig[];
  references: Record<string, Option[]>;
  first: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPress: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const color = typeof item.color === 'string' ? item.color : null;

  // Short summary of the extra fields, e.g. "Facebook · BDT 15000"
  const summary = fields
    .map((f) => {
      const v = item[f.key];
      if (f.type === 'boolean') return v ? f.label : null;
      if (f.type === 'reference') {
        return references[f.key]?.find((o) => o.value === v)?.label ?? (v ? null : f.emptyLabel);
      }
      if (f.type === 'number' && v != null) return `${f.label}: ${v}`;
      if (f.type === 'date' && v) return `${f.label}: ${v}`;
      return null;
    })
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.row, !first && styles.rowDivider, !item.is_active && styles.rowInactive]}>
      <Pressable onPress={onPress} style={styles.rowMain} accessibilityRole="button">
        {color && <View style={[styles.dot, { backgroundColor: color }]} />}
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle}>{item.name}</Text>
          {summary !== '' && <Text style={styles.rowMeta}>{summary}</Text>}
        </View>
        {!!item.is_system && <Text style={styles.badge}>System</Text>}
        {!item.is_active && <Text style={[styles.badge, styles.badgeOff]}>Off</Text>}
      </Pressable>

      <View style={styles.arrows}>
        <Pressable
          onPress={() => onMove(-1)}
          disabled={!canMoveUp}
          hitSlop={6}
          accessibilityLabel={`Move ${item.name} up`}
        >
          <Text style={[styles.arrow, !canMoveUp && styles.arrowDisabled]}>▲</Text>
        </Pressable>
        <Pressable
          onPress={() => onMove(1)}
          disabled={!canMoveDown}
          hitSlop={6}
          accessibilityLabel={`Move ${item.name} down`}
        >
          <Text style={[styles.arrow, !canMoveDown && styles.arrowDisabled]}>▼</Text>
        </Pressable>
      </View>
    </View>
  );
}

// =====================================================================
// Add / edit form in a bottom sheet
// =====================================================================
function EditorModal({
  title,
  draft: initial,
  fields,
  references,
  lockActive,
  onClose,
  onSave,
}: {
  title: string;
  draft: Draft;
  fields: FieldConfig[];
  references: Record<string, Option[]>;
  lockActive: boolean;
  onClose: () => void;
  onSave: (values: Draft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }));

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setError('Please enter a name.');
      return;
    }

    // Only send the columns this list really has
    const values: Draft = { name: draft.name.trim(), is_active: draft.is_active };
    if (draft.id) values.id = draft.id;

    for (const f of fields) {
      const v = draft[f.key];
      if (f.type === 'number') {
        const text = v == null ? '' : String(v).trim();
        if (text === '') {
          values[f.key] = null;
        } else if (Number.isNaN(Number(text))) {
          setError(`${f.label} must be a number.`);
          return;
        } else {
          values[f.key] = Number(text);
        }
      } else if (f.type === 'date') {
        const text = typeof v === 'string' ? v.trim() : '';
        if (text && !DATE_RE.test(text)) {
          setError(`${f.label} must look like 2026-01-31.`);
          return;
        }
        values[f.key] = text || null;
      } else {
        values[f.key] = v ?? null;
      }
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior="padding"
          style={styles.sheetWrap}
        >
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
                <Text style={styles.close}>✕</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <TextField
                label="Name"
                required
                value={draft.name}
                onChangeText={(v) => set('name', v)}
                autoFocus={!draft.id}
              />

              {fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={draft[f.key]}
                  options={references[f.key] ?? []}
                  onChange={(v) => set(f.key, v)}
                />
              ))}

              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text style={styles.switchLabel}>Active</Text>
                  <Text style={styles.switchHint}>
                    {lockActive
                      ? 'System stages are always on.'
                      : 'Switched-off items are hidden from new leads but kept in history.'}
                  </Text>
                </View>
                <Switch
                  value={draft.is_active}
                  onValueChange={(v) => set('is_active', v)}
                  disabled={lockActive}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Button title="Save" onPress={handleSave} loading={saving} fullWidth />
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// =====================================================================
// One extra field, drawn by type
// =====================================================================
function FieldInput({
  field,
  value,
  options,
  onChange,
}: {
  field: FieldConfig;
  value: unknown;
  options: Option[];
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case 'text':
      return (
        <TextField
          label={field.label}
          required={field.required}
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChangeText={onChange}
        />
      );

    case 'number':
      return (
        <TextField
          label={field.label}
          placeholder={field.placeholder}
          value={value == null ? '' : String(value)}
          onChangeText={onChange}
          keyboardType="decimal-pad"
        />
      );

    case 'date':
      return (
        <TextField
          label={field.label}
          placeholder="YYYY-MM-DD"
          value={(value as string) ?? ''}
          onChangeText={onChange}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
        />
      );

    case 'color':
      return (
        <View style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>{field.label}</Text>
          <View style={styles.colors}>
            {COLOR_CHOICES.map((c) => (
              <Pressable
                key={c}
                onPress={() => onChange(c)}
                style={[styles.colorDot, { backgroundColor: c }, value === c && styles.colorSelected]}
                accessibilityRole="radio"
                accessibilityState={{ selected: value === c }}
                accessibilityLabel={`Colour ${c}`}
              />
            ))}
          </View>
        </View>
      );

    case 'boolean':
      return (
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>{field.label}</Text>
            {field.hint && <Text style={styles.switchHint}>{field.hint}</Text>}
          </View>
          <Switch
            value={!!value}
            onValueChange={onChange}
            trackColor={{ true: colors.primary, false: colors.border }}
          />
        </View>
      );

    case 'reference':
    case 'choice': {
      const list: { value: string | null; label: string }[] =
        field.type === 'reference' ? [{ value: null, label: field.emptyLabel }, ...options] : field.options;
      return (
        <View style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>{field.label}</Text>
          <View style={styles.chips}>
            {list.map((o) => {
              const selected = (value ?? null) === o.value;
              return (
                <Pressable
                  key={String(o.value)}
                  onPress={() => onChange(o.value)}
                  style={[styles.chip, selected && styles.chipSelected]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      );
    }
  }
}

// =====================================================================
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  group: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  rowInactive: { opacity: 0.55 },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
  },
  dot: { width: 14, height: 14, borderRadius: radius.pill },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowMeta: { fontSize: fontSize.caption, color: colors.textMuted },
  badge: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: colors.info,
    backgroundColor: colors.infoSoft,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  badgeOff: { color: colors.danger, backgroundColor: colors.dangerSoft },
  arrows: { paddingHorizontal: spacing.md, gap: spacing.xs, alignItems: 'center' },
  arrow: { fontSize: 14, color: colors.primary },
  arrowDisabled: { color: colors.border },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.xs },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  // sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(11,19,40,0.45)', justifyContent: 'flex-end' },
  sheetWrap: { maxHeight: '90%' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  close: { fontSize: fontSize.title, color: colors.textMuted },
  sheetContent: { padding: spacing.lg, gap: spacing.lg },
  fieldBlock: { gap: spacing.sm },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  colorDot: { width: 34, height: 34, borderRadius: radius.pill },
  colorSelected: { borderWidth: 3, borderColor: colors.text },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchText: { flex: 1, gap: 2 },
  switchLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  switchHint: { fontSize: fontSize.caption, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextSelected: { color: colors.textOnPrimary },
});