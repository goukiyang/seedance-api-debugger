'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FolderOpen, Pause, Play, RefreshCw, RotateCcw, Save, X } from 'lucide-react';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';
import { handImageDownloadToBrowser } from '@/lib/media/native-download';
import { batchStateLabel, safeBatchFileName, STUDIO_BATCH_LIMITS, type StudioBatchView } from '@/lib/image-studio/batch-contract';
import { readBatchResponse } from '@/lib/image-studio/batch-receipt';
import { canSelectBatchDirectory, selectBatchDirectory, newBatchOutputDirectory, writeUniqueBatchFile, type BatchDirectoryHandle } from './batch-files';
import styles from './batch.module.css';
import { useResultPages } from '@/components/useResultPages';
type Delivery = { saved: Record<number, string>; child: BatchDirectoryHandle | null; lock: boolean; directory: BatchDirectoryHandle | null };
const deliveries = new Map<string, Delivery>();
function deliveryFor(key: string, directory?: BatchDirectoryHandle | null) {
  if (!deliveries.has(key)) {
    if (deliveries.size >= 100) { const removable = Array.from(deliveries.entries()).find(([, value]) => !value.lock); if (removable) deliveries.delete(removable[0]); }
    deliveries.set(key, { saved: {}, child: null, lock: false, directory: directory || null });
  }
  return deliveries.get(key)!;
}

export function BatchResults({ id, userId, outputDirectory, compact = false, deliveryOnly = false, autoPack = false }: { id: string; userId: string; outputDirectory?: BatchDirectoryHandle | null; compact?: boolean; deliveryOnly?: boolean; autoPack?: boolean }) {
  const { confirm, productDialog } = useProductDialog();
  const delivery = deliveryFor(`${userId}:${id}`, outputDirectory);
  const [batch, setBatch] = useState<StudioBatchView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saved, setSaved] = useState<Record<number, string>>(delivery.saved);
  const [saveError, setSaveError] = useState('');
  const [provided, setProvided] = useState<number[]>([]);
  const [zipReady, setZipReady] = useState<{ url: string; name: string } | null>(null);
  const [directory, setDirectory] = useState(delivery.directory);
  const [selected, setSelected] = useState<number[]>([]);
  const [preview, setPreview] = useState<{ src: string; alt: string; id: string } | null>(null);
  const [autoSave, setAutoSave] = useState(Boolean(outputDirectory));
  const saveLock = useRef(false), actionLock = useRef(false), reader = useRef(false);
  const childDirectory = useRef<BatchDirectoryHandle | null>(delivery.child);
  const packed = useRef(new Set<string>());
  const scope = useRef(`${userId}:${id}`); scope.current = `${userId}:${id}`;
  useEffect(() => {
    if (outputDirectory && outputDirectory !== delivery.directory && !delivery.lock) { delivery.directory = outputDirectory; delivery.child = null; delivery.saved = {}; childDirectory.current = null; setDirectory(outputDirectory); setSaved({}); }
  }, [outputDirectory, delivery]);
  useEffect(() => { scope.current = `${userId}:${id}`; return () => { scope.current = ''; }; }, [userId, id]);
  const load = useCallback(async () => {
    if (reader.current) return;
    reader.current = true; setReading(true);
    const expected = `${userId}:${id}`;
    try {
      const data = await readBatchResponse(await fetch(`/api/image-studio/batches?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }), true);
      if (scope.current === expected) { setBatch(data.batch); setSaved({ ...delivery.saved }); setError(''); }
    } catch (error) { if (scope.current === expected) setError(error instanceof Error ? error.message : '批次读取失败'); }
    finally { reader.current = false; if (scope.current === expected) setReading(false); }
  }, [id, userId]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000); return () => clearInterval(timer); }, [load]);
  async function action(action: string) {
    if (actionLock.current || !batch) return;
    actionLock.current = true; setBusy(true); setError('');
    const expected = `${userId}:${id}`, ordinals = [...selected], retryBudget = batch.committedCredits + ordinals.length * batch.unitCredits;
    try {
      const quoteRetry = async () => {
        if (!batch.model) throw new Error('原批次模型报价无法核对，请先查询原批次；没有重新生成');
        const current = await readBatchResponse(await fetch('/api/image-studio/settings', { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
        if (scope.current !== expected || current.prices?.[batch.model] !== batch.unitCredits) throw new Error('本批报价已变化，请重新核对；没有重试生成');
      };
      if (action === 'retry') {
        await quoteRetry();
        if (!await confirm(`仅重试所选失败${ordinals.length}项，本次预计${ordinals.length * batch.unitCredits}点；已成功结果不再生成。`, { title: '确认重试', confirmLabel: `确认重试 · ${ordinals.length * batch.unitCredits}点`, anchor: null })) return;
        await quoteRetry();
      }
      if (scope.current !== expected) return;
      const data = await readBatchResponse(await fetch('/api/image-studio/batches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, ...(action === 'retry' ? { ordinals, budget: retryBudget } : {}) }), signal: AbortSignal.timeout(20000) }), true);
      if (scope.current !== expected) return;
      if (action === 'retry') watchGenerationCompletion(userId, id, 'batch', batch.total, crypto.randomUUID(), batch.generated);
      setBatch(data.batch); setSelected([]);
    } catch (error) { if (scope.current === expected) setError(error instanceof Error ? error.message : '操作结果待确认，请刷新原批次'); }
    finally { actionLock.current = false; if (scope.current === expected) setBusy(false); }
  }
  async function chooseDirectory() {
    try { const selected = await selectBatchDirectory('readwrite'); setDirectory(selected); childDirectory.current = null; delivery.directory = selected; delivery.child = null; delivery.saved = {}; setSaved({}); setSaveError(''); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setSaveError(error instanceof Error ? error.message : '请重新选择保存位置'); }
  }
  async function saveImages(automatic = false) {
    if (!batch || !directory || saveLock.current || delivery.lock) return;
    saveLock.current = true; delivery.lock = true; setSaveBusy(true); setSaveError('');
    const nextSaved = { ...delivery.saved }, expected = `${userId}:${id}`;
    try {
      if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted' && (automatic || await directory.requestPermission({ mode: 'readwrite' }) !== 'granted')) throw new Error('目录权限已失效，请重新选择保存位置');
      if (!delivery.child) delivery.child = await newBatchOutputDirectory(directory, id);
      childDirectory.current = delivery.child;
      for (const item of batch.items || []) {
        if (scope.current !== expected) throw new Error('已离开本批结果，后续本机保存已停止');
        if (!item.image || nextSaved[item.ordinal]) continue;
        const response = await fetch(item.image.url, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`第 ${item.ordinal} 张读取失败，请重试保存`);
        const blob = await response.blob();
        if (scope.current !== expected) throw new Error('已离开本批结果，后续本机保存已停止');
        if (!blob.type.startsWith('image/png') || !blob.size || blob.size > 96 * 1024 * 1024) throw new Error(`第 ${item.ordinal} 张图片格式或大小未确认`);
        const fileName = await writeUniqueBatchFile(childDirectory.current, safeBatchFileName(id, item.ordinal, item.sourceName), blob);
        nextSaved[item.ordinal] = fileName; delivery.saved = { ...nextSaved }; setSaved({ ...nextSaved });
      }
      await writeUniqueBatchFile(childDirectory.current, 'results.json', JSON.stringify({ batch: id, createdAt: batch.createdAt, generated: batch.generated, total: batch.total, saved: Object.keys(nextSaved).length,
        items: batch.items?.map(item => ({ ordinal: item.ordinal, source: item.sourceName, task: item.taskId, generation: item.status, file: nextSaved[item.ordinal] || null, save: nextSaved[item.ordinal] ? 'saved-and-size-checked' : 'not-saved' })) }, null, 2));
    } catch (error) { setAutoSave(false); setSaveError(error instanceof Error ? error.message : '保存未完成，请重选目录或补保存；不会重新生成'); }
    finally { saveLock.current = false; delivery.lock = false; setSaveBusy(false); }
  }
  useEffect(() => { if (autoSave && directory && !saveBusy && batch?.items?.some(item => item.image && !saved[item.ordinal])) void saveImages(true); }, [autoSave, directory, batch, saved, saveBusy]);
  const packages: Array<NonNullable<StudioBatchView['items']>> = [];
  for (const item of batch?.items || []) {
    if (!item.image || !item.taskId) continue;
    const previous = packages[packages.length - 1];
    if (!previous || previous.length >= STUDIO_BATCH_LIMITS.zipImages || previous.reduce((sum, entry) => sum + (entry.image?.fileSize || 0), 0) + item.image.fileSize > STUDIO_BATCH_LIMITS.zipBytes) packages.push([item]);
    else previous.push(item);
  }
  async function downloadPackage(index: number) {
    if (saveLock.current || !packages[index]?.length) return false;
    const expected = `${userId}:${id}`;
    saveLock.current = true; setSaveBusy(true); setSaveError('');
    try {
      const query = new URLSearchParams({ batchId: id }); packages[index].forEach(item => query.append('id', item.taskId!));
      const name = `batch-${id.slice(0, 12)}-part-${index + 1}.zip`, url = `/api/image-studio/download?${query}`;
      if (scope.current !== expected) return false;
      await handImageDownloadToBrowser(url, name, () => scope.current === expected);
      if (scope.current !== expected) return false;
      setZipReady({ url, name });
      setProvided(previous => Array.from(new Set([...previous, ...packages[index].map(item => item.ordinal)])));
      return true;
    } catch (error) { if (scope.current === expected) setSaveError(error instanceof Error ? error.message : '下载准备失败，已有图片仍保留'); return false; }
    finally { saveLock.current = false; if (scope.current === expected) setSaveBusy(false); }
  }
  useEffect(() => {
    if (!autoPack || !batch || batch.active || batch.pending || batch.uncertain || !['complete', 'cancelled'].includes(batch.state) || !packages.length) return;
    const expected = `${userId}:${id}`;
    void (async () => {
      for (let index = 0; index < packages.length; index++) {
        const key = packages[index].map(item => item.taskId).join('|');
        if (scope.current !== expected || packed.current.has(key)) continue;
        packed.current.add(key);
        if (!await downloadPackage(index)) break;
      }
    })();
  // The terminal result set determines packages; exporting never creates image tasks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPack, batch?.state, batch?.generated, batch?.active, batch?.pending, batch?.uncertain]);
  const statusLabel = (state: string) => ({ pending: '等待派发', queued: '已受理，排队中', running: '生成中', succeeded: '已生成', failed: '生成失败', uncertain: '结果待确认', cancelled: '未派发，已取消' } as Record<string, string>)[state] || '状态待确认';
  const resultItems = useMemo(() => (batch?.items || []).map(item => ({ ...item, id: String(item.ordinal) })), [batch?.items]);
  const resultPages = useResultPages({ items: resultItems, storageKey: `sd2-image-studio-batch-page:${userId}:${id}`, visible: !deliveryOnly && resultItems.length > 0,
    busy: reading, error: Boolean(error), hasMore: false, loadMore: load, currentId: preview?.id || null });
  return <div className={styles.results} aria-label="批次结果">
    <div className={styles.actions}><strong>{batch?.moduleName || '本批结果'}</strong><button type="button" title="刷新批次" aria-label="刷新批次" disabled={reading} onClick={() => void load()}><RefreshCw size={16} /></button>{deliveryOnly && <a href={`/assets?imageBatchId=${encodeURIComponent(id)}`}>本批资产</a>}</div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!batch && <p role="status">{reading ? '正在读取原批次' : '尚未读取批次'}，不会重新提交生成。</p>}
    {batch && <>
      <p className={styles.summary}>{batchStateLabel(batch.state)} · <RelativeTime value={batch.createdAt} /> · 已生成 {batch.generated}/{batch.total} · 已保存 {Object.keys(saved).length}/{batch.generated} · 失败 {batch.failed} · 待确认 {batch.uncertain}</p>
      {!deliveryOnly && <p>素材已准备 {batch.prepared}/{batch.total} · 在途 {batch.active} · 未派发 {batch.pending}</p>}
      {batch.note && <p role="status">{batch.note}</p>}
      <div className={styles.actions}>
        {['preparing', 'blocked'].includes(batch.state) && batch.prepared < batch.total && <button type="button" disabled={busy} onClick={() => void action('prepare')}><RefreshCw size={16} />继续准备原批素材</button>}
        {batch.state === 'ready' && <button type="button" disabled={busy} onClick={() => void action('pause')}><Pause size={16} />暂停未派发</button>}
        {['paused', 'blocked'].includes(batch.state) && batch.prepared === batch.total && <button type="button" disabled={busy} onClick={() => void action('resume')}><Play size={16} />继续剩余</button>}
        {!['cancelled', 'complete'].includes(batch.state) && <button type="button" disabled={busy} onClick={() => void action('cancel')}><X size={16} />取消未派发</button>}
      </div>
      {batch.uncertain > 0 && <p role="status">结果未知项不会自动重发。请刷新查询原任务，仍未知时联系管理员核对。</p>}
      {batch.generated > 0 && <div className={styles.delivery}>
        <div className={styles.actions}>{canSelectBatchDirectory() && <button type="button" disabled={saveBusy} onClick={() => void chooseDirectory()}><FolderOpen size={16} />{directory ? '重新选择保存位置' : '选择结果保存位置'}</button>}
          {directory && <><label><input type="checkbox" checked={autoSave} onChange={event => setAutoSave(event.target.checked)} />本页打开时自动保存新结果</label><button type="button" className={styles.primary} disabled={saveBusy || Object.keys(saved).length === batch.generated} onClick={() => void saveImages()}><Save size={16} />{saveBusy ? '保存中' : '补保存已有图片'}</button></>}
          {packages.map((items, index) => <button type="button" key={index} disabled={saveBusy} onClick={() => void downloadPackage(index)}><Download size={16} />下载第 {index + 1} 包 · {items.length} 张</button>)}</div>
        {directory && <p>保存至所选位置的新批次子目录，不覆盖已有文件。关网页后不会继续写本机。</p>}
        {provided.length > 0 && <p role="status">已提供 {provided.length} 张下载，尚未确认本机落盘。</p>}
        {zipReady && <a href={zipReady.url} download={zipReady.name}>再次下载已准备的包</a>}
        {saveError && <p role="alert" className={styles.error}>{saveError}，只补保存，不重新生成。</p>}
      </div>}
      {!deliveryOnly && batch.failed > 0 && <div className={styles.retry}><span>选中失败项 {selected.length} 张，本次重试预计 {selected.length * batch.unitCredits} 点；每项最多重试 3 次</span><button type="button" disabled={busy || !selected.length} onClick={() => void action('retry')}><RotateCcw size={16} />重试选中失败项</button></div>}
      {!deliveryOnly && <div ref={resultPages.gridRef} className={compact ? styles.compactItems : styles.items} data-result-pages data-page-capacity={resultPages.capacity}>{resultPages.pageItems.map(item => <article className={styles.item} key={item.ordinal} data-result-id={item.id}>
        {item.image ? <button type="button" aria-label={`预览第 ${item.ordinal} 张结果`} onClick={() => setPreview({ src: item.image!.url, alt: `第 ${item.ordinal} 张结果`, id: item.id })}><img src={item.image.thumbnail} alt={`第 ${item.ordinal} 张结果`} loading="lazy" /></button> : <div className={styles.placeholder}>暂无截图</div>}
        <div><strong>{item.ordinal}. {item.sourceName}</strong><p>{statusLabel(item.status)}</p>{item.error && <p className={styles.error}>{item.error}</p>}{saved[item.ordinal] && <p>已保存并核对大小</p>}</div>
        {item.status === 'failed' && <input type="checkbox" disabled={busy} aria-label={`重试第 ${item.ordinal} 项`} checked={selected.includes(item.ordinal)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.ordinal] : previous.filter(value => value !== item.ordinal))} />}
      </article>)}</div>}
      {!deliveryOnly && resultItems.length > 0 && <nav className={styles.pagination} aria-label="批次图片分页">
        <button type="button" title="上一页图片" aria-label="上一页图片" disabled={resultPages.start === 0 || resultPages.restoring} onClick={resultPages.previous}><ChevronLeft size={17} /></button>
        <span role="status">第 {resultPages.page} / {resultPages.pages} 页</span>
        <button type="button" title="下一页图片" aria-label="下一页图片" disabled={!resultPages.canNext || resultPages.restoring} onClick={resultPages.next}><ChevronRight size={17} /></button>
        {resultPages.start > 0 && <button type="button" title="回到第一页图片" aria-label="回到第一页图片" onClick={resultPages.reset}><RotateCcw size={15} /></button>}
      </nav>}
    </>}{preview && <ZoomableImagePreview src={preview.src} alt={preview.alt} fileName="batch-image.png"
      comparisonCandidates={(batch?.items || []).flatMap(item => item.image ? [{ src: item.image.url, thumbnailSrc: item.image.thumbnail, alt: `生成结果 ${item.ordinal}`, contentKey: `asset:${item.image.id}` as const }] : [])}
      onClose={() => setPreview(null)} />}
    {productDialog}
  </div>;
}

export function StudioBatchHistory({ userId, initialId }: { userId: string; initialId?: string }) {
  const [open, setOpen] = useState(false), [batches, setBatches] = useState<StudioBatchView[]>([]), [id, setId] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false);
  useEffect(() => { if (initialId && /^[a-f0-9]{64}$/.test(initialId)) { setId(initialId); setOpen(true); } }, [initialId]);
  async function load(more = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const data = await readBatchResponse(await fetch(`/api/image-studio/batches${more && cursor ? `?cursor=${cursor}` : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      setBatches(previous => more ? [...previous, ...data.batches] : data.batches); setCursor(data.nextCursor);
    } catch (error) { setError(error instanceof Error ? error.message : '批次读取失败'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { if (open) { dialog.current?.showModal(); void load(); } }, [open]);
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: () => setOpen(false) });
  return <><button type="button" onClick={() => setOpen(true)}><FolderOpen size={16} />我的批次</button>{open && <dialog ref={dialog} className={styles.dialog} aria-labelledby="batch-history-title">
    <header className={styles.actions}><h2 id="batch-history-title">我的批次</h2><button type="button" aria-label="关闭我的批次" onClick={() => setOpen(false)}><X size={18} /></button></header>
    {id ? <><button type="button" onClick={() => setId(null)}>返回批次列表</button><BatchResults key={`${userId}:${id}`} id={id} userId={userId} /></> : <>
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />刷新批次</button></div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {!batches.length && !busy && !error && <p>暂无批次</p>}
      {batches.map(batch => <article className={styles.historyItem} key={batch.id}><button type="button" onClick={() => setId(batch.id)}><strong>{batch.moduleName}</strong><span>{batchStateLabel(batch.state)} · 已生成 {batch.generated}/{batch.total}</span></button><RelativeTime value={batch.createdAt} /></article>)}
      {cursor && <button type="button" disabled={busy} onClick={() => void load(true)}>加载更多</button>}
    </>}
  </dialog>}</>;
}
