import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { bulkMarkReceived, type BulkReceived } from '@/features/approval/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🏛 Students tab → mark → Received by ITTC, many at once.
//   Only the ready ones are marked (submitted online + the admission fee
//   paid); the others are left as they are, and the sheet says why.
// =====================================================================

export function BulkReceivedSheet({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [preview, setPreview] = useState<BulkReceived | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bulkMarkReceived(ids, true)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not check.'));
  }, [ids]);

  const run = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await bulkMarkReceived(ids, false);
      onDone(`🏛 ${r.done} ${r.done === 1 ? 'student' : 'students'} received by ITTC.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <Text style={styles.title}>🏛 Received by ITTC</Text>
          {!preview && !error && <ActivityIndicator color={colors.primary} />}
          {preview && (
            <View style={styles.box}>
              <Text style={styles.line}>
                {preview.ready > 0 ? `✅ ${preview.ready} ready: they will be marked` : 'Nobody here is ready yet.'}
              </Text>
              {preview.short > 0 && (
                <Text style={styles.line}>⏭ {preview.short} submitted, but the admission fee is not paid yet</Text>
              )}
              {preview.not_submitted > 0 && (
                <Text style={styles.line}>⏭ {preview.not_submitted} not submitted online yet</Text>
              )}
              {preview.already > 0 && <Text style={styles.line}>⏭ {preview.already} already received</Text>}
              {preview.skipped > 0 && <Text style={styles.line}>⏭ {preview.skipped} not admitted or cancelled</Text>}
            </View>
          )}
          {error && <Text style={styles.error}>{error}</Text>}
          <Button
            title={preview && preview.ready > 0 ? `🏛 Mark ${preview.ready} received` : 'Mark received'}
            onPress={run}
            loading={saving}
            disabled={!preview || preview.ready === 0}
            fullWidth
          />
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  box: {
    gap: 4,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  line: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  error: { fontSize: fontSize.small, color: colors.danger },
});
