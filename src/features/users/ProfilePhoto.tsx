import { useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { removePhoto, uploadPhoto } from '@/features/users/profile';
import { hasCamera } from '@/features/voice/native';
import { colors, fontWeight } from '@/shared/theme';

// =====================================================================
// 📷 A round profile photo (or the name's first letters). Editable: tap
//   to choose from the gallery, take one, or remove it.
// =====================================================================

export const initialsOf = (name: string | null | undefined) =>
  (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';

type Props = {
  url: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  /** editing: whose photo, and what to do after a change */
  userId?: string;
  onChanged?: (url: string | null) => void;
  bg?: string;
  fg?: string;
};

export function ProfilePhoto({
  url,
  name,
  size = 72,
  userId,
  onChanged,
  bg = colors.primarySoft,
  fg = colors.primary,
}: Props) {
  const [busy, setBusy] = useState(false);
  const editable = !!userId && !!onChanged;

  const pick = async (from: 'gallery' | 'camera') => {
    if (!userId || !onChanged) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ip = require('expo-image-picker') as typeof import('expo-image-picker');
    if (from === 'camera') {
      const perm = await ip.requestCameraPermissionsAsync();
      if (!perm.granted) return Alert.alert('Camera', 'Allow the camera in the phone’s Settings to take a photo.');
    }
    const opts = {
      mediaTypes: ['images'] as ['images'],
      allowsEditing: true,
      aspect: [1, 1] as [number, number],
      quality: 0.5,
    };
    const res = from === 'camera' ? await ip.launchCameraAsync(opts) : await ip.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;
    setBusy(true);
    try {
      onChanged(await uploadPhoto(userId, res.assets[0].uri, res.assets[0].mimeType ?? 'image/jpeg'));
    } catch (e) {
      Alert.alert('Could not change the photo', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!userId || !onChanged) return;
    setBusy(true);
    try {
      await removePhoto(userId);
      onChanged(null);
    } catch (e) {
      Alert.alert('Could not remove the photo', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };

  const menu = () => {
    if (Platform.OS === 'web') return pick('gallery');
    Alert.alert('Profile photo', undefined, [
      { text: 'Choose from gallery', onPress: () => pick('gallery') },
      ...(hasCamera ? [{ text: 'Take a photo', onPress: () => pick('camera') }] : []),
      ...(url ? [{ text: 'Remove photo', style: 'destructive' as const, onPress: remove }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const circle = { width: size, height: size, borderRadius: size / 2 };
  const inner = url ? (
    <Image source={{ uri: url }} style={[circle, styles.img]} accessibilityLabel={`${name ?? ''} photo`} />
  ) : (
    <View style={[circle, styles.letters, { backgroundColor: bg }]}>
      <Text style={[styles.lettersText, { color: fg, fontSize: size * 0.36 }]}>{initialsOf(name)}</Text>
    </View>
  );

  if (!editable) return inner;
  return (
    <Pressable onPress={menu} disabled={busy} accessibilityRole="button" accessibilityLabel="Change profile photo">
      {inner}
      <View style={styles.badge}>
        {busy ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.badgeText}>📷</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: colors.border },
  letters: { alignItems: 'center', justifyContent: 'center' },
  lettersText: { fontWeight: fontWeight.bold },
  badge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },
  badgeText: { fontSize: 13 },
});
