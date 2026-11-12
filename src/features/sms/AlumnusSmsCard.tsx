import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { s as ui, when } from '@/features/alumni/ui';
import { colors, fontSize, spacing } from '@/shared/theme';

import { alumnusSms, STATUS_LABEL, type AlumnusSms } from './api';

// 📨 The SMS sent to one alumnus (shown only when there are some)
export function AlumnusSmsCard({ alumniId }: { alumniId: string }) {
  const [rows, setRows] = useState<AlumnusSms[]>([]);
  useEffect(() => {
    alumnusSms(alumniId)
      .then(setRows)
      .catch(() => setRows([]));
  }, [alumniId]);
  if (rows.length === 0) return null;
  return (
    <View style={ui.card}>
      <Text style={ui.label}>SMS ({rows.length})</Text>
      {rows.slice(0, 10).map((m) => (
        <View key={m.id} style={styles.row}>
          <Text style={styles.text} numberOfLines={3}>
            {m.body}
          </Text>
          <Text style={ui.muted}>
            {m.status === 'sent' ? '✅' : m.status === 'failed' ? '❌' : '⏳'} {STATUS_LABEL[m.status]} · {when(m.at)}
            {m.sender ? ` · from ${m.sender}` : ''}
            {m.error ? ` · ${m.error}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 2, paddingVertical: spacing.xs },
  text: { fontSize: fontSize.body, color: colors.text },
});
