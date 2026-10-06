export function replaceImageModuleLocation(moduleId: string | null, covers = false) {
  const url = new URL(window.location.href);
  if (!['/template-studio', '/image-studio'].includes(url.pathname) || url.searchParams.get('type') === 'video') return;
  if (url.pathname === '/template-studio') url.searchParams.set('type', 'image');
  if (moduleId) url.searchParams.set('moduleId', moduleId);
  else url.searchParams.delete('moduleId');
  url.searchParams.delete('presetId');
  if (covers) url.searchParams.set('view', 'covers');
  else if (url.searchParams.get('view') === 'covers') url.searchParams.delete('view');
  url.hash = '';
  const next = url.pathname + url.search;
  if (next === window.location.pathname + window.location.search + window.location.hash) return;
  // Next 14 copies its router state back; passing its loop flags would skip query synchronization.
  const state = { ...(window.history.state || {}) };
  delete state.__NA;
  delete state._N;
  window.history.replaceState(state, '', next);
}
