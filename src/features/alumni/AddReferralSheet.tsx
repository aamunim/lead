import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';
import { SheetScroll } from '@/shared/ui/SheetScroll';
import { TextField } from '@/shared/ui/TextField';

import { addReferral, hintId } from './api';
import { alumniChanged, Chip, s as ui } from './ui';

// =====================================================================
// 📨 Add a referral for an alumnus (staff types it while on the phone)
//   It goes to the referral inbox; an admin imports it as a lead.
// =====================================================================

export function AddReferralSheet({
  alumniId,
  alumniName,
  onClose,
}: {
  alumniId: string;
  alumniName: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [area, setArea] = useState('');
  const [note, setNote] = useState('');
  const [courseId, setCourseId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    listCourses()
      .then(setCourses)
      .catch(() => undefined);
  }, []);

  const save = async (another: boolean) => {
    if (!name.trim()) return setError('Please type the name.');
    if (phone.replace(/\D/g, '').length < 10) return setError('Please type a correct phone number.');
    setBusy(true);
    setError(null);
    try {
      const r = await addReferral({ alumniId, name, phone, courseId, area, note });
      alumniChanged();
      setAdded((n) => n + 1);
      if (r.existing_lead) {
        const msg =
          'This number is already a lead. It is in the inbox: an admin decides whether ' + alumniName + ' gets credit.';
        if (Platform.OS === 'web') window.alert(msg);
        else Alert.alert('Already a lead', msg);
      }
      if (another) {
        setName('');
        setPhone('');
        setArea('');
        setNote('');
      } else onClose();
    } catch (e) {
      if (hintId(e, 'referral_waiting') !== null || (e as { hint?: string }).hint === 'referral_waiting') {
        setError('This number is already waiting in the referral inbox.');
      } else setError(e instanceof Error ? e.message : 'Could not add.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent keyboard animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <SheetScroll contentContainerStyle={styles.body}>
          <Text style={styles.title}>📨 Referral from {alumniName}</Text>
          {added > 0 && <Text style={styles.ok}>✓ {added} added to the inbox</Text>}
          <TextField label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
          <TextField label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          {courses.length > 0 && (
            <>
              <Text style={ui.label}>INTERESTED IN (OPTIONAL)</Text>
              <View style={ui.chips}>
                {courses.map((c) => (
                  <Chip
                    key={c.id}
                    text={c.name}
                    on={courseId === c.id}
                    onPress={() => setCourseId(courseId === c.id ? null : c.id)}
                  />
                ))}
              </View>
            </>
          )}
          <TextField label="Area (optional)" value={area} onChangeText={setArea} />
          <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline />
          {error && <Text style={ui.error}>{error}</Text>}
          <Button title="Add to inbox" onPress={() => save(false)} loading={busy} fullWidth />
          <Button
            title="Add and type another"
            variant="secondary"
            onPress={() => save(true)}
            disabled={busy}
            fullWidth
          />
          <Button title="Close" variant="ghost" onPress={onClose} fullWidth />
        </SheetScroll>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    ...(Platform.OS === 'web' ? { width: '100%', maxWidth: 560, alignSelf: 'center' } : {}),
  },
  body: { padding: spacing.lg, gap: spacing.sm },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  ok: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
});
