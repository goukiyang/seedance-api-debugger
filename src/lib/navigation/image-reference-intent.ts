import { readTaskReuseTabId, taskReuseNavigationTarget, validTaskReuseNavigationIntent } from './task-reuse-intent';

const imageReferenceKey = 'sd2:image-reference-click:v1';

export function authorizeImageReferenceHref(url: URL, accountId: string): string | null {
  const taskId = url.searchParams.get('reuse_task_id');
  const moduleId = url.searchParams.get('moduleId');
  if (url.origin !== window.location.origin || url.pathname !== '/template-studio'
    || url.searchParams.get('type') !== 'image' || !moduleId || !taskId || !accountId) return null;
  try {
    const tabId = readTaskReuseTabId(() => sessionStorage.getItem('workspace_tab_id'));
    if (!tabId) return null;
    const token = crypto.randomUUID();
    sessionStorage.setItem(imageReferenceKey, JSON.stringify({
      token, taskId, moduleId, accountId, tabId, target: taskReuseNavigationTarget(url), expiresAt: Date.now() + 5 * 60 * 1000,
    }));
    url.searchParams.set('reuse_intent', token);
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

export function claimImageReferenceIntent(url: URL, accountId: string): boolean {
  if (url.pathname !== '/template-studio' || url.searchParams.get('type') !== 'image') return false;
  try {
    const tabId = readTaskReuseTabId(() => sessionStorage.getItem('workspace_tab_id'));
    if (!tabId) return false;
    const saved: unknown = JSON.parse(sessionStorage.getItem(imageReferenceKey) || 'null');
    sessionStorage.removeItem(imageReferenceKey);
    return validTaskReuseNavigationIntent(saved, url, accountId, tabId, Date.now())
      && 'moduleId' in saved && saved.moduleId === url.searchParams.get('moduleId');
  } catch {
    return false;
  }
}
