import { boundedPageValue } from '@/lib/http/pagination-bounds';
import { requireSecret } from '@/lib/security/secrets';
import { assertPageOwner, pageLimit, PaginationError, readPageCursor, seekWhere, writePageCursor, type PageInfo, type PageKey } from './cursor';

export const createdPageOrder = [{ created_at: 'desc' as const }, { id: 'desc' as const }];
export function createdPageRequest(request: { headers: Headers; nextUrl: { searchParams: URLSearchParams } }, viewer: { id: string; role: string; account_type?: string | null },
  scope: unknown[], options: { defaultLimit: number; maxLimit: number; strictLimit?: boolean; minOnePage?: boolean }) {
  const params = request.nextUrl.searchParams;
  assertPageOwner(request.headers, viewer.id);
  const page = boundedPageValue(params.get('page'), 1, 1_000_000);
  const bounded = options.strictLimit ? pageLimit(params) : boundedPageValue(params.get('limit'), options.defaultLimit, options.maxLimit);
  const limit = pageLimit(new URLSearchParams({ limit: String(Math.min(bounded, options.maxLimit)) }));
  const context = JSON.stringify(['created-list-v1', viewer.id, viewer.role, viewer.account_type || null, ...scope]);
  const secret = requireSecret('media');
  const raw = params.get('cursor');
  if (params.getAll('cursor').length > 1) throw new PaginationError();
  const key: PageKey | null = raw === null ? null : readPageCursor(raw, context, secret);
  if (key && (key.length !== 2 || typeof key[0] !== 'string' || typeof key[1] !== 'string' || !key[1]
    || !Number.isFinite(Date.parse(key[0])) || new Date(key[0]).toISOString() !== key[0])) throw new PaginationError();
  const anchor = key ? { id: String(key[1]), created_at: new Date(String(key[0])) } : null;
  const seek = seekWhere([{ name: 'created_at', direction: 'desc', date: true }, { name: 'id', direction: 'desc' }], key);
  return {
    page, limit, anchor, seek, skip: key ? 0 : (page - 1) * limit, take: limit + 1,
    assertAnchor(row: unknown) { if (anchor && !row) throw new PaginationError('列表位置已变化，请刷新列表', 409); },
    finish<T extends { id: string; created_at: Date }>(rows: T[], total: number) {
      if (rows.length > limit + 1) throw new Error('unbounded_created_page_source');
      const items = rows.slice(0, limit), hasMore = rows.length > limit;
      const last = items[items.length - 1];
      const pagination: PageInfo & { page: number; total_pages: number } = { page, limit, total,
        total_pages: Math.max(options.minOnePage ? 1 : 0, Math.ceil(total / limit)), hasMore,
        nextCursor: hasMore && last ? writePageCursor([last.created_at.toISOString(), last.id], context, secret) : null };
      return { items, pagination };
    },
  };
}
export type CreatedPageRequest = ReturnType<typeof createdPageRequest>;
