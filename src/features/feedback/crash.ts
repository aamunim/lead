import AsyncStorage from '@react-native-async-storage/async-storage';

import { appInfo } from '@/features/feedback/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 💥 Crash reports: an error in the app is sent to the developer by itself.
//   - the same error (name + message + where in the code) has one
//     "signature", so it is counted on one row in the inbox
//   - no internet: kept on the phone (up to 20) and sent on the next start
//   - the screen it happened on goes with it
// =====================================================================

type Report = {
  signature: string;
  name: string;
  message: string;
  stack: string;
  screen: string;
  fatal: boolean;
  info: Record<string, string>;
  at: string;
};

const QUEUE_KEY = 'crash.queue';
const MAX_QUEUE = 20;

let currentScreen = '';
/** The root layout tells which screen is open */
export function setCrashScreen(path: string): void {
  currentScreen = path;
}

// The same error again within a minute is not sent again (e.g. a loop)
const recent = new Map<string, number>();

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Numbers, ids and line positions change; the kind of error does not */
function normalise(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstFrame(stack: string): string {
  const line = stack
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at ') || /@/.test(l));
  return (line ?? '').replace(/\(.*\)$/, '').replace(/@.*$/, '');
}

function toReport(error: unknown, fatal: boolean, screen?: string): Report {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
  const name = e.name || 'Error';
  const message = String(e.message ?? '').slice(0, 1000);
  const stack = String(e.stack ?? '').slice(0, 4000);
  return {
    signature: hash(`${name}|${normalise(message).slice(0, 200)}|${firstFrame(stack)}`),
    name,
    message,
    stack,
    screen: screen ?? currentScreen,
    fatal,
    info: appInfo(),
    at: new Date().toISOString(),
  };
}

async function readQueue(): Promise<Report[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as Report[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(list: Report[]): Promise<void> {
  try {
    if (list.length === 0) await AsyncStorage.removeItem(QUEUE_KEY);
    else await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-MAX_QUEUE)));
  } catch {
    // nothing more to do
  }
}

async function send(r: Report): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return false; // not signed in: keep it for later
    const { error } = await supabase.rpc('report_crash', {
      p_signature: r.signature,
      p_name: r.name,
      p_message: r.message,
      p_stack: r.stack,
      p_screen: r.screen,
      p_info: r.info as unknown as Json,
      p_fatal: r.fatal,
      p_at: r.at,
    });
    // An old database without the function: drop it, don't keep trying
    return !error || /could not find the function/i.test(error.message);
  } catch {
    return false;
  }
}

/** Sends one error (kept on the phone first, so a crash that closes the app still gets sent later) */
export async function reportCrash(error: unknown, opts: { fatal?: boolean; screen?: string } = {}): Promise<void> {
  try {
    const r = toReport(error, !!opts.fatal, opts.screen);
    const last = recent.get(r.signature);
    if (last && Date.now() - last < 60_000) return;
    recent.set(r.signature, Date.now());

    const queue = await readQueue();
    await writeQueue([...queue, r]);
    if (await send(r)) {
      const now = await readQueue();
      await writeQueue(now.filter((x) => !(x.signature === r.signature && x.at === r.at)));
    }
  } catch {
    // a crash report must never crash the app
  }
}

/** Sends what is waiting on the phone (app start, sign-in) */
export async function flushCrashes(): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;
  const left: Report[] = [];
  for (const r of queue) if (!(await send(r))) left.push(r);
  await writeQueue(left);
}

let installed = false;

/** Catches errors outside the screens (button handlers, timers); once, at start */
export function installCrashHandler(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler: () => (e: unknown, fatal?: boolean) => void;
      setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void;
    };
  };
  const eu = g.ErrorUtils;
  if (!eu) return; // the website
  const previous = eu.getGlobalHandler();
  eu.setGlobalHandler((error, fatal) => {
    if (!fatal) {
      reportCrash(error, { fatal: false });
      previous(error, fatal);
      return;
    }
    // Fatal: keep it on the phone first, then let the app close as before
    let passed = false;
    const pass = () => {
      if (passed) return;
      passed = true;
      previous(error, fatal);
    };
    const timer = setTimeout(pass, 1500);
    reportCrash(error, { fatal: true }).finally(() => {
      clearTimeout(timer);
      pass();
    });
  });
}
