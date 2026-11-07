// =====================================================================
// ⚡ Remember answers that rarely change (stages, users, holidays, stars…)
//   · the same request made twice at the same moment goes out once
//   · the answer is reused for `ttlMs`; forget(key) after a change
//   Phones send only ~5 requests at a time to one server, so every request
//   saved here shortens the wait on a screen.
// =====================================================================

type Entry = { at: number; value?: unknown; pending?: Promise<unknown> };

const store = new Map<string, Entry>();

export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const e = store.get(key);
  if (e?.pending) return e.pending as Promise<T>;
  if (e && 'value' in e && now - e.at < ttlMs) return Promise.resolve(e.value as T);
  const pending = load().then(
    (value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    },
    (err) => {
      store.delete(key);
      throw err;
    },
  );
  store.set(key, { at: e?.at ?? 0, value: e?.value, pending });
  return pending;
}

/** Forget one key, or every key that starts with `prefix*` */
export function forget(key: string): void {
  if (key.endsWith('*')) {
    const p = key.slice(0, -1);
    for (const k of [...store.keys()]) if (k.startsWith(p)) store.delete(k);
  } else store.delete(key);
}

/** Put a known answer in (e.g. after toggling a star) */
export function remember<T>(key: string, value: T): void {
  store.set(key, { at: Date.now(), value });
}

/** The answer we have now, even if old (for showing something at once) */
export function peekMemo<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

/** On sign out: nothing from the last person stays */
export function forgetAll(): void {
  store.clear();
}
