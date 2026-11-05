import { Stack, router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { ProfilePhoto } from '@/features/users/ProfilePhoto';
import { changeMyEmail, saveNamePhone } from '@/features/users/profile';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 👤 More → My profile: your photo, name, phone and sign-in email.
//   Role and team are set by an admin (shown, not changed here).
// =====================================================================

export default function MyProfileScreen() {
  const { profile, session, refreshProfile } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [email, setEmail] = useState(profile?.email ?? session?.user.email ?? '');
  const [photo, setPhoto] = useState<string | null>(profile?.avatar_url ?? null);
  const [saving, setSaving] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailNote, setEmailNote] = useState<string | null>(null);

  useEffect(() => {
    setPhoto(profile?.avatar_url ?? null);
  }, [profile?.avatar_url]);

  if (!profile) return null;
  const currentEmail = profile.email ?? session?.user.email ?? '';
  const dirty = name.trim() !== (profile.full_name ?? '') || phone.trim() !== (profile.phone ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveNamePhone(profile.id, name, phone);
      await refreshProfile();
      Alert.alert('✅ Saved', 'Your profile is up to date.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const sendEmail = async () => {
    setSendingEmail(true);
    setEmailNote(null);
    try {
      await changeMyEmail(email);
      setEmailNote(
        `📩 A confirm link went to ${email.trim().toLowerCase()}. Open it; until then you sign in with ${currentEmail}.`,
      );
    } catch (e) {
      setEmailNote(`⚠️ ${e instanceof Error ? e.message : 'Could not change the email.'}`);
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'My profile' }} />

      <View style={[styles.card, styles.center]}>
        <ProfilePhoto
          url={photo}
          name={profile.full_name}
          size={96}
          userId={profile.id}
          onChanged={(u) => {
            setPhoto(u);
            refreshProfile().catch(() => undefined);
          }}
        />
        <Text style={styles.name}>{profile.full_name || 'No name'}</Text>
        <Text style={styles.muted}>{profile.role?.name ?? 'No role'}</Text>
        <Text style={styles.small}>Tap the photo to change it.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Details</Text>
        <TextField label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
        <TextField label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        {error && <Text style={styles.error}>{error}</Text>}
        <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Sign-in email</Text>
        <TextField
          label="Email"
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setEmailNote(null);
          }}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {emailNote && <Text style={styles.small}>{emailNote}</Text>}
        <Button
          title="Change email"
          variant="secondary"
          onPress={sendEmail}
          loading={sendingEmail}
          disabled={email.trim().toLowerCase() === currentEmail.toLowerCase() || !email.trim()}
          fullWidth
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Password</Text>
        <Button
          title="🔑 Change password"
          variant="secondary"
          onPress={() => router.push('/password' as Href)}
          fullWidth
        />
        <Text style={styles.small}>Your role and team are set by an admin.</Text>
      </View>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  center: { alignItems: 'center', gap: spacing.sm },
  name: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, marginTop: spacing.sm },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted, lineHeight: 18 },
  section: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  error: { fontSize: fontSize.small, color: colors.danger },
});
