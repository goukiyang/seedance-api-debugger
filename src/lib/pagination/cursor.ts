import { createHmac, timingSafeEqual } from 'node:crypto';

export type PageInfo = { limit: number; total: number; hasMore: boolean; nextCursor: string | null };
export type PageKey = Array<string | number>;
export class PaginationError extends Error {
  constructor(message = '分页位置无效，请刷新列表', public status = 400) { super(message); }
}
export function pageLimit(params: URLSearchParams) {
  const raw = params.get('limit');
  if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw)))) throw new PaginationError('分页数量无效');
  return Math.min(raw === null ? 24 : Number(raw), 100);
}
export function assertPageOwner(headers: Headers, userId: string) {
  const expected = headers.get('x-upload-owner-id');
  if (expected && expected !== userId) throw new PaginationError('当前账号已变化，请重新读取图集', 409);
}
const mac = (secret: Buffer, text: string) => createHmac('sha256', secret).update(`collection-page-v1:${text}`).digest('hex');
function readCursor(cursor: string, context: string, secret: Buffer): PageKey {
  if (cursor.length > 2048) throw new PaginationError();
  const [body, signature, extra] = cursor.split('.');
  if (!body || !/^[a-f0-9]{64}$/.test(signature || '') || extra || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(mac(secret, body), 'hex'))) throw new PaginationError();
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.scope !== mac(secret, context) || !Array.isArray(value.key) || !value.key.length || value.key.length > 5
      || !value.key.every((item: unknown) => typeof item === 'string' && item.length <= 200 || typeof item === 'number' && Number.isFinite(item))) throw new Error();
    return value.key;
  } catch { throw new PaginationError(); }
}
function writeCursor(key: PageKey, context: string, secret: Buffer) {
  const body = Buffer.from(JSON.stringify({ v: 1, scope: mac(secret, context), key })).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

export { readCursor as readPageCursor, writeCursor as writePageCursor };

// Exact authorized totals require visiting the eligible set, but each database
// read and the retained result remain bounded. Never stop at a denied batch.
export async function authorizedPage<T>(options: {
  params: URLSearchParams; context: string; secret: Buffer;
  fetch: (after: PageKey | null, take: number) => Promise<T[]>;
  key: (row: T) => PageKey; visible: (row: T) => Promise<boolean>;
}) {
  const limit = pageLimit(options.params), rawCursor = options.params.get('cursor');
  if (options.params.getAll('cursor').length > 1) throw new PaginationError();
  const anchor = rawCursor === null ? null : readCursor(rawCursor, options.context, options.secret);
  let after: PageKey | null = null, found = !anchor, total = 0, remaining = 0;
  const items: T[] = [];
  for (;;) {
    const batch = await options.fetch(after, 100);
    if (batch.length > 100) throw new Error('Unbounded pagination source');
    for (const row of batch) {
      const key = options.key(row);
      const allowed = await options.visible(row);
      if (allowed) total++;
      if (!found) {
        if (JSON.stringify(key) === JSON.stringify(anchor)) {
          if (!allowed) throw new PaginationError(undefined, 409);
          found = true;
        }
        continue;
      }
      if (allowed) { remaining++; if (items.length < limit) items.push(row); }
    }
    if (batch.length < 100) break;
    const next = options.key(batch[batch.length - 1]);
    if (JSON.stringify(next) === JSON.stringify(after)) throw new Error('Pagination source did not advance');
    after = next;
  }
  if (!found) throw new PaginationError(undefined, 409);
  const hasMore = remaining > items.length;
  const pagination: PageInfo = { limit, total, hasMore, nextCursor: hasMore ? writeCursor(options.key(items[items.length - 1]), options.context, options.secret) : null };
  return { items, pagination };
}

export function seekWhere(columns: Array<{ name: string; direction: 'asc' | 'desc'; date?: boolean }>, key: PageKey | null) {
  if (!key) return {};
  return { OR: columns.map((column, index) => Object.fromEntries(columns.slice(0, index + 1).map((field, i) => [field.name,
    i === index ? { [column.direction === 'asc' ? 'gt' : 'lt']: field.date ? new Date(String(key[i])) : key[i] }
      : field.date ? new Date(String(key[i])) : key[i]]))) };
}
