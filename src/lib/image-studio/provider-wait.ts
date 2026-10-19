export type StudioProviderWaitSource = 'retry-after-seconds' | 'retry-after-date' | 'body' | 'combined' | 'invalid-conservative';
export type StudioProviderWait = { providerNotBefore?: number; providerWaitSource?: StudioProviderWaitSource };
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
const INVALID_WAIT_MS = 24 * 60 * 60_000;

/** Convert only observed provider delays to the local receive clock. Never clamp a valid wait down. */
export function parseStudioProviderWait(headers: Headers, body: unknown, now = Date.now()): StudioProviderWait {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('provider_wait_clock_invalid');
  const candidates: Array<{ delay: number; source: StudioProviderWaitSource }> = [];
  const invalid = () => candidates.push({ delay: INVALID_WAIT_MS, source: 'invalid-conservative' });
  const raw = headers.get('retry-after');
  if (raw !== null) {
    const value = raw.trim();
    if (/^\d+$/.test(value)) {
      const ms = Number(value) * 1000;
      if (Number.isFinite(ms) && ms >= 0 && ms <= MAX_WAIT_MS) candidates.push({ delay: Math.ceil(ms), source: 'retry-after-seconds' });
      else invalid();
    } else if (/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(value)) {
      const date = Date.parse(value), ms = date - now;
      if (Number.isFinite(date) && ms <= MAX_WAIT_MS) candidates.push({ delay: Math.max(0, ms), source: 'retry-after-date' });
      else invalid();
    } else invalid();
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>).poll_after_ms;
    if (value !== undefined) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_WAIT_MS) candidates.push({ delay: value, source: 'body' });
      else invalid();
    }
  }
  if (!candidates.length) return {};
  const latest = candidates.reduce((a, b) => a.delay >= b.delay ? a : b);
  return { providerNotBefore: now + latest.delay, providerWaitSource: candidates.some(value => value.source === 'invalid-conservative')
    ? 'invalid-conservative' : candidates.length > 1 ? 'combined' : latest.source };
}

export function validStudioProviderWait(value: StudioProviderWait): boolean {
  return value.providerNotBefore === undefined && value.providerWaitSource === undefined
    || Number.isSafeInteger(value.providerNotBefore) && Number(value.providerNotBefore) > 0
      && ['retry-after-seconds', 'retry-after-date', 'body', 'combined', 'invalid-conservative'].includes(value.providerWaitSource || '');
}

export function studioProviderNextCheckAt(local: number, receipt?: StudioProviderWait | null) {
  return Math.max(local, receipt?.providerNotBefore || 0);
}

/** An unparseable/out-of-domain instruction is not permission to make an earlier GET. */
export function studioProviderWaitBlocked(receipt?: StudioProviderWait | null, now = Date.now()) {
  return receipt?.providerWaitSource === 'invalid-conservative' || (receipt?.providerNotBefore || 0) > now;
}
