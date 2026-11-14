import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_BRAND,
  DEFAULT_WEB_POINTS,
  getBrandSaved,
  saveBrand,
  uploadLogo,
  type BrandSaved,
  type WebPoint,
} from '@/features/brand/brand';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🎨 Settings → Branding (Super Admin): the logo, names, words and
//   colours on the sign-in pages (phone and website), Home and the
//   website menu. An empty field uses the app's own words. Everyone
//   sees the change the next time the app or website opens.
// =====================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OWN_LOGO = require('../../../../assets/web/ittc-logo-192.png');

const HEX = /^#[0-9A-Fa-f]{6}$/;
const SWATCHES = ['#1D3FA8', '#0B2A4A', '#0F766E', '#7C3AED', '#B91C1C', '#C2410C', '#15803D', '#111827'];

function say(title: string, text: string) {
  // eslint-disable-next-line no-alert
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

function ask(title: string, text: string, ok: string, run: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${text}`)) run();
    return;
  }
  Alert.alert(title, text, [
    { text: 'Cancel', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: run },
  ]);
}

export default function BrandingScreen() {
  const { profile } = useAuth();
  const superAdmin = profile?.role_key === 'super_admin';
  const [b, setB] = useState<BrandSaved>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBrandSaved()
      .then(setB)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
      .finally(() => setLoading(false));
  }, []);

  const put = (patch: BrandSaved) => {
    setB((cur) => ({ ...cur, ...patch }));
    setDirty(true);
  };
  const text = (k: keyof BrandSaved) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const points: WebPoint[] = Array.isArray(b.web_points) ? b.web_points : DEFAULT_WEB_POINTS;
  const setPoints = (next: WebPoint[]) => put({ web_points: next });

  const badColor = (['hero_color', 'web_color', 'accent_color'] as const).find(
    (k) => text(k).trim() !== '' && !HEX.test(text(k).trim()),
  );

  const pickLogo = async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ip = require('expo-image-picker') as typeof import('expo-image-picker');
    const res = await ip.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.9 });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if (a.fileSize && a.fileSize > 1024 * 1024) return say('Too big', 'Choose a picture of 1 MB at most.');
    setUploading(true);
    try {
      put({ logo_url: await uploadLogo(a.uri, a.mimeType ?? 'image/png') });
    } catch (e) {
      say('Could not upload', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (badColor) return setError('A colour must look like #1D3FA8.');
    setSaving(true);
    setError(null);
    try {
      // trimmed; empty texts are left out (the app's own words show)
      const clean: BrandSaved = {};
      for (const [k, v] of Object.entries(b)) {
        if (typeof v === 'string') {
          if (v.trim())
            (clean as Record<string, unknown>)[k] = k.endsWith('_color') ? v.trim().toUpperCase() : v.trim();
        } else if (k === 'web_points') {
          (clean as Record<string, unknown>)[k] = (v as WebPoint[])
            .map((p) => ({ icon: p.icon.trim(), text: p.text.trim() }))
            .filter((p) => p.text);
        } else if (v !== null && v !== undefined) {
          (clean as Record<string, unknown>)[k] = v;
        }
      }
      await saveBrand(clean);
      setB(clean);
      setDirty(false);
      say('Saved', 'Everyone sees it the next time the app or website opens.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const reset = () =>
    ask('Back to the original?', 'The ITTC logo, names, words and colours come back.', 'Reset', async () => {
      setSaving(true);
      setError(null);
      try {
        await saveBrand({});
        setB({});
        setDirty(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save.');
      } finally {
        setSaving(false);
      }
    });

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Branding' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const heroColor = HEX.test(text('hero_color')) ? text('hero_color') : DEFAULT_BRAND.hero_color;
  const webColor = HEX.test(text('web_color')) ? text('web_color') : DEFAULT_BRAND.web_color;
  const accent = HEX.test(text('accent_color')) ? text('accent_color') : DEFAULT_BRAND.accent_color;
  const logo = b.logo_url ? { uri: b.logo_url } : OWN_LOGO;
  const ph = (k: keyof typeof DEFAULT_BRAND) => String(DEFAULT_BRAND[k]);

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Branding' }} />

      {!superAdmin && (
        <Text style={styles.warn}>Only the Super Admin can change the branding. You can look at it here.</Text>
      )}

      {/* 👀 Preview */}
      <Text style={styles.section}>PREVIEW</Text>
      <View style={styles.previews}>
        <View style={[styles.phoneHero, { backgroundColor: heroColor }]}>
          <View style={styles.logoRing}>
            <Image source={logo} style={styles.logoSmall} accessibilityLabel="Logo" />
          </View>
          <Text style={styles.heroCollege} numberOfLines={2}>
            {text('college') || ph('college')}
          </Text>
          <Text style={styles.heroProduct} numberOfLines={1}>
            🎓 {text('product') || ph('product')}
          </Text>
          <Text style={styles.heroCaption}>Phone sign-in</Text>
        </View>
        <View style={[styles.phoneHero, { backgroundColor: webColor }]}>
          <Image source={logo} style={styles.logoSmall} accessibilityLabel="Logo" />
          <Text style={styles.heroCollege} numberOfLines={2}>
            {text('college') || ph('college')}
          </Text>
          <View style={[styles.rule, { backgroundColor: accent }]} />
          <Text style={styles.heroProduct} numberOfLines={1}>
            {text('web_title') || text('system') || ph('system')}
          </Text>
          <Text style={styles.heroCaption}>Website sign-in</Text>
        </View>
      </View>

      {/* 🖼 Logo */}
      <Text style={styles.section}>LOGO</Text>
      <View style={styles.card}>
        <View style={styles.logoRow}>
          <View style={styles.logoBox}>
            <Image source={logo} style={styles.logoBig} accessibilityLabel="Logo" />
          </View>
          <View style={styles.flex}>
            <Text style={styles.muted}>
              {b.logo_url ? 'Your own logo.' : 'The ITTC logo (the app’s own).'} A square PNG with a clear background
              looks best (1 MB at most).
            </Text>
          </View>
        </View>
        {superAdmin && (
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button
                title={uploading ? 'Uploading…' : '🖼 Choose a picture'}
                onPress={pickLogo}
                disabled={uploading}
                fullWidth
              />
            </View>
            {!!b.logo_url && (
              <View style={styles.flex}>
                <Button title="Use the ITTC logo" variant="ghost" onPress={() => put({ logo_url: null })} fullWidth />
              </View>
            )}
          </View>
        )}
      </View>

      {/* 🏷 Names */}
      <Text style={styles.section}>NAMES</Text>
      <View style={styles.card}>
        <TextField
          label="Short name"
          value={text('short_name')}
          onChangeText={(v) => put({ short_name: v })}
          placeholder={ph('short_name')}
          maxLength={20}
          editable={superAdmin}
          hint="Website menu, page titles, the line at the bottom of More"
        />
        <TextField
          label="College name"
          value={text('college')}
          onChangeText={(v) => put({ college: v })}
          placeholder={ph('college')}
          maxLength={120}
          editable={superAdmin}
        />
        <TextField
          label="App name (phone)"
          value={text('product')}
          onChangeText={(v) => put({ product: v })}
          placeholder={ph('product')}
          maxLength={120}
          editable={superAdmin}
        />
        <TextField
          label="System name (website)"
          value={text('system')}
          onChangeText={(v) => put({ system: v })}
          placeholder={ph('system')}
          maxLength={120}
          editable={superAdmin}
        />
      </View>

      {/* 📱 Phone sign-in */}
      <Text style={styles.section}>SIGN-IN PAGE</Text>
      <View style={styles.card}>
        <TextField
          label="Welcome line"
          value={text('login_title')}
          onChangeText={(v) => put({ login_title: v })}
          placeholder={ph('login_title')}
          maxLength={120}
          editable={superAdmin}
        />
        <TextField
          label="A short note under it (optional)"
          value={text('login_note')}
          onChangeText={(v) => put({ login_note: v })}
          placeholder="e.g. For ITTC admission staff only."
          maxLength={200}
          editable={superAdmin}
          multiline
        />
        <TextField
          label="Line above “Create an account”"
          value={text('login_footer')}
          onChangeText={(v) => put({ login_footer: v })}
          placeholder={ph('login_footer')}
          maxLength={120}
          editable={superAdmin}
        />
        <ColorField
          label="Phone sign-in colour (top)"
          value={text('hero_color')}
          fallback={DEFAULT_BRAND.hero_color}
          onChange={(v) => put({ hero_color: v })}
          editable={superAdmin}
        />
      </View>

      {/* 🌐 Website sign-in */}
      <Text style={styles.section}>WEBSITE SIGN-IN PAGE</Text>
      <View style={styles.card}>
        <TextField
          label="Line under the college name"
          value={text('web_title')}
          onChangeText={(v) => put({ web_title: v })}
          placeholder={text('system') || ph('system')}
          maxLength={200}
          editable={superAdmin}
        />
        <Text style={styles.label}>Points (at most 5)</Text>
        {points.map((p, i) => (
          <View key={i} style={styles.pointRow}>
            <View style={styles.iconField}>
              <TextField
                label="Icon"
                value={p.icon}
                onChangeText={(v) => setPoints(points.map((x, j) => (j === i ? { ...x, icon: v.slice(0, 8) } : x)))}
                editable={superAdmin}
              />
            </View>
            <View style={styles.flex}>
              <TextField
                label={`Point ${i + 1}`}
                value={p.text}
                onChangeText={(v) => setPoints(points.map((x, j) => (j === i ? { ...x, text: v } : x)))}
                maxLength={100}
                editable={superAdmin}
              />
            </View>
            {superAdmin && (
              <Pressable
                onPress={() => setPoints(points.filter((_, j) => j !== i))}
                style={styles.remove}
                accessibilityRole="button"
                accessibilityLabel={`Remove point ${i + 1}`}
                hitSlop={8}
              >
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            )}
          </View>
        ))}
        {superAdmin && points.length < 5 && (
          <Button
            title="➕ Add a point"
            variant="ghost"
            onPress={() => setPoints([...points, { icon: '⭐', text: '' }])}
            fullWidth
          />
        )}
        <TextField
          label="Copyright line"
          value={text('copyright')}
          onChangeText={(v) => put({ copyright: v })}
          placeholder={`© ${new Date().getFullYear()} ${text('college') || ph('college')}`}
          maxLength={120}
          editable={superAdmin}
        />
        <ColorField
          label="Website sign-in colour (left side)"
          value={text('web_color')}
          fallback={DEFAULT_BRAND.web_color}
          onChange={(v) => put({ web_color: v })}
          editable={superAdmin}
        />
        <ColorField
          label="Line colour (under the college name)"
          value={text('accent_color')}
          fallback={DEFAULT_BRAND.accent_color}
          onChange={(v) => put({ accent_color: v })}
          editable={superAdmin}
        />
      </View>

      {/* 🏠 Home */}
      <Text style={styles.section}>HOME</Text>
      <View style={styles.card}>
        <SwitchRow
          title="App and college name in the top bar"
          value={b.home_names !== false}
          onChange={(v) => put({ home_names: v })}
          editable={superAdmin}
        />
        <SwitchRow
          title="“Good morning, Name” line"
          value={b.home_greeting !== false}
          onChange={(v) => put({ home_greeting: v })}
          editable={superAdmin}
        />
      </View>

      <Text style={styles.muted}>
        The phone’s app icon, the opening screen and the Play Store name are part of the app itself; they change only
        with a new app build.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}
      {superAdmin && (
        <View style={styles.actions}>
          <Button
            title={saving ? 'Saving…' : 'Save'}
            onPress={save}
            disabled={saving || uploading || !dirty}
            fullWidth
          />
          <Button title="Reset to the original" variant="ghost" onPress={reset} disabled={saving} fullWidth />
        </View>
      )}
    </KeyboardAwareScrollView>
  );
}

function ColorField({
  label,
  value,
  fallback,
  onChange,
  editable,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
  editable: boolean;
}) {
  const shown = HEX.test(value.trim()) ? value.trim() : fallback;
  return (
    <View style={styles.colorBlock}>
      <View style={styles.colorRow}>
        <View style={[styles.swatchBig, { backgroundColor: shown }]} />
        <View style={styles.flex}>
          <TextField
            label={label}
            value={value}
            onChangeText={(v) => onChange(v.startsWith('#') || !v ? v : `#${v}`)}
            placeholder={fallback}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={7}
            editable={editable}
          />
        </View>
      </View>
      {editable && (
        <View style={styles.swatches}>
          {SWATCHES.map((c) => (
            <Pressable
              key={c}
              onPress={() => onChange(c)}
              style={[styles.swatch, { backgroundColor: c }, shown.toUpperCase() === c && styles.swatchOn]}
              accessibilityRole="button"
              accessibilityLabel={`Colour ${c}`}
            />
          ))}
          <Pressable onPress={() => onChange('')} style={styles.swatchReset} accessibilityRole="button">
            <Text style={styles.swatchResetText}>Original</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function SwitchRow({
  title,
  value,
  onChange,
  editable,
}: {
  title: string;
  value: boolean;
  onChange: (v: boolean) => void;
  editable: boolean;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={[styles.flex, styles.switchText]}>{title}</Text>
      <Switch value={value} onValueChange={onChange} disabled={!editable} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl * 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, marginTop: spacing.sm },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  warn: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    color: colors.text,
    fontSize: fontSize.small,
  },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  error: { fontSize: fontSize.small, color: colors.danger },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm },
  previews: { flexDirection: 'row', gap: spacing.sm },
  phoneHero: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
    minHeight: 170,
  },
  logoRing: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoSmall: { width: 36, height: 36, resizeMode: 'contain' },
  heroCollege: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: '#FFFFFF', textAlign: 'center' },
  heroProduct: { fontSize: fontSize.caption, color: 'rgba(255,255,255,0.85)', textAlign: 'center' },
  heroCaption: { marginTop: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.6)' },
  rule: { width: 28, height: 3, borderRadius: 2 },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  logoBox: {
    width: 84,
    height: 84,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  logoBig: { width: 68, height: 68, resizeMode: 'contain' },
  pointRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  iconField: { width: 64 },
  remove: { paddingBottom: 14, paddingHorizontal: 4 },
  removeText: { fontSize: fontSize.body, color: colors.textMuted },
  colorBlock: { gap: spacing.sm },
  colorRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md },
  swatchBig: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    marginBottom: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  swatch: { width: 28, height: 28, borderRadius: 14 },
  swatchOn: { borderWidth: 3, borderColor: colors.text },
  swatchReset: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  swatchResetText: { fontSize: fontSize.caption, color: colors.textMuted },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchText: { fontSize: fontSize.body, color: colors.text },
  actions: { gap: spacing.sm },
});
