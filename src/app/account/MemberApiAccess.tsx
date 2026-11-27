'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { useProductDialog } from '@/components/useProductDialog';

type Status = {
  status: string;
  decisionReason: string | null;
  canCreate: boolean;
  available: number;
  key: { id: string; prefix: string; expires_at: string } | null;
};

const endpoint = '/api/me/api-access';

export default function MemberApiAccess({ actorId }: { actorId: string }) {
  const [snapshot, setSnapshot] = useState<Status | null>(null);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const running = useRef(false);
  const { confirm, productDialog } = useProductDialog();
  const load = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (!active.current || isClientSessionBlocked()) return;
      if (!response.ok || data.actor_id !== actorId) throw new Error(data.error?.message || '请重新打开个人页。');
      setSnapshot(data);
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : '暂时无法读取 API 权限。');
    }
  }, [actorId]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; };
  }, [load]);

  async function update(action: 'apply' | 'claim' | 'revoke', keyId?: string) {
    if (running.current || isClientSessionBlocked()) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    if (action === 'revoke') setSecret('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-session-user': actorId },
        body: JSON.stringify({ action, key_id: keyId }),
      });
      const data = await response.json();
      if (!active.current || isClientSessionBlocked()) return;
      if (!response.ok || data.actor_id !== actorId) throw new Error(data.error?.message || '请重新打开个人页核对。');
      if (action === 'claim') {
        setSecret(data.token);
        await load();
      } else setSnapshot(data);
    } catch (error) {
      if (active.current) {
        setMessage(error instanceof Error ? error.message : '请核对当前绑定状态。');
        await load();
      }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="card">
    <h2 className="section-title">API 使用权限</h2>
    {snapshot ? <>
      <p>API 可用长期余额 {snapshot.available.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 点</p>
      {snapshot.status === 'pending' && <p>申请已提交，等待审批。</p>}
      {snapshot.status === 'rejected' && <p>申请未通过{snapshot.decisionReason ? ` · ${snapshot.decisionReason}` : '。'}</p>}
      {['unrequested', 'rejected', 'cancelled'].includes(snapshot.status) && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void update('apply')}>申请开通</button>}
      {snapshot.status === 'approved' && <>
        <p>接口地址 <code>{typeof window === 'undefined' ? '/api/v1' : `${window.location.origin}/api/v1`}</code> · <a className="link" href={`${endpoint}?contract=1`}>接入协议</a></p>
        {!snapshot.canCreate && <p>新建暂未开放，可在资产管理查看已有视频。</p>}
        {snapshot.key ? <>
          <p>已绑定 Key <code>{snapshot.key.prefix}…</code> · 有效期至 {new Date(snapshot.key.expires_at).toLocaleString('zh-CN')}</p>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={async () => {
            if (await confirm('吊销后，这把 Key 会立即失效。已受理视频仍会继续处理。', { title: '吊销 API Key', confirmLabel: '吊销', danger: true })) {
              void update('revoke', snapshot.key?.id);
            }
          }}>吊销 Key</button>
        </> : snapshot.canCreate && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void update('claim')}>领取 API Key</button>}
      </>}
    </> : <button type="button" className="btn btn-secondary" onClick={() => void load()}>查看申请状态</button>}
    {secret && !isClientSessionBlocked() && <div>
      <p>请现在复制 Key，离开后只显示前缀。</p>
      <input className="input" aria-label="新 API Key" readOnly value={secret} />
      <button type="button" className="btn btn-secondary" onClick={() => void navigator.clipboard.writeText(secret).then(
        () => setMessage('已复制 API Key。'), () => setMessage('请选中并复制 API Key。'),
      )}>复制 Key</button>
    </div>}
    {message && <p role="status">{message}</p>}
    {productDialog}
  </section>;
}
