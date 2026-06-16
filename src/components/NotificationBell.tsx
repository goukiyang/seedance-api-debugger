'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCheck, ExternalLink, Inbox, RefreshCcw } from 'lucide-react';
import {
  type AppNotification,
  formatNotificationTime,
  isNotificationUnread,
  notificationActionLabel,
  notificationContextText,
  notificationHref,
  notificationStatusLabel,
  notificationTone,
  notificationTypeLabel,
} from '@/lib/notifications/display';

interface NotificationBellProps {
  enabled: boolean;
}

interface NotificationsResponse {
  notifications?: AppNotification[];
  unread_count?: number;
  notification?: AppNotification;
  error?: string;
  message?: string;
}

function unreadText(count: number) {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

async function readJson(response: Response): Promise<NotificationsResponse> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || '通知加载失败');
  }
  return data;
}

export default function NotificationBell({ enabled }: NotificationBellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const refreshNotifications = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/notifications?limit=8', { cache: 'no-store' });
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
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      setNotifications([]);
      setUnreadCount(0);
      setError('');
      return;
    }

    refreshNotifications();
    const timer = window.setInterval(refreshNotifications, 60_000);
    const onFocus = () => refreshNotifications();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refreshNotifications]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const markNotificationRead = async (notification: AppNotification) => {
    if (!isNotificationUnread(notification)) return notification;
    setActingId(notification.id);
    try {
      const response = await fetch(`/api/notifications/${notification.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read' }),
      });
      const data = await readJson(response);
      const updated = data.notification || notification;
      setNotifications((current) => current.map((item) => (
        item.id === notification.id ? updated : item
      )));
      setUnreadCount((current) => Math.max(0, current - 1));
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : '标记已读失败');
      return notification;
    } finally {
      setActingId(null);
    }
  };

  const markAllRead = async () => {
    if (markingAll || unreadCount === 0) return;
    setMarkingAll(true);
    setError('');
    try {
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_all_read' }),
      });
      await readJson(response);
      setNotifications((current) => current.map((item) => ({
        ...item,
        status: 'read',
        read_at: item.read_at || new Date().toISOString(),
      })));
      setUnreadCount(0);
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

  if (!enabled) return null;

  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        type="button"
        className={`composer-topbar-icon-btn notification-bell-trigger${open ? ' active' : ''}`}
        aria-label={unreadCount > 0 ? `通知，${unreadCount} 条未读` : '通知'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) refreshNotifications();
        }}
      >
        <Bell size={17} aria-hidden="true" />
        {unreadCount > 0 && <span className="notification-bell-badge">{unreadText(unreadCount)}</span>}
      </button>

      {open && (
        <section className="notification-dropdown" aria-label="通知">
          <div className="notification-dropdown-head">
            <div>
              <strong>通知</strong>
              <span>{unreadCount > 0 ? `${unreadCount} 条未读` : '暂无未读'}</span>
            </div>
            <div className="notification-dropdown-actions">
              <button type="button" onClick={refreshNotifications} disabled={loading} title="刷新通知">
                <RefreshCcw size={14} aria-hidden="true" />
              </button>
              <button type="button" onClick={markAllRead} disabled={markingAll || unreadCount === 0}>
                <CheckCheck size={14} aria-hidden="true" />
                全部已读
              </button>
            </div>
          </div>

          {error && (
            <div className="notification-dropdown-error">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <div className="notification-dropdown-list">
            {loading && notifications.length === 0 ? (
              <div className="notification-dropdown-empty">正在加载通知...</div>
            ) : notifications.length === 0 ? (
              <div className="notification-dropdown-empty">
                <Inbox size={18} aria-hidden="true" />
                <span>暂无通知</span>
              </div>
            ) : (
              notifications.map((notification) => {
                const unread = isNotificationUnread(notification);
                const tone = notificationTone(notification);
                const href = notificationHref(notification);
                return (
                  <article
                    key={notification.id}
                    className={`notification-dropdown-item ${unread ? 'is-unread' : ''} tone-${tone}`}
                  >
                    <button
                      type="button"
                      className="notification-dropdown-open"
                      onClick={() => openNotification(notification)}
                      disabled={actingId === notification.id}
                    >
                      <span className="notification-dropdown-item-head">
                        <span>{notification.title}</span>
                        <small>{formatNotificationTime(notification.created_at)}</small>
                      </span>
                      {notification.body && <span className="notification-dropdown-body">{notification.body}</span>}
                      <span className="notification-dropdown-meta">
                        {notificationTypeLabel(notification.type)} · {notificationContextText(notification)} · {notificationStatusLabel(notification.status)}
                      </span>
                    </button>
                    <div className="notification-dropdown-item-actions">
                      {unread && (
                        <button
                          type="button"
                          onClick={() => markNotificationRead(notification)}
                          disabled={actingId === notification.id}
                        >
                          标为已读
                        </button>
                      )}
                      <Link href={href} onClick={() => setOpen(false)}>
                        {notificationActionLabel(notification)}
                        <ExternalLink size={12} aria-hidden="true" />
                      </Link>
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <Link className="notification-dropdown-footer" href="/notifications" onClick={() => setOpen(false)}>
            查看全部通知
          </Link>
        </section>
      )}
    </div>
  );
}
