const DB_NAME = 'sd2_asset_library_cache';
const STORE_NAME = 'asset_library_pages';
const DB_VERSION = 1;
const CACHE_TTL_MS = 5 * 60_000;

export const ASSET_LIBRARY_CACHE_SCHEMA_VERSION = 1;

type AssetLibraryCacheKeyInput = {
  view?: string;
  userId: string;
  role: string;
  scope: string;
  type: string;
  enhance?: string;
  includeUploads: boolean;
  status: string;
  sort: string;
  groupBy: string;
  projectId: string;
  ownerUserId: string;
  keyword: string;
  page: number;
  schemaVersion?: number;
};

export type AssetLibraryCachePayload<TItem, TPagination> = {
  items: TItem[];
  pagination: TPagination | null;
};

type AssetLibraryCacheEntry<TItem, TPagination> = {
  key: string;
  userId: string;
  schemaVersion: number;
  savedAt: number;
  payload: AssetLibraryCachePayload<TItem, TPagination>;
};

function isIndexedDbAvailable() {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openAssetLibraryCacheDb(): Promise<IDBDatabase | null> {
  if (!isIndexedDbAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T> | void,
) {
  return openAssetLibraryCacheDb().then((db) => new Promise<T | null>((resolve) => {
    if (!db) {
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (value: T | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = action(store);
      if (request) {
        request.onsuccess = () => settle(request.result);
        request.onerror = () => settle(null);
      }
      transaction.oncomplete = () => {
        db.close();
        if (!request) settle(null);
      };
      transaction.onabort = () => {
        db.close();
        settle(null);
      };
      transaction.onerror = () => {
        db.close();
        settle(null);
      };
    } catch {
      db.close();
      settle(null);
    }
  })).catch(() => null);
}

export function createAssetLibraryCacheKey(input: AssetLibraryCacheKeyInput) {
  const schemaVersion = input.schemaVersion ?? ASSET_LIBRARY_CACHE_SCHEMA_VERSION;
  return [
    `v${schemaVersion}`,
    input.view || '-',
    input.userId,
    input.role,
    input.scope,
    input.type,
    input.enhance || '-',
    input.includeUploads ? 'uploads' : 'no-uploads',
    input.status,
    input.sort,
    input.groupBy,
    input.projectId || '-',
    input.ownerUserId || '-',
    input.keyword.trim() || '-',
    String(input.page),
  ].join('|');
}

export async function readAssetLibraryCache<TItem, TPagination>(
  key: string,
  schemaVersion = ASSET_LIBRARY_CACHE_SCHEMA_VERSION,
) {
  const entry = await withStore<AssetLibraryCacheEntry<TItem, TPagination>>('readonly', (store) => store.get(key));
  if (!entry || entry.schemaVersion !== schemaVersion) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) return null;
  return entry.payload;
}

export async function writeAssetLibraryCache<TItem, TPagination>(input: {
  key: string;
  userId: string;
  payload: AssetLibraryCachePayload<TItem, TPagination>;
  schemaVersion?: number;
}) {
  await withStore('readwrite', (store) => {
    store.put({
      key: input.key,
      userId: input.userId,
      schemaVersion: input.schemaVersion ?? ASSET_LIBRARY_CACHE_SCHEMA_VERSION,
      savedAt: Date.now(),
      payload: input.payload,
    });
  });
}

export async function deleteAssetLibraryCacheForUser(userId: string) {
  const keys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  if (!keys?.length) return;
  const userKeyFragment = `|${userId}|`;
  await withStore('readwrite', (store) => {
    keys.forEach((key) => {
      if (typeof key === 'string' && key.includes(userKeyFragment)) {
        store.delete(key);
      }
    });
  });
}
