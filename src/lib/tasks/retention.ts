export const TASK_RETENTION_ACTIVE = 'active';
export const TASK_RETENTION_USER_DELETED = 'user_deleted';
export const TASK_RETENTION_ADMIN_HIDDEN = 'admin_hidden';
export const TASK_RETENTION_RETAINED = 'retained';

export const USER_VISIBLE_TASK_RETENTION_STATUSES = [
  TASK_RETENTION_ACTIVE,
  TASK_RETENTION_RETAINED,
] as const;

export function isTaskHiddenFromRegularUsers(task: { retention_status?: string | null }) {
  const status = task.retention_status || TASK_RETENTION_ACTIVE;
  return !USER_VISIBLE_TASK_RETENTION_STATUSES.includes(
    status as (typeof USER_VISIBLE_TASK_RETENTION_STATUSES)[number],
  );
}

export function normalizeTaskDeleteReason(value: unknown) {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  if (!reason) return null;
  return reason.slice(0, 240);
}
