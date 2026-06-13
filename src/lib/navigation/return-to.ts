const DEFAULT_TASK_RETURN_TO = '/tasks';

const ALLOWED_RETURN_PATHS = [
  '/tasks',
  '/generate',
  '/admin',
  '/admin/outputs',
  '/projects',
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
  if (!value) return DEFAULT_TASK_RETURN_TO;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_TASK_RETURN_TO;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return DEFAULT_TASK_RETURN_TO;
  if (trimmed.includes('\\') || /[\u0000-\u001f\u007f]/.test(trimmed)) return DEFAULT_TASK_RETURN_TO;
  if (!isAllowedReturnPath(trimmed)) return DEFAULT_TASK_RETURN_TO;
  return trimmed;
}

export function taskReturnLabel(returnTo: string | null | undefined) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  if (safeReturnTo.startsWith('/admin/outputs')) return '返回产出留存';
  if (safeReturnTo.startsWith('/admin/costs')) return '返回成本后台';
  if (safeReturnTo.startsWith('/admin')) return '返回后台';
  if (safeReturnTo.startsWith('/generate')) return '返回生成页';
  if (safeReturnTo.startsWith('/projects')) return '返回项目';
  return '返回任务';
}

export function taskDetailHref(taskId: string, returnTo: string | null | undefined) {
  return `/tasks/${encodeURIComponent(taskId)}?return_to=${encodeURIComponent(sanitizeReturnTo(returnTo))}`;
}
