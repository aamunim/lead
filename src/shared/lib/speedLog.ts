// =====================================================================
// ⏱ Speed log: how long each request to the server takes (this phone,
//   since the app opened). Only the address and the time are kept, never
//   what was sent or received. More → Speed check shows and sends it.
// =====================================================================

export type SpeedEntry = { key: string; ms: number; ok: boolean; at: number };

const MAX = 400;
const log: SpeedEntry[] = [];

/** "/rest/v1/leads (count)", "/rpc/chat_unread", "/storage/…" */
export function speedKey(url: string, method: string, headers?: HeadersInit): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep as it is
  }
  path = path.replace(/^\/rest\/v1\/rpc\//, '/rpc/').replace(/^\/rest\/v1\//, '/');
  if (path.startsWith('/storage/')) path = '/storage';
  const h = headers ? new Headers(headers) : null;
  const prefer = h?.get('prefer') ?? '';
  const plain = method === 'GET' || (method === 'POST' && path.startsWith('/rpc/'));
  const kind = method === 'HEAD' || /count=exact/.test(prefer) ? ' (count)' : plain ? '' : ` ${method}`;
  return `${path}${kind}`;
}

export function recordSpeed(e: SpeedEntry) {
  log.push(e);
  if (log.length > MAX) log.splice(0, log.length - MAX);
}

export function speedEntries(): SpeedEntry[] {
  return [...log];
}

export type SpeedSummary = { key: string; count: number; avg: number; max: number; failed: number };

/** Each kind of request: how many, average and slowest */
export function speedSummary(): SpeedSummary[] {
  const by = new Map<string, SpeedEntry[]>();
  log.forEach((e) => by.set(e.key, [...(by.get(e.key) ?? []), e]));
  return [...by.entries()]
    .map(([key, list]) => ({
      key,
      count: list.length,
      avg: Math.round(list.reduce((n, e) => n + e.ms, 0) / list.length),
      max: Math.round(Math.max(...list.map((e) => e.ms))),
      failed: list.filter((e) => !e.ok).length,
    }))
    .sort((a, b) => b.avg * b.count - a.avg * a.count);
}

export function clearSpeed() {
  log.splice(0, log.length);
}
