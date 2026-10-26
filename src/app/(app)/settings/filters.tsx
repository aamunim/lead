import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    DEFAULT_FILTER_CONFIG,
    FILTER_FIELDS,
    deleteSavedFilter,
    getFilterConfig,
    listSavedFilters,
    saveFilterConfig,
    type FilterConfig,
    type SavedFilter,
} from '@/features/leads/filters';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

export default function FilterSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [config, setConfig] = useState<FilterConfig>(DEFAULT_FILTER_CONFIG);
  const [shared, setShared] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getFilterConfig(), listSavedFilters()])
      .then(([c, saved]) => {
        setConfig(c);
        setShared(saved.filter((f) => f.is_shared));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the settings.'))
      .finally(() => setLoading(false));
  }, []);

  // --- changes -----------------------------------------------------------
  const toggle = (index: number) => {
    setConfig((c) => ({
      fields: c.fields.map((f, i) => (i === index ? { ...f, enabled: !f.enabled } : f)),
    }));
    setDirty(true);
  };

  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= config.fields.length) return;
    setConfig((c) => {
      const fields = [...c.fields];
      [fields[index], fields[to]] = [fields[to], fields[index]];
      return { fields };
    });
    setDirty(true);
  };

  const resetDefault = () => {
    setConfig(DEFAULT_FILTER_CONFIG);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!config.fields.some((f) => f.enabled)) {
      setError('Keep at least one filter switched on.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveFilterConfig(config);
      setDirty(false);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDeleteShared = (f: SavedFilter) => {
    Alert.alert('Delete shared filter?', `“${f.name}” will be removed for everyone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteSavedFilter(f.id);
            setShared((list) => list.filter((x) => x.id !== f.id));
          } catch (e) {
            Alert.alert('Could not delete', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  // --- states -------------------------------------------------------------
  if (!canManage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead filters' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead filters' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const onCount = config.fields.filter((f) => f.enabled).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Lead filters' }} />

      <Text style={styles.intro}>
        Choose which filters everyone sees on the Leads screen, and in what order. Use the arrows to move a
        filter up or down.
      </Text>

      {/* Fields */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Filters ({onCount} on)</Text>
          <Pressable onPress={resetDefault} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Reset</Text>
          </Pressable>
        </View>

        {config.fields.map((f, index) => {
          const meta = FILTER_FIELDS[f.key];
          return (
            <View key={f.key} style={[styles.row, index > 0 && styles.rowDivider]}>
              <View style={[styles.icon, !f.enabled && styles.iconOff]}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Ionicons name={meta.icon as any} size={18} color={f.enabled ? colors.primary : colors.textMuted} />
              </View>
              <Text style={[styles.rowText, !f.enabled && styles.rowTextOff]}>{meta.label}</Text>

              <Pressable
                onPress={() => move(index, -1)}
                disabled={index === 0}
                hitSlop={6}
                style={[styles.arrow, index === 0 && styles.arrowOff]}
                accessibilityRole="button"
                accessibilityLabel={`Move ${meta.label} up`}
              >
                <Ionicons name="chevron-up" size={18} color={colors.text} />
              </Pressable>
              <Pressable
                onPress={() => move(index, 1)}
                disabled={index === config.fields.length - 1}
                hitSlop={6}
                style={[styles.arrow, index === config.fields.length - 1 && styles.arrowOff]}
                accessibilityRole="button"
                accessibilityLabel={`Move ${meta.label} down`}
              >
                <Ionicons name="chevron-down" size={18} color={colors.text} />
              </Pressable>

              <Switch value={f.enabled} onValueChange={() => toggle(index)} />
            </View>
          );
        })}
      </View>

      {/* Shared filters */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Shared filters</Text>
        {shared.length === 0 ? (
          <Text style={styles.muted}>
            None yet. To share one, open Filter on the Leads screen, choose filters, tap “Save this filter” and
            switch on “Share with everyone”.
          </Text>
        ) : (
          shared.map((f, index) => (
            <View key={f.id} style={[styles.row, index > 0 && styles.rowDivider]}>
              <Ionicons name="people" size={18} color={colors.primary} />
              <Text style={styles.rowText}>{f.name}</Text>
              <Pressable
                onPress={() => confirmDeleteShared(f)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${f.name}`}
              >
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </Pressable>
            </View>
          ))
        )}
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Button title="Save" onPress={handleSave} loading={saving} disabled={!dirty} fullWidth />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  intro: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  icon: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  iconOff: { backgroundColor: colors.background },
  rowText: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTextOff: { color: colors.textMuted },
  arrow: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  arrowOff: { opacity: 0.3 },
  muted: { fontSize: fontSize.small, color: colors.textMuted, lineHeight: 20 },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});