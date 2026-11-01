// =====================================================================
// 🌐 Small helpers for the website: choices remembered in this browser,
//   and keyboard shortcuts.
// =====================================================================

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or blocked storage: just not remembered
  }
}

/** Listen to key presses on the page; returns the "stop" function */
export function onKey(handler: (e: KeyboardEvent) => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

/** True while typing in a box, or while a dialog is open (shortcuts wait) */
export function typingInField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return true;
  return e.ctrlKey || e.metaKey || e.altKey;
}

/** Is a dialog (sheet, alert) open over the page? */
export function dialogOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]');
}
