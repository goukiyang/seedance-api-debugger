import { createHash } from 'node:crypto';
import { PaginationError, readPageCursor, writePageCursor } from '@/lib/pagination/cursor';
import { requireSecret } from '@/lib/security/secrets';

export async function* pickerRows<T extends { id: string }>(read: (after: string | null, take: number) => Promise<T[]>) {
  let after: string | null = null;
  for (;;) {
    const rows = await read(after, 100);
    if (rows.length > 100) throw new Error('picker_unbounded_source');
    for (const row of rows) yield row;
    if (rows.length < 100) return;
    const next = rows[rows.length - 1].id;
    if (next === after) throw new Error('picker_source_not_advancing');
    after = next;
  }
}
export const pickerSeek = (after: string | null) => after ? { id: { gt: after } } : {};
export const pickerFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The source emits each logical identity once. Keep only one candidate page,
// never all eligible identities. Offset compatibility uses bounded rescans.
export async function pickerPage<T>(options: {
  scan: () => AsyncIterable<T>; identity: (row: T) => string; fingerprint: (row: T) => string;
  compare: (a: T, b: T) => number; context: string; after: string | null; page: number; limit: number;
}) {
  const secret = requireSecret('media');
  let anchor: T | null = null;
  if (options.after) {
    const key = readPageCursor(options.after, options.context, secret);
    for await (const row of options.scan()) if (options.identity(row) === key[0]) {
      if (options.fingerprint(row) !== key[1]) throw new PaginationError(undefined, 409);
      anchor = row; break;
    }
    if (!anchor) throw new PaginationError(undefined, 409);
  }
  let selected: T[] = [], total = 0, unavailable = 0;
  const rounds = options.after ? 1 : options.page;
  for (let round = 0; round < rounds; round++) {
    selected = []; total = 0; unavailable = 0;
    for await (const row of options.scan()) {
      total++;
      if ((row as { unavailableReason?: string }).unavailableReason) unavailable++;
      if (anchor && options.compare(row, anchor) <= 0) continue;
      selected.push(row); selected.sort(options.compare);
      if (selected.length > options.limit + 1) selected.pop();
    }
    if (!options.after && (options.page - 1) * options.limit >= total) { selected = []; break; }
    if (round + 1 < rounds) anchor = selected[Math.min(selected.length, options.limit) - 1] || null;
  }
  const hasMore = selected.length > options.limit, items = selected.slice(0, options.limit);
  const last = items[items.length - 1];
  return { items, total, unavailable, page: options.page, hasMore,
    nextCursor: hasMore && last ? writePageCursor([options.identity(last), options.fingerprint(last)], options.context, secret) : null };
}
