import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import {
  fillSms,
  KIND_LABEL,
  listBatches,
  mySenders,
  previewAlumniSms,
  sendAlumniSms,
  smsLength,
  type MySender,
  type SmsBatch,
  type SmsPreview,
} from './api';

// =====================================================================
// 📨 Write one SMS to the marked alumni
//   · sender ID (masking / non-masking), the text with {name} / {first_name}
//   · how many can get it (no number, "do not contact" left out)
//   · leave out who already got an earlier send
// =====================================================================

const confirm = (title: string, msg: string, ok: string): Promise<boolean> =>
  new Promise((resolve) => {
    if (Platform.OS === 'web') resolve(window.confirm(`${title}\n\n${msg}`));
    else
      Alert.alert(title, msg, [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: ok, onPress: () => resolve(true) },
      ]);
  });

export function SmsComposeSheet({
  ids,
  sampleName,
  onClose,
  onSent,
}: {
  ids: string[];
  /** a name for the preview (the first marked one) */
  sampleName?: string | null;
  onClose: () => void;
  onSent: (r: { batch_id: string; queued: number; parts: number }) => void;
}) {
  const [senders, setSenders] = useState<MySender[] | null>(null);
  const [sender, setSender] = useState<string>('');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [skip, setSkip] = useState<string | null>(null);
  const [batches, setBatches] = useState<SmsBatch[]>([]);
  const [preview, setPreview] = useState<SmsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mySenders()
      .then((s) => {
        setSenders(s);
        setSender(
          (s.find((x) => x.is_default && x.kind === 'masking') ?? s.find((x) => x.is_default) ?? s[0])?.id ?? '',
        );
      })
      .catch((e) => {
        setSenders([]);
        setError(e instanceof Error ? e.message : 'Could not load.');
      });
    listBatches(10)
      .then((b) => setBatches(b.filter((x) => x.audience === 'alumni')))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setPreview(null);
    previewAlumniSms(ids, skip)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not count.'));
  }, [ids, skip]);

  const len = smsLength(text);
  const willGet = preview?.will_get ?? 0;
  const chosen = senders?.find((s) => s.id === sender);

  const send = async () => {
    if (!text.trim() || !sender) return;
    const ok = await confirm(
      `Send to ${willGet} ${willGet === 1 ? 'person' : 'people'}?`,
      `From ${chosen?.sender_id} (${chosen ? KIND_LABEL[chosen.kind] : ''}). About ${willGet * len.parts} SMS will be used (${len.parts} each). This can’t be taken back once it goes out.`,
      'Send',
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      onSent(
        await sendAlumniSms({
          ids,
          message: text.trim(),
          senderId: sender,
          name: name.trim() || null,
          skipBatch: skip,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`📨 SMS · ${ids.length} marked`} onClose={onClose}>
      {senders === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : senders.length === 0 ? (
        <Text style={ui.muted}>
          {error ?? 'No sender ID is ready. An admin sets it up in Settings → SMS (company, API key, sender ID).'}
        </Text>
      ) : (
        <>
          <Text style={ui.label}>FROM</Text>
          <View style={ui.chips}>
            {senders.map((s) => (
              <Chip
                key={s.id}
                text={`${s.sender_id} · ${KIND_LABEL[s.kind]}`}
                on={sender === s.id}
                onPress={() => setSender(s.id)}
              />
            ))}
          </View>

          <Text style={ui.label}>
            MESSAGE · {len.chars} letters · {len.parts} SMS each{len.unicode ? ' (Bangla: 70 letters a SMS)' : ''}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="আসসালামু আলাইকুম {first_name}, …"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={1000}
            style={[styles.input, styles.multi]}
          />
          <View style={ui.chips}>
            <Chip text="+ {name}" on={false} onPress={() => setText((t) => `${t}{name}`)} />
            <Chip text="+ {first_name}" on={false} onPress={() => setText((t) => `${t}{first_name}`)} />
          </View>
          {!!text.trim() && sampleName && (
            <View style={styles.preview}>
              <Text style={ui.muted}>{sampleName} gets:</Text>
              <Text style={styles.text}>{fillSms(text.trim(), sampleName)}</Text>
            </View>
          )}

          {batches.length > 0 && (
            <>
              <Text style={ui.label}>LEAVE OUT WHO ALREADY GOT</Text>
              <View style={ui.chips}>
                <Chip text="Nobody left out" on={!skip} onPress={() => setSkip(null)} />
                {batches.map((b) => (
                  <Chip
                    key={b.id}
                    text={b.name || b.message.slice(0, 24) + (b.message.length > 24 ? '…' : '')}
                    on={skip === b.id}
                    onPress={() => setSkip(b.id)}
                  />
                ))}
              </View>
            </>
          )}

          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="A name for this send (optional), e.g. Eid wish 2026"
            placeholderTextColor={colors.textMuted}
            maxLength={80}
            style={styles.input}
          />

          <View style={styles.counts}>
            {preview ? (
              <>
                <Text style={styles.big}>✅ {willGet} will get it</Text>
                {preview.no_number > 0 && <Text style={ui.muted}>📵 {preview.no_number} have no mobile number</Text>}
                {preview.do_not_contact > 0 && (
                  <Text style={ui.muted}>🚫 {preview.do_not_contact} are “do not contact”</Text>
                )}
                {skip && preview.got_this_before > 0 && (
                  <Text style={ui.muted}>↩️ {preview.got_this_before} already got that send</Text>
                )}
                {!skip && preview.got_sms_before > 0 && (
                  <Text style={ui.muted}>ℹ️ {preview.got_sms_before} got an SMS before</Text>
                )}
              </>
            ) : (
              <ActivityIndicator color={colors.primary} />
            )}
          </View>

          {error && <Text style={ui.error}>{error}</Text>}
          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button
                title={`Send${willGet ? ` (${willGet})` : ''}`}
                onPress={send}
                loading={busy}
                disabled={!text.trim() || !sender || !preview || willGet === 0}
                fullWidth
              />
            </View>
          </View>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 110, textAlignVertical: 'top' },
  text: { fontSize: fontSize.body, color: colors.text },
  big: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  preview: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
  counts: { gap: 2 },
  buttons: { flexDirection: 'row', gap: spacing.sm },
});
