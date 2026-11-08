import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Alert } from 'react-native';

import { markCallFromApp } from '@/features/call-sync/api';
import { openWhatsApp } from '@/features/leads/contact';

import { AlumniContactSheet } from './AlumniContactSheet';
import type { Alumnus } from './api';
import { alumniChanged } from './ui';

// =====================================================================
// 📞 Call / 💬 WhatsApp an alumnus straight from a list (no page opens).
//   When the user comes back to the app, the same popup as on the alumnus
//   page asks what happened, a note and the next contact.
// =====================================================================

type Who = Pick<Alumnus, 'id' | 'name' | 'phone' | 'whatsapp_number'>;

function say(text: string) {
  if (Platform.OS === 'web') window.alert(text);
  else Alert.alert('Could not open', text);
}

type Pending = { who: Who; channel: 'phone' | 'whatsapp'; at: number; left: boolean };

/** The phone / WhatsApp never came up (e.g. the website, no app for tel:): forget it */
function forgetIfStayed(ref: { current: Pending | null }) {
  const mine = ref.current;
  setTimeout(() => {
    if (ref.current === mine && mine && !mine.left) ref.current = null;
  }, 15_000);
}

export function useAlumniDialer() {
  const [popup, setPopup] = useState<{ who: Who; channel: 'phone' | 'whatsapp'; seconds: number } | null>(null);
  const pending = useRef<Pending | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const p = pending.current;
      if (!p) return;
      if (state === 'background' || state === 'inactive') {
        p.left = true;
        return;
      }
      if (state === 'active' && p.left) {
        pending.current = null;
        // a call from hours ago (the phone app never really opened): no popup
        if (Date.now() - p.at > 3 * 3600_000) return;
        setPopup({ who: p.who, channel: p.channel, seconds: Math.round((Date.now() - p.at) / 1000) });
      }
    });
    return () => sub.remove();
  }, []);

  const call = useCallback(async (who: Who) => {
    if (!who.phone) return;
    pending.current = { who, channel: 'phone', at: Date.now(), left: false };
    forgetIfStayed(pending);
    // the app shows its own popup for this call: no "add a note" alert
    markCallFromApp(who.phone);
    try {
      await Linking.openURL(`tel:${who.phone}`);
    } catch {
      pending.current = null;
      say('Could not open the phone app.');
    }
  }, []);

  const whatsapp = useCallback(async (who: Who) => {
    pending.current = { who, channel: 'whatsapp', at: Date.now(), left: false };
    forgetIfStayed(pending);
    const ok = await openWhatsApp({ phone: who.phone, whatsapp_number: who.whatsapp_number });
    if (!ok) {
      pending.current = null;
      say('Could not open WhatsApp.');
    }
  }, []);

  const sheet = popup ? (
    <AlumniContactSheet
      alumnus={{ id: popup.who.id, name: popup.who.name, phone: popup.who.phone }}
      channel={popup.channel}
      estimatedSec={popup.seconds}
      onClose={() => setPopup(null)}
      onSaved={() => {
        setPopup(null);
        alumniChanged();
      }}
    />
  ) : null;

  return { call, whatsapp, sheet };
}
