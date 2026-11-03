import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Modal } from '@/shared/ui/Modal';

import {
  autoCrop,
  canvasToJpeg,
  centerCrop,
  cutout,
  findHead,
  loadPic,
  render,
  turn,
  type Crop,
  type Pic,
} from '@/features/files/passport';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🪪 Passport photo editor (website): the automatic result first, then
//   move / zoom / turn, background on/off and colour, brightness.
//   "Use this" gives the exact-size picture back.
// =====================================================================

const SWATCHES = ['#CFE6FA', '#BFD9F2', '#E3F0FB', '#FFFFFF'];

export function PassportEditor({
  source,
  width,
  height,
  bgColor,
  facePct,
  title,
  onCancel,
  onDone,
}: {
  source: Blob;
  width: number;
  height: number;
  bgColor: string;
  facePct: number;
  title: string;
  onCancel: () => void;
  onDone: (picture: Blob) => void;
}) {
  const [photo, setPhoto] = useState<Pic | null>(null);
  const [person, setPerson] = useState<Pic | null>(null);
  const [auto, setAuto] = useState<Crop | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [bgOn, setBgOn] = useState(true);
  const [color, setColor] = useState(bgColor);
  const [bright, setBright] = useState(1);
  const [step, setStep] = useState<string | null>('Opening the photo…');
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const place = (p: Pic, cut: Pic | null) => {
    const head = cut ? findHead(cut) : null;
    const c = head ? autoCrop(head, p, width, height, facePct) : centerCrop(p, width, height);
    if (cut && !head) setNote('The face was not found: place it by hand (zoom and move).');
    setAuto(c);
    setCrop(c);
  };

  // Open → cut the person out → place the head
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const p = await loadPic(source);
        if (!live) return;
        setPhoto(p);
        setOriginal(p.toDataURL('image/jpeg', 0.7));
        setStep('Removing the background…');
        try {
          const cut = await cutout(p);
          if (!live) return;
          setPerson(cut);
          place(p, cut);
        } catch (e) {
          if (!live) return;
          setBgOn(false);
          setNote(
            `${e instanceof Error ? e.message : 'The background could not be removed.'} Place it by hand; the background stays.`,
          );
          place(p, null);
        }
      } catch {
        if (live) setNote('This picture could not be opened.');
      } finally {
        if (live) setStep(null);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // The picture as it will be saved
  const out = useMemo(() => {
    if (!photo || !crop) return null;
    return render(photo, person, crop, {
      width,
      height,
      background: bgOn && person ? color : null,
      brightness: bright,
    });
  }, [photo, person, crop, bgOn, color, bright, width, height]);

  useEffect(() => {
    setPreview(out ? out.toDataURL('image/jpeg', 0.9) : null);
  }, [out]);

  const zoom = (f: number) =>
    crop &&
    setCrop({ x: crop.x + (crop.w * (1 - f)) / 2, y: crop.y + (crop.h * (1 - f)) / 2, w: crop.w * f, h: crop.h * f });
  const move = (dx: number, dy: number) =>
    crop && setCrop({ ...crop, x: crop.x + dx * crop.w * 0.04, y: crop.y + dy * crop.h * 0.04 });
  const rotate = (right: boolean) => {
    if (!photo) return;
    const p = turn(photo, right);
    const c = person ? turn(person, right) : null;
    setPhoto(p);
    setPerson(c);
    setOriginal(p.toDataURL('image/jpeg', 0.7));
    setNote(null);
    place(p, c);
  };

  const use = async () => {
    if (!out) return;
    setSaving(true);
    try {
      onDone(await canvasToJpeg(out));
    } finally {
      setSaving(false);
    }
  };

  const boxH = 260;
  const boxW = Math.round((boxH * width) / height);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel} bottomFill={colors.surface}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onCancel} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>🪪 {title}</Text>
            <Text style={styles.sub}>
              {width} × {height} px · the head is placed by the passport rule. Check it, fix it if needed, then Use
              this.
            </Text>

            <View style={styles.previews}>
              <View style={styles.previewCol}>
                <Text style={styles.label}>Result</Text>
                <View style={[styles.frame, { width: boxW, height: boxH }]}>
                  {step ? (
                    <View style={styles.wait}>
                      <ActivityIndicator color={colors.primary} />
                      <Text style={styles.waitText}>{step}</Text>
                    </View>
                  ) : preview ? (
                    <Image
                      source={{ uri: preview }}
                      style={{ width: boxW, height: boxH }}
                      accessibilityLabel="Result"
                    />
                  ) : null}
                </View>
              </View>
              {!!original && (
                <View style={styles.previewCol}>
                  <Text style={styles.label}>Original</Text>
                  <Image
                    source={{ uri: original }}
                    style={styles.original}
                    resizeMode="contain"
                    accessibilityLabel="Original"
                  />
                </View>
              )}
            </View>

            {!!note && <Text style={styles.note}>⚠ {note}</Text>}

            {!step && crop && (
              <>
                <View style={styles.tools}>
                  <Tool label="－ Zoom out" onPress={() => zoom(1.08)} />
                  <Tool label="＋ Zoom in" onPress={() => zoom(0.92)} />
                  <Tool label="←" onPress={() => move(1, 0)} />
                  <Tool label="→" onPress={() => move(-1, 0)} />
                  <Tool label="↑" onPress={() => move(0, 1)} />
                  <Tool label="↓" onPress={() => move(0, -1)} />
                  <Tool label="↺" onPress={() => rotate(false)} />
                  <Tool label="↻" onPress={() => rotate(true)} />
                  <Tool label="☀ −" onPress={() => setBright(Math.max(0.6, bright - 0.08))} />
                  <Tool label="☀ +" onPress={() => setBright(Math.min(1.6, bright + 0.08))} />
                  {auto && <Tool label="↺ Auto" onPress={() => (setCrop(auto), setBright(1))} />}
                </View>

                {person && (
                  <View style={styles.bgRow}>
                    <Pressable
                      onPress={() => setBgOn(!bgOn)}
                      style={[styles.toggle, bgOn && styles.toggleOn]}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: bgOn }}
                    >
                      <Text style={[styles.toggleText, bgOn && styles.toggleTextOn]}>
                        {bgOn ? '✓ Background removed' : 'Original background'}
                      </Text>
                    </Pressable>
                    {bgOn &&
                      Array.from(new Set([bgColor, ...SWATCHES])).map((c) => (
                        <Pressable
                          key={c}
                          onPress={() => setColor(c)}
                          style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchOn]}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: color === c }}
                          accessibilityLabel={`Background ${c}`}
                        />
                      ))}
                  </View>
                )}
              </>
            )}

            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button title="Cancel" variant="secondary" onPress={onCancel} fullWidth />
              </View>
              <View style={styles.flex}>
                <Button title="✅ Use this" onPress={use} loading={saving} disabled={!out || !!step} fullWidth />
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Tool({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={(state) => [styles.tool, (state as { hovered?: boolean }).hovered && styles.toolHover]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.toolText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    maxHeight: '92%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted, marginTop: -spacing.xs },
  previews: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap', alignItems: 'flex-start' },
  previewCol: { gap: spacing.xs },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  frame: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  wait: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.md },
  waitText: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center' },
  original: { width: 170, height: 260, borderRadius: radius.sm, backgroundColor: colors.background },
  note: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tool: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toolHover: { borderColor: colors.primary },
  toolText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  bgRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  toggle: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  toggleText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  toggleTextOn: { color: colors.textOnPrimary },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  swatchOn: { borderWidth: 3, borderColor: colors.primary },
  buttons: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
});
