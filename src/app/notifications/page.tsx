'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
  status: string;
  created_at: string;
  read_at: string | null;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}

function typeLabel(type: string) {
  if (type === 'version_update') return '版本更新';
  if (type === 'credit') return '点数';
  return '系统';
}

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadNotifications() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/me/notifications?limit=50', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '通知读取失败');
      setItems(data.notifications || []);
      setUnreadCount(data.unread_count || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '通知读取失败');
    } finally {
      setLoading(false);
    }
  }

  async function markAllRead() {
    const response = await fetch('/api/me/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all_read: true }),
    });
    if (response.ok) await loadNotifications();
  }

  useEffect(() => {
    void loadNotifications();
  }, []);

  return (
    <div className="notifications-page">
      <section className="notifications-head">
        <div>
          <p className="notifications-kicker">消息中心</p>
          <h1>通知</h1>
          <p>版本更新、点数变化和后续系统提醒会集中放在这里。</p>
        </div>
        <button type="button" className="admin-users-button admin-users-button-secondary" onClick={markAllRead} disabled={unreadCount === 0}>
          全部标为已读
        </button>
      </section>

      {error && <div className="admin-users-alert admin-users-alert-error">{error}</div>}
      {loading ? (
        <div className="notifications-empty">读取中...</div>
      ) : items.length === 0 ? (
        <div className="notifications-empty">暂无通知</div>
      ) : (
        <div className="notifications-list">
          {items.map((item) => (
            <article key={item.id} className={`notifications-item ${item.status === 'unread' ? 'is-unread' : ''}`}>
              <div className="notifications-item-main">
                <span className="notifications-type">{typeLabel(item.type)}</span>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
                <small>{formatTime(item.created_at)}</small>
              </div>
              {item.href && (
                <Link className="admin-users-button admin-users-button-secondary" href={item.href}>
                  查看
                </Link>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
