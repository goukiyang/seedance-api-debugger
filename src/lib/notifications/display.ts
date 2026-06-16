export interface NotificationActorSummary {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
  avatar_url?: string | null;
  account_type?: string | null;
}

export interface NotificationProjectSummary {
  id: string;
  name: string;
  type?: string | null;
  status?: string | null;
}

export interface NotificationVideoCardSummary {
  id: string;
  title: string;
  status?: string | null;
  project_id: string;
}

export interface NotificationApprovalSummary {
  id: string;
  type: string;
  status: string;
}

export interface AppNotification {
  id: string;
  type: string;
  channel?: string | null;
  status: string;
  title: string;
  body: string | null;
  metadata_json?: string | null;
  sent_at?: string | Date | null;
  read_at?: string | Date | null;
  error_message?: string | null;
  created_at: string | Date;
  updated_at?: string | Date | null;
  project?: NotificationProjectSummary | null;
  videoCard?: NotificationVideoCardSummary | null;
  approval?: NotificationApprovalSummary | null;
  actor?: NotificationActorSummary | null;
}

export type NotificationTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export function isNotificationUnread(notification: Pick<AppNotification, 'status' | 'read_at'>) {
  return notification.status !== 'read' && !notification.read_at;
}

export function parseNotificationMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function notificationStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: '待发送',
    sent: '未读',
    read: '已读',
    failed: '失败',
  };
  return labels[status] || status;
}

export function notificationTypeLabel(type: string) {
  const labels: Record<string, string> = {
    approval_project_create_approved: '立项审批',
    approval_budget_increase_approved: '预算审批',
    approval_ratio_change_approved: '规格审批',
    approval_video_card_reopen_approved: '视频卡审批',
    project_budget_threshold: '预算预警',
    project_budget_insufficient: '预算不足',
    project_review_card_generated: '项目复盘',
  };
  if (type.startsWith('approval_') && type.endsWith('_rejected')) return '审批拒绝';
  return labels[type] || '系统通知';
}

export function notificationTone(notification: Pick<AppNotification, 'status' | 'type'>): NotificationTone {
  if (notification.status === 'failed') return 'danger';
  if (notification.type.includes('rejected')) return 'danger';
  if (notification.type.includes('insufficient') || notification.type.includes('threshold')) return 'warning';
  if (notification.type.includes('approved') || notification.type.includes('generated')) return 'success';
  return 'info';
}

export function notificationHref(notification: AppNotification) {
  if (notification.videoCard?.id && notification.videoCard.project_id) {
    return `/projects/${notification.videoCard.project_id}/video-cards/${notification.videoCard.id}`;
  }
  if (notification.project?.id) return `/projects/${notification.project.id}`;
  if (notification.approval?.id) return '/approvals';

  const metadata = parseNotificationMetadata(notification.metadata_json);
  const videoCardId = typeof metadata.video_card_id === 'string' ? metadata.video_card_id : null;
  if (videoCardId && notification.project?.id) {
    return `/projects/${notification.project.id}/video-cards/${videoCardId}`;
  }
  return '/notifications';
}

export function notificationActionLabel(notification: AppNotification) {
  if (notification.videoCard?.id) return '打开视频卡';
  if (notification.project?.id) return '打开项目';
  if (notification.approval?.id) return '查看审批';
  return '查看详情';
}

export function notificationContextText(notification: AppNotification) {
  if (notification.videoCard?.title) return `视频卡：${notification.videoCard.title}`;
  if (notification.project?.name) return `项目：${notification.project.name}`;
  if (notification.approval?.type) return `审批：${notification.approval.type}`;
  return '系统消息';
}

export function notificationActorName(notification: AppNotification) {
  const actor = notification.actor;
  return actor?.name || actor?.username || actor?.email || '';
}

export function formatNotificationTime(value: string | Date | null | undefined) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
