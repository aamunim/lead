import { StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, spacing } from '@/shared/theme';

// 🖼 Photo Studio is on the website only (PhotoStudio.web.tsx)
export function PhotoStudio() {
  return (
    <View style={styles.box}>
      <Text style={styles.text}>🖼 Photo Studio works on the website (lead.ittc.edu.bd), on a computer.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, padding: spacing.lg, backgroundColor: colors.background },
  text: { fontSize: fontSize.body, color: colors.textMuted },
});
