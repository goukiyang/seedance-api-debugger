import type { LocalAssetRecord } from '@/lib/provider/seedance-assets-types';
import type { PageInfo } from './cursor';

export type SeedancePageScope = { ownerId: string | null; epoch: number; includeDeleted: boolean; visible: boolean };
export const seedancePageScopeKey = (scope: SeedancePageScope) => JSON.stringify([scope.ownerId, scope.epoch, scope.includeDeleted, scope.visible]);
export type SeedancePages = { scope: string; assets: LocalAssetRecord[]; pagination: PageInfo | null; loading: boolean; loadingMore: boolean;
  error: { message: string; retryMore: boolean } | null };
export const emptySeedancePages = (scope = ''): SeedancePages => ({ scope, assets: [], pagination: null, loading: false, loadingMore: false, error: null });
class PageReadError extends Error { constructor(message: string, readonly reset: boolean) { super(message); } }
export function createSeedancePages(options: { fetch: typeof fetch; session: () => { ownerId: string | null; epoch: number }; blocked: () => boolean }) {
  let scope: SeedancePageScope = { ownerId: null, epoch: -1, includeDeleted: false, visible: false };
  let snapshot = emptySeedancePages(), sequence = 0, controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: SeedancePages) => { snapshot = next; listeners.forEach(listener => listener()); };
  const invalidate = () => { sequence++; controller?.abort(); controller = null; publish(emptySeedancePages(seedancePageScopeKey(scope))); };
  async function load(append = false) {
    const session = options.session();
    if (!scope.visible || !scope.ownerId || options.blocked() || session.ownerId !== scope.ownerId || session.epoch !== scope.epoch) return;
    if (append && (controller || !snapshot.pagination?.hasMore || !snapshot.pagination.nextCursor)) return;
    controller?.abort(); const active = new AbortController(); controller = active;
    const current = scope, key = seedancePageScopeKey(current), run = ++sequence;
    const valid = () => {
      const now = options.session();
      return run === sequence && !active.signal.aborted && key === seedancePageScopeKey(scope) && !options.blocked()
        && now.ownerId === current.ownerId && now.epoch === current.epoch;
    };
    const params = new URLSearchParams({ includeDeleted: String(current.includeDeleted), limit: '24' });
    if (append) params.set('cursor', snapshot.pagination!.nextCursor!);
    publish({ ...snapshot, loading: !append, loadingMore: append, error: null });
    try {
      const response = await options.fetch('/api/assets/list?' + params, { cache: 'no-store', signal: active.signal,
        headers: { 'x-upload-owner-id': current.ownerId! } });
      const data = await response.json();
      if (!valid()) return;
      if (!response.ok) throw new PageReadError([400, 409].includes(response.status) ? '列表或账号已变化，请刷新列表' : '加载失败，请重试', [400, 401, 403, 409].includes(response.status));
      const page = data?.pagination;
      if (!Array.isArray(data.assets) || !page || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100
        || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.hasMore !== 'boolean'
        || (page.hasMore ? typeof page.nextCursor !== 'string' || !page.nextCursor : page.nextCursor !== null)
        || data.assets.length > page.limit || data.assets.some((asset: LocalAssetRecord) => !asset || typeof asset.localId !== 'string')) throw new PageReadError('列表暂时无法加载，请重试', false);
      const rows = append ? [...snapshot.assets, ...data.assets] : data.assets;
      const assets = [...new Map<string, LocalAssetRecord>(rows.map((asset: LocalAssetRecord) => [asset.localId, asset] as const)).values()];
      publish({ ...snapshot, assets, pagination: page, error: null });
    } catch (error) {
      if (!valid()) return;
      const reset = error instanceof PageReadError && error.reset;
      publish({ ...snapshot, ...(reset ? { assets: [], pagination: null } : {}), error: {
        message: error instanceof PageReadError ? error.message : '加载失败，请重试', retryMore: append && !reset } });
    } finally {
      if (valid()) { controller = null; publish({ ...snapshot, loading: false, loadingMore: false }); }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setScope(next: SeedancePageScope) { if (seedancePageScopeKey(next) !== seedancePageScopeKey(scope)) { scope = next; invalidate(); } },
    refresh: () => load(false), more: () => load(true), retry: () => load(snapshot.error?.retryMore || false), invalidate,
    dispose() { sequence++; controller?.abort(); controller = null; listeners.clear(); },
  };
}
