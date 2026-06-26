'use client';

import { useState } from 'react';

export default function AdminNotificationsClient() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [href, setHref] = useState('/notifications');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch('/api/admin/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, href }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '发布失败');
      setNotice(`已发送给 ${data.count || 0} 个活跃用户`);
      setTitle('');
      setBody('');
      setHref('/notifications');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-users-workbench-page">
      <section className="admin-users-operator">
        <div>
          <span>通知公告</span>
          <h1>发布版本更新</h1>
          <p>把版本更新、功能上线和运营提醒发送到用户通知中心。</p>
        </div>
      </section>

      {notice && <div className="admin-users-alert admin-users-alert-success">{notice}</div>}
      {error && <div className="admin-users-alert admin-users-alert-error">{error}</div>}

      <section className="admin-users-tool-panel">
        <div className="admin-users-panel-title-row">
          <div>
            <h3>公告内容</h3>
            <p>第一版只发站内通知，不接外部消息渠道。</p>
          </div>
        </div>
        <div className="admin-users-form-grid">
          <label>
            标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} placeholder="例如：生成页支持参考音频和参考视频" />
          </label>
          <label>
            跳转链接
            <input value={href} onChange={(event) => setHref(event.target.value)} maxLength={240} placeholder="/notifications" />
          </label>
        </div>
        <label className="notifications-admin-body">
          内容
          <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={600} rows={6} placeholder="写清这次更新了什么、用户应该关注什么。" />
        </label>
        <div className="admin-users-primary-actions">
          <button type="button" className="admin-users-button admin-users-button-primary" onClick={publish} disabled={busy || !title.trim() || !body.trim()}>
            {busy ? '发布中...' : '发布通知'}
          </button>
        </div>
      </section>
    </div>
  );
}
