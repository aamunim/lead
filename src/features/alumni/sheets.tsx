import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, s as ui } from '@/features/alumni/ui';
import { MIcon, md, Tap } from '@/features/home/md';
import type { AssignableUser } from '@/features/leads/api';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🎓 Small sheets for alumni: next contact, a text (note / tag),
//   who looks after them. Used on the list (many at once) and the page.
// =====================================================================

/** "Tomorrow 10:00", "In 3 days"… */
export function nextContactPresets(): { key: string; label: string; at: Date }[] {
  const at = (days: number, hour = 10) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const later = new Date(Date.now() + 2 * 3600_000);
  later.setMinutes(0, 0, 0);
  return [
    { key: '2h', label: 'In 2 hours', at: later },
    { key: '1d', label: 'Tomorrow 10:00', at: at(1) },
    { key: '3d', label: 'In 3 days', at: at(3) },
    { key: '7d', label: 'Next week', at: at(7) },
    { key: '30d', label: 'In a month', at: at(30) },
    { key: '90d', label: 'In 3 months', at: at(90) },
  ];
}

export function whenText(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const time = x.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
  if (x.toDateString() === today.toDateString()) return `Today ${time}`;
  if (x.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return x.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The chips + "Pick date & time" (value: the chosen time, or null) */
export function NextContactPicker({ value, onChange }: { value: Date | null; onChange: (d: Date | null) => void }) {
  const [key, setKey] = useState<string | null>(null);
  const presets = nextContactPresets();
  return (
    <View style={styles.picker}>
      <View style={ui.chips}>
        <Chip
          text="No next contact"
          on={!value}
          onPress={() => {
            setKey(null);
            onChange(null);
          }}
        />
        {presets.map((p) => (
          <Chip
            key={p.key}
            text={p.label}
            on={!!value && key === p.key}
            onPress={() => {
              setKey(p.key);
              onChange(p.at);
            }}
          />
        ))}
      </View>
      <View style={styles.pickRow}>
        <DateTimePickerButton
          title={value && key === 'custom' ? `📅 ${whenText(value)}` : '📅 Pick date & time'}
          onPick={(d) => {
            setKey('custom');
            onChange(d);
          }}
        />
        {value && key !== 'custom' && <Text style={ui.muted}>{whenText(value)}</Text>}
      </View>
    </View>
  );
}

/** ⏰ Next contact for one or many (with a short note) */
export function NextContactSheet({
  title,
  onSave,
  onClose,
  canClear,
}: {
  title: string;
  onSave: (at: Date | null, note: string) => Promise<void>;
  onClose: () => void;
  canClear?: boolean;
}) {
  const [at, setAt] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: Date | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(value, note.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <NextContactPicker value={at} onChange={setAt} />
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="What for? (e.g. ask for colleagues' numbers)"
        placeholderTextColor={colors.textMuted}
        maxLength={300}
        style={styles.input}
      />
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        {canClear ? (
          <View style={styles.flex}>
            <Button title="Remove" variant="ghost" onPress={() => save(null)} disabled={busy} fullWidth />
          </View>
        ) : (
          <View style={styles.flex}>
            <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
          </View>
        )}
        <View style={styles.flex}>
          <Button title="Save" onPress={() => at && save(at)} disabled={!at} loading={busy} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

/** 📝 / 🏷 A text for one or many */
export function TextSheet({
  title,
  placeholder,
  multiline,
  maxLength = 2000,
  suggestions = [],
  saveLabel = 'Save',
  onSave,
  onClose,
}: {
  title: string;
  placeholder: string;
  multiline?: boolean;
  maxLength?: number;
  suggestions?: string[];
  saveLabel?: string;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = text.trim().toLowerCase();
  const list = suggestions.filter((x) => !q || x.toLowerCase().includes(q)).slice(0, 12);
  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(text.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        maxLength={maxLength}
        multiline={multiline}
        style={[styles.input, multiline && styles.multi]}
        autoFocus
      />
      {list.length > 0 && (
        <View style={ui.chips}>
          {list.map((x) => (
            <Chip key={x} text={x} on={text === x} onPress={() => setText(x)} />
          ))}
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title={saveLabel} onPress={save} disabled={!text.trim()} loading={busy} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

/** 👤 Who looks after them */
export function OwnerSheet({
  people,
  onPick,
  onClose,
}: {
  people: AssignableUser[];
  onPick: (id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (id: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };
  return (
    <Sheet title="Looked after by" onClose={onClose}>
      {busy ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <View style={styles.options}>
          <Option label="Nobody" onPress={() => pick(null)} />
          {people
            .filter((u) => u.is_active)
            .map((u) => (
              <Option key={u.id} label={u.full_name ?? 'No name'} onPress={() => pick(u.id)} />
            ))}
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
    </Sheet>
  );
}

/** A list of choices (a "menu" sheet) */
export function MenuSheet({
  title,
  items,
  onClose,
}: {
  title: string;
  items: { label: string; icon?: Parameters<typeof MIcon>[0]['name']; danger?: boolean; onPress: () => void }[];
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <View style={styles.options}>
        {items.map((it) => (
          <Tap key={it.label} onPress={it.onPress} style={styles.option} label={it.label}>
            {it.icon && <MIcon name={it.icon} color={it.danger ? colors.danger : colors.text} />}
            <Text style={[styles.optionText, it.danger && styles.danger]}>{it.label}</Text>
          </Tap>
        ))}
      </View>
    </Sheet>
  );
}

function Option({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} style={styles.option} label={label}>
      <MIcon name="person-outline" color={colors.textMuted} />
      <Text style={styles.optionText}>{label}</Text>
    </Tap>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>{title}</Text>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '85%',
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    ...(isWeb ? { width: '100%', maxWidth: 520, alignSelf: 'center' } : {}),
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: md.outline,
    marginTop: spacing.md,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  body: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
  picker: { gap: spacing.sm },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 96, paddingTop: spacing.sm, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
  options: { gap: 2 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  optionText: { flex: 1, fontSize: fontSize.body, color: colors.text },
  danger: { color: colors.danger },
});
