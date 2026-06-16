'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCheck, ExternalLink, Inbox, RefreshCcw } from 'lucide-react';
import {
  type AppNotification,
  formatNotificationTime,
  isNotificationUnread,
  notificationActionLabel,
  notificationActorName,
  notificationContextText,
  notificationHref,
  notificationStatusLabel,
  notificationTone,
  notificationTypeLabel,
} from '@/lib/notifications/display';

type NotificationView = 'all' | 'unread' | 'failed';

interface NotificationsResponse {
  notifications?: AppNotification[];
  unread_count?: number;
  notification?: AppNotification;
  error?: string;
  message?: string;
}

const VIEWS: { key: NotificationView; label: string; description: string }[] = [
  { key: 'all', label: '全部', description: '最近通知' },
  { key: 'unread', label: '未读', description: '需要处理' },
  { key: 'failed', label: '失败', description: '发送异常' },
];

async function readJson(response: Response): Promise<NotificationsResponse> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || '通知操作失败');
  }
  return data;
}

function viewUrl(view: NotificationView) {
  if (view === 'unread') return '/api/notifications?unread=1&limit=100';
  if (view === 'failed') return '/api/notifications?status=failed&limit=100';
  return '/api/notifications?limit=100';
}

export default function NotificationsPageClient() {
  const [view, setView] = useState<NotificationView>('all');
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const visibleEmptyText = useMemo(() => {
    if (view === 'unread') return '暂无未读通知';
    if (view === 'failed') return '暂无失败通知';
    return '暂无通知';
  }, [view]);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(viewUrl(view), { cache: 'no-store' });
      const data = await readJson(response);
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread_count || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '通知加载失败');
      setNotifications([]);
      setUnreadCount(0);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const updateNotification = (updated: AppNotification) => {
    setNotifications((current) => {
      const next = current.map((item) => item.id === updated.id ? updated : item);
      if (view === 'unread' && !isNotificationUnread(updated)) {
        return next.filter((item) => item.id !== updated.id);
      }
      if (view === 'failed' && updated.status !== 'failed') {
        return next.filter((item) => item.id !== updated.id);
      }
      return next;
    });
  };

  const markNotificationRead = async (notification: AppNotification) => {
    if (!isNotificationUnread(notification)) return notification;
    setActingId(notification.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/notifications/${notification.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read' }),
      });
      const data = await readJson(response);
      const updated = data.notification || notification;
      updateNotification(updated);
      setUnreadCount((current) => Math.max(0, current - 1));
      setMessage('已标记为已读。');
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : '标记已读失败');
      return notification;
    } finally {
      setActingId(null);
    }
  };

  const retryNotification = async (notification: AppNotification) => {
    if (notification.status !== 'failed') return;
    setActingId(notification.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/notifications/${notification.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_failed' }),
      });
      const data = await readJson(response);
      if (data.notification) updateNotification(data.notification);
      setMessage('失败通知已重新标记为已发送。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败');
    } finally {
      setActingId(null);
    }
  };

  const markAllRead = async () => {
    if (markingAll || unreadCount === 0) return;
    setMarkingAll(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_all_read' }),
      });
      await readJson(response);
      setUnreadCount(0);
      if (view === 'unread') {
        setNotifications([]);
      } else {
        setNotifications((current) => current.map((item) => ({
          ...item,
          status: 'read',
          read_at: item.read_at || new Date().toISOString(),
        })));
      }
      setMessage('全部通知已标记为已读。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '全部已读失败');
    } finally {
      setMarkingAll(false);
    }
  };

  const openNotification = async (notification: AppNotification) => {
    await markNotificationRead(notification);
    window.location.href = notificationHref(notification);
  };

  return (
    <div className="notifications-workspace">
      <div className="notifications-toolbar">
        <div className="notifications-tabs" role="tablist" aria-label="通知筛选">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={view === item.key ? 'active' : ''}
              onClick={() => setView(item.key)}
              role="tab"
              aria-selected={view === item.key}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </div>
        <div className="notifications-actions">
          <button type="button" className="btn btn-secondary" onClick={fetchNotifications} disabled={loading}>
            <RefreshCcw size={15} aria-hidden="true" />
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={markAllRead} disabled={markingAll || unreadCount === 0}>
            <CheckCheck size={15} aria-hidden="true" />
            全部已读
          </button>
        </div>
      </div>

      {(message || error) && (
        <div className={`notifications-message ${error ? 'is-error' : 'is-success'}`}>
          {error ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCheck size={15} aria-hidden="true" />}
          <span>{error || message}</span>
        </div>
      )}

      <section className="notifications-list" aria-busy={loading}>
        {loading && notifications.length === 0 ? (
          <div className="notifications-empty">正在加载通知...</div>
        ) : notifications.length === 0 ? (
          <div className="notifications-empty">
            <Inbox size={26} aria-hidden="true" />
            <strong>{visibleEmptyText}</strong>
            <span>项目、审批和预算相关消息会出现在这里。</span>
          </div>
        ) : (
          notifications.map((notification) => {
            const unread = isNotificationUnread(notification);
            const tone = notificationTone(notification);
            const href = notificationHref(notification);
            const actorName = notificationActorName(notification);
            return (
              <article
                key={notification.id}
                className={`notifications-row ${unread ? 'is-unread' : ''} tone-${tone}`}
              >
                <button
                  type="button"
                  className="notifications-row-main"
                  onClick={() => openNotification(notification)}
                  disabled={actingId === notification.id}
                >
                  <span className="notifications-row-dot" aria-hidden="true" />
                  <span className="notifications-row-content">
                    <span className="notifications-row-head">
                      <strong>{notification.title}</strong>
                      <time>{formatNotificationTime(notification.created_at)}</time>
                    </span>
                    {notification.body && <span className="notifications-row-body">{notification.body}</span>}
                    <span className="notifications-row-meta">
                      {notificationTypeLabel(notification.type)}
                      <span>·</span>
                      {notificationContextText(notification)}
                      <span>·</span>
                      {notificationStatusLabel(notification.status)}
                      {actorName && (
                        <>
                          <span>·</span>
                          {actorName}
                        </>
                      )}
                    </span>
                    {notification.error_message && (
                      <span className="notifications-row-error">{notification.error_message}</span>
                    )}
                  </span>
                </button>
                <div className="notifications-row-actions">
                  {unread && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => markNotificationRead(notification)}
                      disabled={actingId === notification.id}
                    >
                      已读
                    </button>
                  )}
                  {notification.status === 'failed' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => retryNotification(notification)}
                      disabled={actingId === notification.id}
                    >
                      重试
                    </button>
                  )}
                  <Link className="btn btn-secondary" href={href}>
                    {notificationActionLabel(notification)}
                    <ExternalLink size={14} aria-hidden="true" />
                  </Link>
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
