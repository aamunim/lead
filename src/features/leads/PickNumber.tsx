import * as Contacts from 'expo-contacts/legacy';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  askContactsPermission,
  findExistingLeadPhones,
  loadPhoneContacts,
  type PhoneContact,
} from '@/features/contacts/api';
import { MIcon, md, type MIconName } from '@/features/home/md';
import { isValidBdMobile, normalizePhone } from '@/features/leads/api';
import { ago } from '@/features/leads/lastActivity';
import { isWeb } from '@/features/web/api';
import { colors, fontWeight } from '@/shared/theme';
import { disclose } from '@/shared/ui/Disclosure';
import { Modal } from '@/shared/ui/Modal';
import { hasRecentCalls, recentCalls, type RecentCall } from '../../../modules/call-log';

// =====================================================================
// 📇🕘 New lead: take the number from the phone's contacts (the app's own
//   searchable list, or the phone's contact picker) or from the recent
//   calls, instead of typing it. Numbers that are already leads say so.
//   Nothing from the contacts or the call log leaves the phone: only the
//   number that is picked goes into the form.
// =====================================================================

export type PickedNumber = { number: string; name: string | null };

/** The two small buttons under the Phone field (phone app only) */
export function PickNumberButtons({ onPick }: { onPick: (p: PickedNumber) => void }) {
  const [open, setOpen] = useState<'contacts' | 'recent' | null>(null);
  if (isWeb) return null;
  const pick = (p: PickedNumber) => {
    setOpen(null);
    onPick(p);
  };
  return (
    <>
      <View style={s.buttons}>
        <SmallBtn icon="contacts" label="From contacts" onPress={() => setOpen('contacts')} />
        {Platform.OS === 'android' && hasRecentCalls && (
          <SmallBtn icon="history" label="From recent calls" onPress={() => setOpen('recent')} />
        )}
      </View>
      {open === 'contacts' && <ContactsSheet onClose={() => setOpen(null)} onPick={pick} />}
      {open === 'recent' && <RecentSheet onClose={() => setOpen(null)} onPick={pick} />}
    </>
  );
}

function SmallBtn({ icon, label, onPress }: { icon: MIconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: md.ripple, foreground: true }}
      style={({ pressed }) => [s.small, Platform.OS !== 'android' && pressed && s.pressed]}
      accessibilityRole="button"
    >
      <MIcon name={icon} size={17} color={md.onPrimaryC} />
      <Text style={s.smallText}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------
// The sheet frame (title, search, list)
// ---------------------------------------------------------------------
function Sheet({
  title,
  onClose,
  search,
  onSearch,
  placeholder,
  top,
  children,
}: {
  title: string;
  onClose: () => void;
  search: string;
  onSearch: (t: string) => void;
  placeholder: string;
  top?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={s.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={s.sheet}>
          <View style={s.handle} />
          <View style={s.head}>
            <Text style={s.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <MIcon name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          <View style={s.search}>
            <MIcon name="search" size={20} color={colors.textMuted} />
            <TextInput
              value={search}
              onChangeText={onSearch}
              placeholder={placeholder}
              placeholderTextColor={colors.textMuted}
              style={s.searchInput}
              autoCorrect={false}
            />
            {!!search && (
              <Pressable onPress={() => onSearch('')} hitSlop={8} accessibilityLabel="Clear search">
                <MIcon name="close" size={18} color={colors.textMuted} />
              </Pressable>
            )}
          </View>
          {top}
          {children}
        </View>
      </View>
    </Modal>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={s.center}>{children}</View>;
}

const digits = (t: string) => t.replace(/\D/g, '');

function useExisting(numbers: string[]) {
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const key = numbers.join(',');
  useEffect(() => {
    if (numbers.length === 0) return;
    let live = true;
    findExistingLeadPhones(numbers)
      .then((set) => live && setExisting(set))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return existing;
}

// ---------------------------------------------------------------------
// 📇 Contacts: the app's own list (search, ✓ already a lead) + the phone's picker
// ---------------------------------------------------------------------
function ContactsSheet({ onClose, onPick }: { onClose: () => void; onPick: (p: PickedNumber) => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'blocked'>('loading');
  const [contacts, setContacts] = useState<PhoneContact[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    askContactsPermission()
      .then(async (p) => {
        if (p.status !== 'granted') return setState(p.canAskAgain ? 'denied' : 'blocked');
        setContacts(await loadPhoneContacts());
        setState('ready');
      })
      .catch(() => setState('denied'));
  }, []);

  const existing = useExisting(useMemo(() => contacts.flatMap((c) => c.numbers.map((n) => n.normalized)), [contacts]));

  const shown = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return contacts;
    const d = digits(t);
    return contacts.filter(
      (c) => c.name.toLowerCase().includes(t) || (d.length >= 3 && c.numbers.some((n) => n.normalized.includes(d))),
    );
  }, [contacts, search]);

  const choose = (name: string, numbers: { normalized: string; label: string | null }[]) => {
    const good = numbers.filter((n) => isValidBdMobile(n.normalized));
    const list = good.length > 0 ? good : numbers;
    if (list.length === 1) return onPick({ number: list[0].normalized, name });
    Alert.alert(
      name,
      'Which number?',
      [
        ...list.slice(0, 4).map((n) => ({
          text: `${n.normalized}${n.label ? ` (${n.label})` : ''}`,
          onPress: () => onPick({ number: n.normalized, name }),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
      { cancelable: true },
    );
  };

  // The phone's own contact picker
  const systemPicker = async () => {
    try {
      const c = await Contacts.presentContactPickerAsync();
      if (!c) return;
      const name = (c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')).trim() || '';
      const numbers = (c.phoneNumbers ?? [])
        .map((p) => ({ normalized: normalizePhone((p.number ?? p.digits ?? '').trim()), label: p.label ?? null }))
        .filter((n) => !!n.normalized);
      if (numbers.length === 0) return Alert.alert('No number', `${name || 'This contact'} has no phone number.`);
      choose(name, numbers);
    } catch {
      Alert.alert('Could not open', 'The phone’s contact picker is not available here.');
    }
  };

  return (
    <Sheet
      title="📇 Pick from contacts"
      onClose={onClose}
      search={search}
      onSearch={setSearch}
      placeholder="Search a name or number"
      top={
        <Pressable onPress={systemPicker} style={s.systemBtn} accessibilityRole="button">
          <MIcon name="perm-contact-calendar" size={18} color={colors.primary} />
          <Text style={s.systemText}>Open the phone’s contact picker</Text>
        </Pressable>
      }
    >
      {state === 'loading' ? (
        <Center>
          <ActivityIndicator color={colors.primary} />
        </Center>
      ) : state !== 'ready' ? (
        <Center>
          <Text style={s.muted}>
            The app may not read your contacts. You can still use the phone’s contact picker above.
          </Text>
          {state === 'blocked' && (
            <Pressable onPress={() => Linking.openSettings()} style={s.linkBtn} accessibilityRole="button">
              <Text style={s.link}>Open settings to allow</Text>
            </Pressable>
          )}
        </Center>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={20}
          ListEmptyComponent={
            <Center>
              <Text style={s.muted}>{search ? 'No contact found.' : 'No contacts with a number.'}</Text>
            </Center>
          }
          renderItem={({ item }) => {
            const first = item.numbers[0];
            const lead = item.numbers.some((n) => existing.has(n.normalized));
            return (
              <Row
                initial={item.name}
                title={item.name}
                sub={`${first.normalized}${item.numbers.length > 1 ? ` · +${item.numbers.length - 1} more` : ''}`}
                lead={lead}
                onPress={() => choose(item.name, item.numbers)}
              />
            );
          }}
        />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// 🕘 Recent calls (Android): one line per number, newest first
// ---------------------------------------------------------------------
const DIR: Record<string, { icon: MIconName; color: string; label: string }> = {
  incoming: { icon: 'call-received', color: md.onOkC, label: 'Incoming' },
  outgoing: { icon: 'call-made', color: colors.primary, label: 'Outgoing' },
  missed: { icon: 'call-missed', color: md.onErrorC, label: 'Missed' },
  rejected: { icon: 'call-end', color: md.onErrorC, label: 'Rejected' },
  other: { icon: 'call', color: colors.textMuted, label: 'Call' },
};

function RecentSheet({ onClose, onPick }: { onClose: () => void; onPick: (p: PickedNumber) => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'blocked'>('loading');
  const [calls, setCalls] = useState<RecentCall[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      const perm = PermissionsAndroid.PERMISSIONS.READ_CALL_LOG;
      let ok = await PermissionsAndroid.check(perm);
      if (!ok) {
        if (!(await disclose('calls'))) return setState('denied');
        const r = await PermissionsAndroid.request(perm);
        if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return setState('blocked');
        ok = r === PermissionsAndroid.RESULTS.GRANTED;
      }
      if (!ok) return setState('denied');
      setCalls(await recentCalls(80));
      setState('ready');
    })().catch(() => setState('denied'));
  }, []);

  const existing = useExisting(useMemo(() => calls.map((c) => c.number), [calls]));

  const shown = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return calls;
    const d = digits(t);
    return calls.filter((c) => (c.name ?? '').toLowerCase().includes(t) || (d.length >= 3 && c.number.includes(d)));
  }, [calls, search]);

  return (
    <Sheet
      title="🕘 Pick from recent calls"
      onClose={onClose}
      search={search}
      onSearch={setSearch}
      placeholder="Search a name or number"
    >
      {state === 'loading' ? (
        <Center>
          <ActivityIndicator color={colors.primary} />
        </Center>
      ) : state !== 'ready' ? (
        <Center>
          <Text style={s.muted}>The app needs to read the call log to show your recent calls.</Text>
          {state === 'blocked' && (
            <Pressable onPress={() => Linking.openSettings()} style={s.linkBtn} accessibilityRole="button">
              <Text style={s.link}>Open settings to allow</Text>
            </Pressable>
          )}
        </Center>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(c) => c.number}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Center>
              <Text style={s.muted}>{search ? 'No call found.' : 'No recent calls.'}</Text>
            </Center>
          }
          renderItem={({ item }) => {
            const d = DIR[item.direction] ?? DIR.other;
            return (
              <Row
                icon={d.icon}
                iconColor={d.color}
                title={item.name ?? item.number}
                sub={[item.name ? item.number : null, `${d.label} · ${ago(item.calledAt)}`].filter(Boolean).join(' · ')}
                lead={existing.has(item.number)}
                onPress={() => onPick({ number: item.number, name: item.name })}
              />
            );
          }}
        />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------
function Row({
  initial,
  icon,
  iconColor,
  title,
  sub,
  lead,
  onPress,
}: {
  initial?: string;
  icon?: MIconName;
  iconColor?: string;
  title: string;
  sub: string;
  lead: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: md.ripple }}
      style={({ pressed }) => [s.row, Platform.OS !== 'android' && pressed && s.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${title}${lead ? ', already a lead' : ''}`}
    >
      <View style={s.rowIcon}>
        {icon ? (
          <MIcon name={icon} size={18} color={iconColor ?? colors.textMuted} />
        ) : (
          <Text style={s.rowInitial}>{(initial?.trim()[0] ?? '?').toUpperCase()}</Text>
        )}
      </View>
      <View style={s.flex}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.rowSub} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      {lead && <Text style={s.leadPill}>✓ Lead</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: -4 },
  small: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: md.primaryC,
    overflow: 'hidden',
  },
  smallText: { fontSize: 13, fontWeight: fontWeight.semibold, color: md.onPrimaryC },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    height: '82%',
    paddingTop: 8,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: colors.surface,
  },
  handle: { alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: md.outline },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  title: { flex: 1, fontSize: 17, fontWeight: fontWeight.bold, color: colors.text },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: md.surface2,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 0 },
  systemBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  systemText: { fontSize: 14, fontWeight: fontWeight.semibold, color: colors.primary },
  center: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  muted: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
  linkBtn: { paddingVertical: 6 },
  link: { fontSize: 14, fontWeight: fontWeight.semibold, color: colors.primary },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 58 },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: md.surface1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInitial: { fontSize: 15, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
  rowTitle: { fontSize: 15, fontWeight: fontWeight.medium, color: colors.text },
  rowSub: { fontSize: 12.5, color: colors.textMuted, marginTop: 1 },
  leadPill: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: md.onOkC,
    backgroundColor: md.okC,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    overflow: 'hidden',
  },
});
