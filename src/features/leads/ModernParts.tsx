import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MIcon, md, type MIconName } from '@/features/home/md';
import { colors, fontWeight } from '@/shared/theme';

// =====================================================================
// ✨ Bits of the new Leads / Students list: the Material top bar (and its
//   "N selected" form), a filter chip with a count, the ⋮ menu and the
//   action sheet for marked leads.
// =====================================================================

export type BarAction = { icon: MIconName; label: string; onPress: () => void; on?: boolean };

export function ModernTopBar({
  title,
  count,
  actions,
  selecting,
  selectedCount,
  onClearSelection,
  markingAll,
  markAllLabel,
  onMarkAll,
}: {
  title: string;
  count: number | null;
  actions: BarAction[];
  selecting: boolean;
  selectedCount: number;
  onClearSelection: () => void;
  markingAll: boolean;
  markAllLabel: string;
  onMarkAll: () => void;
}) {
  if (selecting) {
    return (
      <SafeAreaView edges={['top']} style={[styles.bar, styles.barSelecting]}>
        <View style={styles.barRow}>
          <IconBtn icon="close" label="Clear marks" onPress={onClearSelection} color={md.onPrimaryC} />
          <Text style={[styles.title, styles.titleSelecting]}>{selectedCount} selected</Text>
          {markingAll ? (
            <ActivityIndicator color={md.onPrimaryC} style={styles.spinner} />
          ) : (
            <Pressable
              onPress={onMarkAll}
              android_ripple={{ color: md.ripple, borderless: false, foreground: true }}
              style={styles.markAll}
              accessibilityRole="button"
            >
              <MIcon name="select-all" size={20} color={md.onPrimaryC} />
              <Text style={styles.markAllText}>{markAllLabel}</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView edges={['top']} style={styles.bar}>
      <View style={styles.barRow}>
        <View style={styles.titleBox}>
          <Text style={styles.title}>{title}</Text>
          {count != null && (
            <Text style={styles.count} accessibilityLabel={`${count}`}>
              {count.toLocaleString('en-IN')}
            </Text>
          )}
        </View>
        {actions.map((a) => (
          <IconBtn key={a.label} icon={a.icon} label={a.label} onPress={a.onPress} on={a.on} />
        ))}
      </View>
    </SafeAreaView>
  );
}

function IconBtn({
  icon,
  label,
  onPress,
  on,
  color = colors.text,
}: {
  icon: MIconName;
  label: string;
  onPress: () => void;
  on?: boolean;
  color?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: md.ripple, borderless: true, radius: 20 }}
      style={({ pressed }) => [
        styles.iconBtn,
        on && styles.iconBtnOn,
        Platform.OS !== 'android' && pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MIcon name={icon} size={23} color={on ? md.onPrimaryC : color} />
    </Pressable>
  );
}

/** A filter chip: "Mine 64"; selected = tonal with a tick */
export function ModernChip({
  label,
  count,
  selected,
  onPress,
  onLongPress,
  icon,
}: {
  label: string;
  count?: number | null;
  selected: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  icon?: MIconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={{ color: md.ripple, foreground: true }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipOn,
        Platform.OS !== 'android' && pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={count != null ? `${label}, ${count}` : label}
    >
      {selected ? (
        <MIcon name="check" size={16} color={md.onPrimaryC} />
      ) : icon ? (
        <MIcon name={icon} size={15} color={colors.primary} />
      ) : null}
      <Text style={[styles.chipText, selected && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {count != null && (
        <Text style={[styles.chipCount, selected && styles.chipTextOn]}>{count.toLocaleString('en-IN')}</Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------
// ⋮ menu (top right)
// ---------------------------------------------------------------------
export type MenuItem = { icon: MIconName; label: string; hint?: string; onPress: () => void; on?: boolean };

export function ListMenu({ visible, items, onClose }: { visible: boolean; items: MenuItem[]; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose} accessibilityLabel="Close menu">
        <SafeAreaView edges={['top']}>
          <View style={styles.menu}>
            {items.map((it) => (
              <Pressable
                key={it.label}
                onPress={it.onPress}
                android_ripple={{ color: md.ripple }}
                style={({ pressed }) => [styles.menuItem, Platform.OS !== 'android' && pressed && styles.pressed]}
                accessibilityRole="button"
              >
                <MIcon name={it.icon} size={20} color={colors.textMuted} />
                <View style={styles.menuTextBox}>
                  <Text style={styles.menuText}>{it.label}</Text>
                  {!!it.hint && <Text style={styles.menuHint}>{it.hint}</Text>}
                </View>
                {it.on != null && (
                  <MIcon
                    name={it.on ? 'toggle-on' : 'toggle-off'}
                    size={30}
                    color={it.on ? colors.primary : colors.textMuted}
                  />
                )}
              </Pressable>
            ))}
          </View>
        </SafeAreaView>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Marked leads: what to do (a grid at the bottom)
// ---------------------------------------------------------------------
export type ModernAction = { key: string; label: string; icon: MIconName; danger?: boolean };

export function ModernActionSheet({
  title,
  actions,
  disabled,
  onPick,
}: {
  title: string;
  actions: ModernAction[];
  disabled?: boolean;
  onPick: (key: string) => void;
}) {
  return (
    <View style={styles.sheet}>
      <View style={styles.handle} />
      <Text style={styles.sheetHint}>{title}</Text>
      <View style={styles.grid}>
        {actions.map((a) => (
          <Pressable
            key={a.key}
            onPress={() => onPick(a.key)}
            disabled={disabled}
            android_ripple={{ color: md.ripple, borderless: true, radius: 36 }}
            style={({ pressed }) => [styles.cell, Platform.OS !== 'android' && pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={a.label}
          >
            <View style={styles.cellIcon}>
              <MIcon name={a.icon} size={22} color={a.danger ? md.onErrorC : colors.primary} />
            </View>
            <Text style={styles.cellText} numberOfLines={1}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  bar: { backgroundColor: colors.background },
  barSelecting: { backgroundColor: md.primaryC },
  barRow: { height: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, gap: 2 },
  titleBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 22, fontWeight: fontWeight.semibold, color: colors.text },
  titleSelecting: { flex: 1, fontSize: 18, color: md.onPrimaryC, marginLeft: 4 },
  count: {
    fontSize: 12,
    fontWeight: fontWeight.bold,
    color: md.onPrimaryC,
    backgroundColor: md.primaryC,
    borderRadius: 10,
    overflow: 'hidden',
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  iconBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  iconBtnOn: { backgroundColor: md.primaryC },
  spinner: { marginRight: 14 },
  markAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 18,
    overflow: 'hidden',
  },
  markAllText: { fontSize: 13, fontWeight: fontWeight.semibold, color: md.onPrimaryC },

  chip: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  chipOn: { backgroundColor: md.primaryC, borderColor: md.primaryC, paddingLeft: 8 },
  chipText: { fontSize: 13, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: md.onPrimaryC },
  chipCount: { fontSize: 11.5, fontWeight: fontWeight.bold, color: colors.textMuted },

  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.08)' },
  menu: {
    alignSelf: 'flex-end',
    marginTop: 48,
    marginRight: 8,
    minWidth: 250,
    maxWidth: 320,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  menuTextBox: { flex: 1 },
  menuText: { fontSize: 14.5, color: colors.text },
  menuHint: { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  handle: { alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: md.outline, marginBottom: 6 },
  sheetHint: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '25%', alignItems: 'center', gap: 4, paddingVertical: 6 },
  cellIcon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: md.surface1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: { fontSize: 11.5, color: colors.text },
});
