'use client';
import { useEffect, useRef, useState } from 'react';
import { Scissors, Video } from 'lucide-react';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { createImageResultHandoff, findImageResultHandoff } from '@/lib/image-result-next/client';
import type { ImageResultNextIntent, ImageResultNextReceipt } from '@/lib/image-result-next/types';

export function ImageResultNextActions({ sourceKey, resultId, className }: { sourceKey: ContentKey; resultId?: string; className?: string }) {
  const { user } = useAppSession();
  return <ImageResultNextActionsForSource key={`${user?.id || ''}:${user?.role || ''}:${sourceKey}`}
    sourceKey={sourceKey} resultId={resultId} className={className} accountId={user?.id || ''} admin={user?.role === 'admin'} />;
}
function ImageResultNextActionsForSource({ sourceKey, resultId, className, accountId, admin }: {
  sourceKey: ContentKey; resultId?: string; className?: string; accountId: string; admin: boolean;
}) {
  const [busy, setBusy] = useState<ImageResultNextIntent | null>(null);
  const [message, setMessage] = useState('');
  const [destination, setDestination] = useState('');
  const lock = useRef(false), alive = useRef(true), requestGeneration = useRef(0);
  const pendingTarget = useRef<Window | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestGeneration.current++; pendingTarget.current?.close(); pendingTarget.current = null; };
  }, []);
  async function open(intent: ImageResultNextIntent) {
    if (lock.current || !accountId) return;
    lock.current = true; setBusy(intent); setMessage('正在核对原图并导入…'); setDestination('');
    const generation = ++requestGeneration.current;
    const isCurrentRequest = () => alive.current && requestGeneration.current === generation;
    let target: Window | null = null;
    try {
      target = window.open('about:blank', '_blank');
      pendingTarget.current = target;
      if (target) {
        target.opener = null; target.document.title = '正在导入图片'; target.document.documentElement.lang = 'zh-CN';
        const status = target.document.createElement('p'); status.textContent = '正在核对原图，完成后打开工作区。'; status.setAttribute('role', 'status');
        target.document.body.append(status);
      }
      // Always query first, including after a lost response or from another tab.
      let receipt: ImageResultNextReceipt | null = await findImageResultHandoff(sourceKey, intent);
      if (!isCurrentRequest()) { target?.close(); return; }
      if (!receipt) {
        const from = new URL(window.location.href);
        if (resultId) { from.searchParams.set('image_result_focus', resultId); from.hash = `image-result-${resultId}`; }
        receipt = await createImageResultHandoff(sourceKey, intent, `${from.pathname}${from.search}${from.hash}`);
      }
      if (!isCurrentRequest()) { target?.close(); return; }
      if (!receipt.destination.startsWith(intent === 'cutout' ? '/cutout?handoff=' : '/generate?image_result_handoff=')) throw new Error('导入目标暂不可用，原现场保留');
      setDestination(receipt.destination);
      setMessage(receipt.message);
      if (target && !target.closed) target.location.replace(receipt.destination);
    } catch (error) {
      target?.close();
      if (isCurrentRequest()) setMessage(error instanceof Error ? error.message : '导入尚未确认，请查询原记录后继续');
    } finally {
      if (isCurrentRequest()) { lock.current = false; pendingTarget.current = null; setBusy(null); }
    }
  }
  return <div className={className} data-image-result-next>
    <div role="group" aria-label="继续创作这张图片">
      <button type="button" disabled={!accountId || !admin || Boolean(busy)} aria-busy={busy === 'cutout'}
        title={admin ? '带入普通抠图，费用未知时需在目标页确认' : '抠图暂时仅对有业务授权的管理员开放'} onClick={() => void open('cutout')}><Scissors size={15} />{busy === 'cutout' ? '正在导入…' : '一键抠图'}</button>
      <button type="button" disabled={!accountId || Boolean(busy)} aria-busy={busy === 'video'} title="仅带入独立视频首帧，不生成或扣生成点数" onClick={() => void open('video')}><Video size={15} />{busy === 'video' ? '正在导入…' : '用图生成视频'}</button>
    </div>
    <small>{admin ? '抠图费用待确认；视频仅带图。' : '抠图需业务授权；视频仅带图。'}</small>
    {message && <p role="status">{message}{destination && <a href={destination} target="_blank" rel="noopener noreferrer">打开工作区</a>}</p>}
  </div>;
}
