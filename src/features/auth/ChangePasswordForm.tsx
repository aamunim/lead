import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { changeMyPassword } from '@/features/auth/api';
import { colors, fontSize, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🔐 Set a new password (twice). Used after an admin reset (before the
//   app opens) and from More → Change password.
// =====================================================================
export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (password.length < 8) return setError('At least 8 characters, please.');
    if (password !== again) return setError('The two passwords are not the same.');
    setSaving(true);
    setError(null);
    try {
      await changeMyPassword(password);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.form}>
      <TextField
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="newPassword"
        placeholder="At least 8 characters"
      />
      <TextField
        label="New password again"
        value={again}
        onChangeText={setAgain}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="newPassword"
        onSubmitEditing={save}
      />
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Button title="Save new password" onPress={save} loading={saving} fullWidth />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
