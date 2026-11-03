import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { md } from '@/features/home/md';
import { DESIGN_LABEL, type ListDesign } from '@/features/leads/design';
import { colors, fontWeight } from '@/shared/theme';

// 🎨 ✨ New | 📋 Classic (More → List design, a user's page, Settings → Lead cards)
export function ListDesignPicker({
  value,
  onChange,
  busy,
}: {
  value: ListDesign | null;
  onChange: (next: ListDesign) => void;
  busy?: boolean;
}) {
  return (
    <View style={styles.row}>
      {(['new', 'classic'] as ListDesign[]).map((d) => {
        const on = value === d;
        return (
          <Pressable
            key={d}
            onPress={() => !on && onChange(d)}
            disabled={busy}
            style={[styles.option, on && styles.optionOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
          >
            <Text style={[styles.text, on && styles.textOn]}>{DESIGN_LABEL[d]}</Text>
          </Pressable>
        );
      })}
      {busy && <ActivityIndicator color={colors.primary} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  option: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: md.outline,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  optionOn: { backgroundColor: md.primaryC, borderColor: md.primaryC },
  text: { fontSize: 14, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: md.onPrimaryC },
});
