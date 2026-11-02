import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { APP_NAME } from '@/features/web/brand';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

export default function LoadingScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{APP_NAME}</Text>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    backgroundColor: colors.background,
  },
  title: {
    fontSize: fontSize.heading,
    fontWeight: fontWeight.bold,
    color: colors.text,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
});