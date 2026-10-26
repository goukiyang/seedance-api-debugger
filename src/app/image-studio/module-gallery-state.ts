import type { GalleryScope, GallerySort } from '@/lib/image-studio/gallery-types';
export type { GalleryScope, GallerySort } from '@/lib/image-studio/gallery-types';

export type GalleryCatalogItem = {
  id: string;
  key: string;
  name: string;
  groupName: string;
  mine: boolean;
  shared: boolean;
};

export type ModuleGalleryFilters = { query: string; scope: GalleryScope; sort: GallerySort; authorKey: string | null };
export type ModuleGalleryLastOpened = Record<string, number>;

export const MODULE_GALLERY_QUERY_LIMIT = 160;
export const MODULE_GALLERY_RECENT_LIMIT = 1000;

export function defaultModuleGalleryFilters(): ModuleGalleryFilters {
  return { query: '', scope: 'all', sort: 'created', authorKey: null };
}

export function normalizeModuleGalleryFilters(value: unknown): ModuleGalleryFilters {
  const defaults = defaultModuleGalleryFilters();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const fields = value as Record<string, unknown>;
  return {
    query: typeof fields.query === 'string' ? fields.query.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MODULE_GALLERY_QUERY_LIMIT) : defaults.query,
    scope: fields.scope === 'mine' || fields.scope === 'shared' || fields.scope === 'favorites' ? fields.scope : defaults.scope,
    sort: ['created', 'updated', 'likes', 'recent', 'name', 'directory'].includes(String(fields.sort)) ? fields.sort as GallerySort : defaults.sort,
    authorKey: typeof fields.authorKey === 'string' && /^author:[a-f0-9]{64}$/.test(fields.authorKey) ? fields.authorKey : null,
  };
}

// Identity comes from the authorized catalog, never from names or media URLs.
export function isModuleGalleryKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,159}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

export function normalizeModuleGalleryLastOpened(value: unknown, now: number): ModuleGalleryLastOpened {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([key, time]) => isModuleGalleryKey(key)
    && typeof time === 'number' && Number.isSafeInteger(time) && time > 0 && time <= now);
  entries.sort((left, right) => (right[1] as number) - (left[1] as number));
  return Object.fromEntries(entries.slice(0, MODULE_GALLERY_RECENT_LIMIT)) as ModuleGalleryLastOpened;
}

export function mergeModuleGalleryLastOpened(left: ModuleGalleryLastOpened, right: ModuleGalleryLastOpened, now: number): ModuleGalleryLastOpened {
  const merged = normalizeModuleGalleryLastOpened(left, now);
  for (const [key, time] of Object.entries(normalizeModuleGalleryLastOpened(right, now))) {
    merged[key] = Math.max(merged[key] || 0, time);
  }
  return normalizeModuleGalleryLastOpened(merged, now);
}

/** Filter the complete authorized catalog before passing it to useResultPages. */
export function deriveModuleGallery<T extends GalleryCatalogItem>(entries: readonly T[], options: Partial<ModuleGalleryFilters> & {
  lastOpened?: ModuleGalleryLastOpened;
} = {}) {
  const { query, scope, sort } = normalizeModuleGalleryFilters(options);
  const search = query.trim().toLowerCase();
  let filteredEntries = entries.filter(entry => (scope === 'all' || (scope === 'mine' ? entry.mine : entry.shared))
    && (!search || entry.name.toLowerCase().includes(search) || entry.groupName.toLowerCase().includes(search)));
  if (sort === 'recent') {
    const lastOpened = options.lastOpened || {};
    const timeOf = (entry: T) => {
      const time = Object.prototype.hasOwnProperty.call(lastOpened, entry.key) ? lastOpened[entry.key] : 0;
      return Number.isSafeInteger(time) && time > 0 ? time : 0;
    };
    // Explicit index tie-break preserves directory order, including same-name objects.
    const ordered = filteredEntries.map((entry, index) => ({ entry, index }));
    ordered.sort((left, right) => timeOf(right.entry) - timeOf(left.entry) || left.index - right.index);
    filteredEntries = ordered.map(item => item.entry);
  }
  return { filteredEntries, total: entries.length, filteredTotal: filteredEntries.length };
}
