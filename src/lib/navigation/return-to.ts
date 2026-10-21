const DEFAULT_TASK_RETURN_TO = '/tasks';

const ALLOWED_RETURN_PATHS = [
  '/tasks',
  '/generate',
  '/admin',
  '/admin/outputs',
  '/projects',
  '/usage',
  '/video-cards',
] as const;

function withoutQueryOrHash(value: string) {
  return value.split(/[?#]/, 1)[0] || '/';
}

function isAllowedReturnPath(value: string) {
  const path = withoutQueryOrHash(value);
  return ALLOWED_RETURN_PATHS.some((allowedPath) => (
    path === allowedPath || path.startsWith(`${allowedPath}/`)
  ));
}

export function sanitizeReturnTo(value: string | null | undefined) {
  return sanitizeOptionalReturnTo(value) || DEFAULT_TASK_RETURN_TO;
}

export function sanitizeOptionalReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (trimmed.includes('\\') || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (!isAllowedReturnPath(trimmed)) return null;
  return trimmed;
}

export function taskReturnLabel(returnTo: string | null | undefined) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  if (safeReturnTo.startsWith('/admin/outputs')) return '返回产出留存';
  if (safeReturnTo.startsWith('/admin/costs')) return '返回成本后台';
  if (withoutQueryOrHash(safeReturnTo) === '/admin/users') return '返回成员使用';
  if (safeReturnTo.startsWith('/admin/projects')) return '返回项目使用';
  if (safeReturnTo.startsWith('/admin')) return '返回后台';
  if (withoutQueryOrHash(safeReturnTo) === '/usage') return '返回我的用量';
  if (safeReturnTo.startsWith('/generate')) return '返回生成页';
  if (/^\/projects\/[^/]+\/video-cards(\/|$)/.test(safeReturnTo)) return '返回视频卡';
  if (safeReturnTo.startsWith('/projects')) return '返回项目';
  if (safeReturnTo.startsWith('/video-cards')) return '返回视频卡';
  return '返回任务';
}

export function taskDetailHref(taskId: string, returnTo: string | null | undefined) {
  return `/tasks/${encodeURIComponent(taskId)}?return_to=${encodeURIComponent(sanitizeReturnTo(returnTo))}`;
}
