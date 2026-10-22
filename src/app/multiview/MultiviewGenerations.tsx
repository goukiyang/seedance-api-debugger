'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Play, RefreshCw } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { parseMultiviewGenerationDraft, type MultiviewGenerationDraft } from '@/lib/video/multiview-generation-contract';
import type { MultiviewGenerationPhase } from './MultiviewGenerationPanel';
import styles from './multiview-generations.module.css';

type GenerationStatus = 'waiting' | 'running' | 'success' | 'failed' | 'unconfirmed';
type GenerationRecord = {
  id: string; status: GenerationStatus;
  deliveryStage: { key: string; label: string } | null;
  provider: string | null; model: string | null; generationMode: string | null; ratio: string | null;
  duration: number | null; resolution: string | null; seed: number | null;
  generateAudio: boolean | null; returnLastFrame: boolean | null; watermark: boolean | null;
  estimatedCost: number | null; frozenCost: number | null; actualCost: number | null;
  project: { id: string; name: string } | null; videoCard: { id: string; title: string } | null;
  createdAt: string | null; updatedAt: string | null; completedAt: string | null;
  thumbnailUrl: string | null; playUrl: string | null; downloadUrl: string | null;
  previewAvailable: boolean; stableDownloadReady: boolean;
  error: { code: string; message: string } | null;
  savedWork: { id: string; title: string; status: string; updatedAt: string } | null;
};
type ListResponse = { items: GenerationRecord[]; pageSize: number; nextCursor: string | null; error?: string };
type Props = {
  owner: string; authority: string; currentPhase: MultiviewGenerationPhase; currentTaskId?: string;
  onOpenTask: (taskId: string) => void; onOpenWork: (workId: string) => void; onOpenDraft: () => void;
};

const statusLabel: Record<GenerationStatus, string> = {
  waiting: '等待生成', running: '生成中', success: '已完成', failed: '未完成', unconfirmed: '状态待确认',
};
const activeStatus = new Set<GenerationStatus>(['waiting', 'running', 'unconfirmed']);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

function localDraft(owner: string, phase: MultiviewGenerationPhase): MultiviewGenerationDraft | null {
  if (!owner || !['empty', 'ready'].includes(phase)) return null;
  try {
    const value = parseMultiviewGenerationDraft(localStorage.getItem(`sd2:multiview-generation:v1:${owner}:draft`));
    return value?.mainImage ? value : null;
  } catch { return null; }
}

function parameters(item: Pick<GenerationRecord, 'model' | 'ratio' | 'duration' | 'resolution'>) {
  return [item.model, item.ratio, item.duration === null ? null : `${item.duration}秒`, item.resolution].filter(Boolean).join(' · ') || '生成参数待同步';
}

function draftParameters(item: MultiviewGenerationDraft) {
  return [item.model, item.ratio, `${item.duration}秒`, item.resolution].filter(Boolean).join(' · ');
}

export function MultiviewGenerations({ owner, authority, currentPhase, currentTaskId, onOpenTask, onOpenWork, onOpenDraft }: Props) {
  const identity = `${owner}:${authority}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const controllers = useRef(new Set<AbortController>());
  const epoch = useRef(0);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<MultiviewGenerationDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useCallback((captured: string, requestEpoch: number) => identityRef.current === captured
    && epoch.current === requestEpoch && !isClientSessionBlocked(), []);

  const load = useCallback(async (append = false) => {
    if (!owner || loadedIdentity !== identity || isClientSessionBlocked()) return;
    const captured = identity, requestEpoch = ++epoch.current;
    const controller = new AbortController(); controllers.current.add(controller);
    const cursor = append ? nextCursor : null;
    setLoading(true); setNotice('');
    try {
      const params = new URLSearchParams(); if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/multiview/generations?${params}`, { credentials: 'same-origin', cache: 'no-store',
        headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const payload = await response.json() as ListResponse;
      if (!alive(captured, requestEpoch)) return;
      if (!response.ok || !Array.isArray(payload.items)) throw new Error(payload.error || '生成记录暂时无法读取，请重试。');
      const clean = payload.items.filter(item => validId(item.id) && ['waiting', 'running', 'success', 'failed', 'unconfirmed'].includes(item.status));
      setItems(previous => append ? [...previous, ...clean.filter(item => !previous.some(old => old.id === item.id))] : clean);
      setNextCursor(typeof payload.nextCursor === 'string' ? payload.nextCursor : null);
    } catch (error) {
      if (alive(captured, requestEpoch) && !controller.signal.aborted) setNotice(error instanceof Error ? error.message : '生成记录暂时无法读取，请重试。');
    } finally {
      controllers.current.delete(controller);
      if (alive(captured, requestEpoch)) setLoading(false);
    }
  }, [owner, loadedIdentity, identity, nextCursor, alive]);

  useEffect(() => {
    controllers.current.forEach(controller => controller.abort()); epoch.current += 1;
    setItems([]); setNextCursor(null); setNotice(''); setLoading(false); setDraft(localDraft(owner, currentPhase)); setLoadedIdentity(identity);
    return () => { controllers.current.forEach(controller => controller.abort()); epoch.current += 1; };
  // Account/authority changes clear every previously rendered record.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, owner]);
  useEffect(() => { setDraft(localDraft(owner, currentPhase)); }, [owner, currentPhase]);
  useEffect(() => { if (loadedIdentity === identity) void load(false);
  // Loading is keyed by the current account, not by the pagination cursor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedIdentity, identity]);
  useEffect(() => {
    if (loadedIdentity !== identity || !items.some(item => activeStatus.has(item.status))) return;
    const timer = setTimeout(() => { if (!document.hidden) void load(false); }, 8000);
    return () => clearTimeout(timer);
  }, [loadedIdentity, identity, items, load]);

  if (!owner || loadedIdentity !== identity) return <p className={styles.notice}>正在读取当前账号的生成记录…</p>;
  return <section className={styles.library} aria-label="本人3D多视图生成记录">
    <header className={styles.header}>
      <div><h2>本人生成记录</h2><p>只显示当前账号的3D多视图任务、真实状态和已交付成品。</p></div>
      <button type="button" disabled={loading} onClick={() => { setDraft(localDraft(owner, currentPhase)); void load(false); }}><RefreshCw size={16} />{loading ? '正在刷新…' : '刷新'}</button>
    </header>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.grid}>
      {draft && <article className={styles.card} data-status="draft">
        <div className={styles.media}>{draft.mainImage && <img src={`/api/reference-images/${encodeURIComponent(draft.mainImage.referenceImageId)}/content?variant=thumbnail`} alt="未提交草稿的本人主图" />}</div>
        <div className={styles.body}><div className={styles.titleRow}><strong>未提交草稿</strong><span>仅保存在本机</span></div>
          <p>{draftParameters(draft)}</p><p>{draft.projectId ? '已选择项目' : '尚未选择项目'}</p>
          <div className={styles.actions}><button type="button" onClick={onOpenDraft}>继续编辑</button></div>
        </div>
      </article>}
      {items.map(item => <article className={styles.card} data-status={item.status} key={item.id}>
        <div className={styles.media}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="3D多视图生成视频预览" /> : <span>{statusLabel[item.status]}</span>}</div>
        <div className={styles.body}>
          <div className={styles.titleRow}><strong>{statusLabel[item.status]}</strong>{item.createdAt && <RelativeTime value={item.createdAt} />}</div>
          <p>{parameters(item)}</p>
          <p>{[item.project?.name, item.videoCard?.title].filter(Boolean).join(' · ') || '未关联视频卡'}</p>
          {item.deliveryStage && item.status === 'success' && <p>{item.deliveryStage.label}</p>}
          {item.error && <p className={styles.feedback}>{item.error.message}</p>}
          <div className={styles.actions}>
            {item.playUrl && <button type="button" onClick={() => onOpenTask(item.id)}><Play size={15} />打开视频与选帧</button>}
            {item.savedWork && <button type="button" onClick={() => onOpenWork(item.savedWork!.id)}><FolderOpen size={15} />打开作品</button>}
            {!item.previewAvailable && item.status !== 'success' && item.id === currentTaskId && <button type="button" onClick={() => onOpenTask(item.id)}>查看当前任务</button>}
          </div>
        </div>
      </article>)}
    </div>
    {!draft && !items.length && !loading && !notice && <div className={styles.empty}><p>还没有3D多视图生成记录</p><button type="button" onClick={onOpenDraft}>回工作台开始生成</button></div>}
    {nextCursor && <div className={styles.more}><button type="button" disabled={loading} onClick={() => void load(true)}>{loading ? '正在读取…' : '再显示24条'}</button></div>}
  </section>;
}
