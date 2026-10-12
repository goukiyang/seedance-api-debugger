'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import { uploadSession } from '@/lib/http/upload-session';
import { SessionPreviewImage } from './SessionPreviewImage';
import { useDialogDismiss } from './useDialogDismiss';
import { ZoomableImagePreview } from './ZoomableImagePreview';
import styles from './UploadSimilarityReview.module.css';

export type UploadSimilarityReviewProps = {
  ownerId: string;
  assets: UploadedAssetPayload[];
  onChooseExisting?: (candidate: UploadedAssetPayload, uploadedAsset: UploadedAssetPayload) => Promise<void>;
  chooseExistingTarget?: (uploadedAsset: UploadedAssetPayload) => string;
  onDismiss?: () => void;
};
type Candidate = {
  assetId: string; sourceVersion: string; width: number | null; height: number | null;
  mimeType: string; fileSize: number | null; fileName: string; phashDistance: number; colorDistance: number;
};
type CheckState = 'checking' | 'disabled' | 'queued' | 'running' | 'ready' | 'failed' | 'unsupported' | 'unavailable';
type Check = { state: CheckState; sourceVersion?: string; algorithmVersion?: string; candidates: Candidate[]; error?: string };
const MAX_ASSETS = 24;
const MAX_CANDIDATES = 10;
const MAX_READS = 4;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const version = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value);
const mediaUrl = (id: string, variant = 'original') => `/api/content-reactions/media?${new URLSearchParams({ key: `asset:${id}`, variant })}`;
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
function parseCheck(value: unknown, asset: UploadedAssetPayload): Check {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('相似检查结果未确认，已上传图片仍保留');
  const data = value as Record<string, unknown>;
  if (!['disabled', 'queued', 'running', 'ready', 'failed', 'unsupported', 'unavailable'].includes(String(data.state))
    || data.coverage !== 'new_uploads_only') throw new Error('相似检查结果未确认，已上传图片仍保留');
  const sourceVersion = version(data.sourceVersion) ? data.sourceVersion : undefined;
  const algorithmVersion = version(data.algorithmVersion) ? data.algorithmVersion : undefined;
  if (sourceVersion && asset.upload?.sourceVersion && sourceVersion !== asset.upload.sourceVersion) {
    throw new Error('上传图片的版本已变化，请重新打开当前图片；原图片仍保留');
  }
  if (data.state === 'ready' && (!sourceVersion || !algorithmVersion || !Array.isArray(data.candidates))) {
    throw new Error('相似检查结果未确认，已上传图片仍保留');
  }
  const seen = new Set<string>();
  const candidates: Candidate[] = data.state === 'ready' && Array.isArray(data.candidates) ? data.candidates.slice(0, MAX_CANDIDATES).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (!identifier(item.assetId) || item.assetId === asset.id || seen.has(item.assetId) || !version(item.sourceVersion)
      || typeof item.phashDistance !== 'number' || !Number.isFinite(item.phashDistance) || item.phashDistance < 0
      || typeof item.colorDistance !== 'number' || !Number.isFinite(item.colorDistance) || item.colorDistance < 0) return [];
    seen.add(item.assetId);
    return [{ assetId: item.assetId, sourceVersion: item.sourceVersion, width: positive(item.width), height: positive(item.height),
      mimeType: typeof item.mimeType === 'string' ? item.mimeType.slice(0, 100) : '', fileSize: positive(item.fileSize),
      fileName: typeof item.fileName === 'string' ? item.fileName.slice(0, 240) : '已有图片',
      phashDistance: item.phashDistance, colorDistance: item.colorDistance }];
  }) : [];
  if (data.state === 'ready' && Array.isArray(data.candidates) && data.candidates.length > 0 && candidates.length === 0) {
    throw new Error('相似候选无法确认，请重新检查；已上传图片仍保留');
  }
  return { state: data.state as CheckState, sourceVersion, algorithmVersion, candidates };
}
function sizeText(bytes: number | null | undefined) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function metadata(asset: { width?: number | null; height?: number | null; mimeType?: string; fileSize?: number | null }) {
  const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : '尺寸未知';
  const format = asset.mimeType?.startsWith('image/') ? asset.mimeType.slice(6).toUpperCase() : '格式未知';
  return `${dimensions} · ${format} · ${sizeText(asset.fileSize)}`;
}
function stateLabel(check?: Check) {
  if (!check || check.state === 'checking') return '正在读取相似检查';
  if (check.error) return check.error;
  return { disabled: '相似检查尚未启用', queued: '相似检查排队中，可稍后重新查看', running: '相似检查进行中，可稍后重新查看',
    ready: check.candidates.length ? `发现 ${check.candidates.length} 张相似图片` : '本次已索引图片中未发现相似候选',
    failed: '相似检查暂未完成，已上传图片仍保留', unsupported: '这张图片暂不支持相似检查', unavailable: '图片权限或来源已变化，请重新读取' }[check.state];
}

export function UploadSimilarityReview({ ownerId, assets, onChooseExisting, chooseExistingTarget, onDismiss }: UploadSimilarityReviewProps) {
  const { user, hasLoadedUser } = useAppSession();
  const epoch = uploadSession().epoch;
  const scope = `${ownerId}:${user?.id || ''}:${user?.role || ''}:${user?.account_type || ''}:${epoch}`;
  const permitted = Boolean(hasLoadedUser && ownerId && user?.id === ownerId && uploadSession().ownerId === ownerId);
  const inputSignature = JSON.stringify(assets.filter(asset => identifier(asset.id)).map(asset => [asset.id, asset.upload?.sourceVersion || '', asset.upload?.requestId || '']));
  const inputRef = useRef(assets); inputRef.current = assets;
  const images = useMemo(() => Array.from(new Map(inputRef.current.filter(asset => identifier(asset.id)
    && (!asset.mimeType || asset.mimeType.startsWith('image/'))).map(asset => [asset.id!, asset])).values()).slice(0, MAX_ASSETS), [inputSignature]);
  const [data, setData] = useState<{ scope: string; checks: Record<string, Check> }>({ scope: '', checks: {} });
  const checks = data.scope === scope ? data.checks : {};
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const summaryRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const reviewId = useId();
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const permittedRef = useRef(permitted); permittedRef.current = permitted;
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const controllers = useRef(new Set<AbortController>());
  const actionLock = useRef(false);
  const stopReads = useCallback(() => {
    sequence.current++;
    if (timer.current) clearTimeout(timer.current);
    for (const controller of Array.from(controllers.current)) controller.abort();
    controllers.current.clear();
  }, []);
  const current = useCallback((savedScope: string, savedSequence: number) => permittedRef.current && scopeRef.current === savedScope
    && sequence.current === savedSequence && uploadSession().ownerId === ownerId && uploadSession().epoch === epoch, [ownerId, epoch]);
  const readCheck = useCallback(async (asset: UploadedAssetPayload, savedScope: string, savedSequence: number) => {
    const controller = new AbortController(); controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`/api/assets/upload-similarity?${new URLSearchParams({ assetId: asset.id! })}`, { signal: controller.signal, cache: 'no-store' });
      const value = await readJsonResponse<Record<string, unknown>>(response, { invalidJsonMessage: '相似检查暂时无法读取，已上传图片仍保留' });
      if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? '图片权限或登录状态已变化，请重新读取'
        : response.status === 409 ? '图片版本已变化，请重新读取相似检查' : '相似检查暂时无法读取，已上传图片仍保留');
      if (!current(savedScope, savedSequence)) throw new Error('stale_review');
      return parseCheck(value, asset);
    } finally { clearTimeout(timeout); controllers.current.delete(controller); }
  }, [current]);
  const startReads = useCallback((requested = images) => {
    if (!permittedRef.current || document.visibilityState === 'hidden' || actionLock.current) return;
    stopReads();
    const savedSequence = sequence.current, savedScope = scope;
    const attempts = new Map<string, number>();
    setData(previous => ({ scope: savedScope, checks: { ...(previous.scope === savedScope ? previous.checks : {}),
      ...Object.fromEntries(requested.map(asset => [asset.id!, { state: 'checking', candidates: [] } satisfies Check])) } }));
    const run = async (pending: UploadedAssetPayload[]) => {
      let cursor = 0;
      const next: UploadedAssetPayload[] = [];
      const worker = async () => {
        while (cursor < pending.length && current(savedScope, savedSequence) && document.visibilityState !== 'hidden') {
          const asset = pending[cursor++];
          attempts.set(asset.id!, (attempts.get(asset.id!) || 0) + 1);
          let check: Check;
          try { check = await readCheck(asset, savedScope, savedSequence); }
          catch {
            if (!current(savedScope, savedSequence)) return;
            check = { state: 'failed', candidates: [], error: '相似检查暂时无法读取，已上传图片仍保留' };
          }
          if (!current(savedScope, savedSequence)) return;
          setData(previous => previous.scope === savedScope ? { ...previous, checks: { ...previous.checks, [asset.id!]: check } } : previous);
          if (['queued', 'running'].includes(check.state) && attempts.get(asset.id!)! < MAX_READS) next.push(asset);
        }
      };
      await Promise.all([worker(), worker()]);
      if (next.length && current(savedScope, savedSequence) && document.visibilityState !== 'hidden') timer.current = setTimeout(() => void run(next), 1800);
    };
    void run(requested);
  }, [images, scope, stopReads, current, readCheck]);
  useEffect(() => {
    setExpanded(false); setDismissed(false); setPreviewOpen(false); setSelectedId(images[0]?.id || ''); setCandidateId('');
    setActionBusy(false); actionLock.current = false; setActionError(''); setNotice('');
    if (permitted) startReads();
    return stopReads;
  }, [scope, inputSignature, permitted, images, startReads, stopReads]);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState !== 'hidden') return;
      stopReads();
      setData(previous => previous.scope === scopeRef.current ? { ...previous, checks: Object.fromEntries(Object.entries(previous.checks)
        .map(([id, check]) => [id, check.state === 'checking' ? { state: 'queued', candidates: [], error: '相似检查已暂停，可重新检查' } satisfies Check : check])) } : previous);
      if (actionLock.current) {
        actionLock.current = false; setActionBusy(false); setActionError('确认结果尚未核对，两张图片仍保留；请重新检查原选择');
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [stopReads]);
  const collapse = useCallback(() => {
    if (actionLock.current) return;
    stopReads(); setExpanded(false); setPreviewOpen(false);
  }, [stopReads]);
  useDialogDismiss({ open: expanded && permitted, dialogRef: reviewRef, branchRefs: [summaryRef], onDismiss: collapse, modal: false });
  const uploaded = images.find(asset => asset.id === selectedId) || images[0];
  const check = uploaded?.id ? checks[uploaded.id] : undefined;
  const candidate = check?.candidates.find(item => item.assetId === candidateId) || check?.candidates[0];
  const found = images.filter(asset => checks[asset.id!]?.candidates.length).length;
  const pending = images.some(asset => !checks[asset.id!] || ['checking', 'queued', 'running'].includes(checks[asset.id!].state));
  const disabled = images.length > 0 && images.every(asset => checks[asset.id!]?.state === 'disabled');
  const unsupported = images.some(asset => checks[asset.id!]?.state === 'unsupported');
  const partiallyDisabled = images.some(asset => checks[asset.id!]?.state === 'disabled');
  const failures = images.some(asset => ['failed', 'unavailable'].includes(checks[asset.id!]?.state || ''));
  async function act(choose: boolean) {
    if (actionLock.current || !uploaded || !candidate || check?.state !== 'ready' || !check.sourceVersion || !check.algorithmVersion) return;
    stopReads(); actionLock.current = true; setActionBusy(true); setActionError(''); setNotice('');
    const savedScope = scope, savedSequence = sequence.current;
    try {
      const fresh = await readCheck(uploaded, savedScope, savedSequence);
      const matched = fresh.candidates.find(item => item.assetId === candidate.assetId && item.sourceVersion === candidate.sourceVersion);
      if (fresh.state !== 'ready' || !matched || fresh.sourceVersion !== check.sourceVersion || fresh.algorithmVersion !== check.algorithmVersion) {
        throw new Error('候选或图片版本已变化，请重新检查；两张图片仍保留');
      }
      if (choose) {
        if (!onChooseExisting || !current(savedScope, savedSequence)) return;
        await onChooseExisting({ id: matched.assetId, originalUrl: mediaUrl(matched.assetId), thumbnailUrl: mediaUrl(matched.assetId, 'thumbnail'),
          width: matched.width, height: matched.height, mimeType: matched.mimeType, fileName: matched.fileName, fileSize: matched.fileSize ?? undefined }, uploaded);
        if (current(savedScope, savedSequence)) setNotice('已选择已有图片，新上传图片仍保留');
      } else {
        const controller = new AbortController(); controllers.current.add(controller);
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch('/api/assets/upload-similarity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ action: 'keep_both', assetId: uploaded.id, sourceVersion: fresh.sourceVersion, candidateAssetId: matched.assetId,
              candidateSourceVersion: matched.sourceVersion, algorithmVersion: fresh.algorithmVersion }) });
          const result = await readJsonResponse<{ kept?: boolean; success?: boolean }>(response, { invalidJsonMessage: '保留选择尚未确认，两张图片仍保留，请重新检查' });
          if (!response.ok || result.kept !== true && result.success !== true) throw new Error('保留选择尚未确认，两张图片仍保留，请重新检查后重试');
          if (!current(savedScope, savedSequence)) return;
          setData(previous => previous.scope === savedScope ? { ...previous, checks: { ...previous.checks,
            [uploaded.id!]: { ...fresh, candidates: fresh.candidates.filter(item => item.assetId !== matched.assetId) } } } : previous);
          setCandidateId(''); setNotice('已记住保留两张，本配对不再提醒；已加入的图片和引用不变');
        } finally { clearTimeout(timeout); controllers.current.delete(controller); }
      }
    } catch (error) {
      if (current(savedScope, savedSequence)) setActionError(error instanceof Error && error.message !== 'stale_review' ? error.message : '结果尚未确认，请重新检查');
    } finally { if (current(savedScope, savedSequence)) { actionLock.current = false; setActionBusy(false); } }
  }
  if (!permitted || dismissed || !images.length) return null;
  return <section className={styles.root} aria-label="上传图片相似检查">
    <div ref={summaryRef} className={styles.summary} aria-live="polite">
      <span>{found ? `发现相似图片 · ${found} 张上传图片` : disabled ? '相似检查尚未启用'
        : failures ? '部分相似检查暂未完成，上传已成功' : pending ? '图片已加入，相似检查可稍后查看'
          : unsupported ? '部分图片暂不支持相似检查，上传已成功' : partiallyDisabled ? '部分相似检查尚未启用' : '本次已索引图片中未发现相似候选'}</span>
      <button type="button" aria-expanded={expanded} aria-controls={reviewId} onClick={() => {
        if (expanded) collapse(); else { setExpanded(true); setActionError(''); startReads(); }
      }}>{expanded ? '收起' : '查看'}</button>
      <button type="button" className={styles.close} aria-label="关闭相似检查摘要" disabled={actionBusy} onClick={() => {
        stopReads(); setExpanded(false); setDismissed(true); onDismiss?.();
      }}><X size={15} aria-hidden="true" /></button>
    </div>
    {expanded && <section id={reviewId} ref={reviewRef} className={styles.review} aria-label="相似图片查看">
      <div className={styles.heading}><div><h3>相似图片</h3><p>仅检查本次新上传的已索引图片，未扫描全部历史图片。细节不同的版本可以保留。</p></div>
        <button type="button" onClick={collapse} disabled={actionBusy}>收起</button></div>
      {assets.length > MAX_ASSETS && <p className={styles.hint}>单次最多查看 {MAX_ASSETS} 张，其他上传结果保留。</p>}
      {images.length > 1 && <label className={styles.select}>本次上传<select value={uploaded?.id || ''} disabled={actionBusy} onChange={event => {
        setSelectedId(event.target.value); setCandidateId(''); setActionError(''); setNotice('');
        const asset = images.find(item => item.id === event.target.value); if (asset) startReads([asset]);
      }}>{images.map((asset, index) => <option key={asset.id} value={asset.id}>图片 {index + 1} · {stateLabel(checks[asset.id!])}</option>)}</select></label>}
      <p className={styles.status} role="status">{stateLabel(check)}</p>
      {candidate && check?.state === 'ready' && uploaded && <>
        {check.candidates.length > 1 && <label className={styles.select}>已有候选<select value={candidate.assetId} disabled={actionBusy} onChange={event => { setCandidateId(event.target.value); setActionError(''); setNotice(''); }}>
          {check.candidates.map((item, index) => <option key={item.assetId} value={item.assetId}>候选 {index + 1} · {metadata(item)}</option>)}</select></label>}
        <div className={styles.pair}>
          {[{ asset: uploaded, id: uploaded.id!, label: '本次上传' }, { asset: candidate, id: candidate.assetId, label: '已有图片' }].map(item =>
            <figure key={item.label}><figcaption><strong>{item.label}</strong><span>{metadata(item.asset)}</span></figcaption>
              <button type="button" className={styles.image} disabled={actionBusy} onClick={() => { stopReads(); setPreviewOpen(true); }} aria-label={`查看${item.label}原件与对比`}>
                <SessionPreviewImage src={mediaUrl(item.id)} thumbnail={mediaUrl(item.id, 'thumbnail')} alt={item.label} />
              </button></figure>)}
        </div>
        <div className={styles.actions}><button type="button" className={styles.primary} disabled={actionBusy} onClick={() => { stopReads(); setPreviewOpen(true); }}>查看原件与对比</button>
          <button type="button" disabled={actionBusy} onClick={() => void act(false)}>{actionBusy ? '正在确认' : '保留两张'}</button>
          {onChooseExisting && <button type="button" disabled={actionBusy} onClick={() => void act(true)}>此处改用已有图片</button>}</div>
        {onChooseExisting && <p className={styles.hint}>替换对象：{chooseExistingTarget?.(uploaded) || '当前选择'}。只替换当前选择，两张原图都保留，不影响已提交任务；模板内容仍需主动保存。</p>}
        <p className={styles.hint}>不会自动删除、合并或替换图片；文件更大不代表画质更好。</p>
      </>}
      {!actionBusy && check?.state !== 'checking' && <button type="button" className={styles.retry} onClick={() => { setActionError(''); startReads(uploaded ? [uploaded] : images); }}>重新检查</button>}
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
      {notice && <p className={styles.status} role="status">{notice}</p>}
    </section>}
    {previewOpen && uploaded && candidate && <ZoomableImagePreview src={mediaUrl(uploaded.id!)} thumbnailSrc={mediaUrl(uploaded.id!, 'thumbnail')}
      alt="本次上传" contentKey={`asset:${uploaded.id!}`} fileName={uploaded.fileName} previewKey={`upload-review-${uploaded.id!}-${candidate.assetId}`}
      safeDetails={{ width: uploaded.width || undefined, height: uploaded.height || undefined, fileSize: uploaded.fileSize }}
      comparison={{ src: mediaUrl(candidate.assetId), thumbnailSrc: mediaUrl(candidate.assetId, 'thumbnail'), alt: '已有相似图片',
        contentKey: `asset:${candidate.assetId}`, fileName: candidate.fileName, width: candidate.width || undefined, height: candidate.height || undefined, fileSize: candidate.fileSize || undefined }}
      notice="两张图片均保留，可使用对比按钮检查细节。关闭后回到相似图片选择。"
      onClose={() => { stopReads(); setPreviewOpen(false); }} />}
  </section>;
}

export default UploadSimilarityReview;
