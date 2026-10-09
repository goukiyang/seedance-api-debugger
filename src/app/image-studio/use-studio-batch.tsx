'use client';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, RotateCcw } from 'lucide-react';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useProductDialog } from '@/components/useProductDialog';
import { STUDIO_BATCH_LIMITS } from '@/lib/image-studio/batch-contract';
import { readBatchResponse } from '@/lib/image-studio/batch-receipt';
import { canSelectBatchDirectory, selectBatchDirectory, readBatchDirectory, previewBatchFiles, type BatchLocalFile } from './batch-files';
import { IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_QUALITY_LABELS } from '@/lib/image-studio/model-catalog';
import styles from './batch.module.css';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';

type StudioBatchQuote = { billingMode: 'fixed' | 'actual'; batchQuoteId: string | null; estimatedCredits: number; unitCredits: number; expiresAt: string };
type CachedStudioBatchQuote = { signature: string; requestId: string; quote: StudioBatchQuote; expired?: boolean };

export function useStudioBatch({ userId, moduleId, unitCredits, draftSignature, actualQuoteRequired = false, quotePayload }: { userId: string; moduleId: string; unitCredits: number | null; draftSignature: string; actualQuoteRequired?: boolean; quotePayload?: Record<string, unknown> | null }) {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [source, setSource] = useState<'current' | 'folder'>('folder');
  const [quantity, setQuantity] = useState(8), [perFile, setPerFile] = useState(1), [pack, setPack] = useState(false);
  const [folderName, setFolderName] = useState(''), [advanced, setAdvanced] = useState(false);
  const [files, setFiles] = useState<BatchLocalFile[]>([]), [skipped, setSkipped] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('');
  const [id, setId] = useState<string | null>(null), [pending, setPending] = useState<string | null>(null);
  const [billingQuote, setBillingQuote] = useState<CachedStudioBatchQuote | null>(null);
  const [quoteVisible, setQuoteVisible] = useState(true);
  useEffect(() => { const update = () => setQuoteVisible(!document.hidden); update(); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  const [loadedScope, setLoadedScope] = useState('');
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null), lock = useRef(false), fileRef = useRef<BatchLocalFile[]>([]);
  const scopedKey = `sd2-studio-batch-draft:v1:${userId}:${moduleId}`, pendingKey = `${scopedKey}:request`;
  const loaded = loadedScope === scopedKey;
  const total = source === 'current' ? quantity : files.length * perFile;
  const estimated = unitCredits == null ? null : unitCredits * total;
  const baseDisplayEstimate = estimated != null && Number.isFinite(estimated) && estimated >= 0
    && Number.isInteger(total) && total > 0 && total <= STUDIO_BATCH_LIMITS.images
    ? Math.ceil(estimated) : null;
  const signature = JSON.stringify([scopedKey, source, quantity, perFile, unitCredits, draftSignature, files.map(local => [local.file.name, local.file.size, local.file.lastModified])]);
  const quoteSources: Array<{ name: string; assetId?: string }> = source === 'folder' && Number.isInteger(perFile) && perFile >= 1 && perFile <= 8
    ? files.flatMap(local => Array.from({ length: perFile }, (_, variant) => ({ name: `${local.file.name.replace(/\.[^.]+$/, '')}-v${variant + 1}`, ...(local.assetId ? { assetId: local.assetId } : {}) })))
    : source === 'current' && Number.isInteger(total) && total >= 1 && total <= STUDIO_BATCH_LIMITS.images
      ? Array.from({ length: total }, (_, index) => ({ name: `image-${index + 1}` })) : [];
  const quoteSignature = JSON.stringify([signature, quoteSources]);
  const quoteInputReady = quoteSources.length > 0 && quoteSources.length <= STUDIO_BATCH_LIMITS.images
    && (source !== 'folder' || quoteSources.every(item => item.assetId));
  const previousQuoteSignature = useRef(quoteSignature);
  const visibleQuote = billingQuote?.signature === quoteSignature
    && !billingQuote.expired && Date.parse(billingQuote.quote.expiresAt) > Date.now() ? billingQuote.quote : null;
  const displayEstimate = visibleQuote ? Math.ceil(visibleQuote.estimatedCredits) : actualQuoteRequired ? null : baseDisplayEstimate;
  const live = useRef({ scope: scopedKey, signature, mounted: true }); live.current = { scope: scopedKey, signature, mounted: live.current.mounted };
  const { confirm, productDialog } = useProductDialog();
  const automaticPayload = quotePayload ? JSON.stringify(quotePayload) : '';
  useEffect(() => {
    if (!actualQuoteRequired || !quoteVisible || mode !== 'batch' || !loaded || busy || previewing || pending || !automaticPayload
      || !quoteInputReady) return;
    if (billingQuote?.signature === quoteSignature && !billingQuote.expired && Date.parse(billingQuote.quote.expiresAt) > Date.now()) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      const requestId = crypto.randomUUID();
      const payload = { ...JSON.parse(automaticPayload), action: 'quote', count: 1, requestId, sources: JSON.parse(quoteSignature)[1] };
      void fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]) })
        .then(response => readBatchResponse(response)).then((quote: StudioBatchQuote) => {
          if (abort.signal.aborted || !Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0
            || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()
            || quote.billingMode === 'actual' && !quote.batchQuoteId) return;
          previousQuoteSignature.current = quoteSignature;
          setBillingQuote({ signature: quoteSignature, requestId, quote });
        }).catch(() => {});
    }, 500);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [actualQuoteRequired, quoteVisible, mode, loaded, busy, previewing, pending, automaticPayload, quoteSignature, quoteInputReady, billingQuote]);
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); }; }, []);
  useEffect(() => { if (previousQuoteSignature.current !== quoteSignature) setBillingQuote(null); previousQuoteSignature.current = quoteSignature; }, [quoteSignature]);
  useEffect(() => {
    if (!billingQuote?.quote.expiresAt) return;
    const delay = Date.parse(billingQuote.quote.expiresAt) - Date.now();
    if (delay <= 0) { setBillingQuote(current => current?.requestId === billingQuote.requestId ? { ...current, expired: true } : current); return; }
    const timer = window.setTimeout(() => setBillingQuote(current => current?.requestId === billingQuote.requestId ? { ...current, expired: true } : current), delay);
    return () => window.clearTimeout(timer);
  }, [billingQuote]);
  useUnsavedNavigation(busy || previewing || files.some(file => !file.assetId), confirm, { unsaved: files.some(file => !file.assetId) ? ['尚未上传的本机批量素材，离开后需重新选择'] : [], busy: busy ? ['批次素材或提交正在处理'] : previewing ? ['本机图片正在读取'] : [], revision: signature });
  useEffect(() => {
    fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); fileRef.current = []; setFiles([]); setSkipped([]); setFolderName(''); setError(''); setId(null); setPending(null); setBillingQuote(null);
    setMode('single'); setSource('folder'); setQuantity(8); setPerFile(1); setPack(false); setBusy(false); setPreviewing(false); setProgress('');
    try {
      const saved = JSON.parse(localStorage.getItem(scopedKey) || 'null');
      if (saved?.version === 1) {
        if (saved.mode === 'batch') setMode('batch');
        // Old text-batch preferences remain available, but do not silently enlarge a folder batch.
        if (saved.source === 'current') setSource('current');
        if (Number.isInteger(saved.quantity) && saved.quantity >= 1 && saved.quantity <= STUDIO_BATCH_LIMITS.images) setQuantity(saved.quantity);
        if (Number.isInteger(saved.perFile) && saved.perFile >= 1 && saved.perFile <= 8) setPerFile(saved.perFile);
        setPack(saved.pack === true);
        if (typeof saved.id === 'string' && /^[a-f0-9]{64}$/.test(saved.id)) setId(saved.id);
      }
      const request = localStorage.getItem(pendingKey);
      if (request && /^[a-zA-Z0-9-]{16,80}$/.test(request)) { setPending(request); setMode('batch'); }
    } catch { /* A broken cache never replays generation. */ }
    setLoadedScope(scopedKey);
  }, [scopedKey, pendingKey]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(scopedKey, JSON.stringify({ version: 1, mode, source, quantity, perFile, pack, id })); }
    catch { setError('批次设置无法在本机记住，已有批次可从我的批次找回'); }
  }, [loaded, scopedKey, mode, source, quantity, perFile, pack, id]);
  useEffect(() => { fileRef.current = files; }, [files]);
  async function previewFiles(selected: File[], label = '所选素材', initialSkipped: string[] = []) {
    if (lock.current || !selected.length) return;
    const scope = scopedKey;
    lock.current = true; setPreviewing(true); setError('');
    try {
      const result = await previewBatchFiles(selected, initialSkipped);
      if (!live.current.mounted || live.current.scope !== scope) { result.accepted.forEach(file => URL.revokeObjectURL(file.preview)); return; }
      if (!result.accepted.length) { setSkipped(result.skipped); throw new Error('没有可用图片，原素材选择保留'); }
      fileRef.current.forEach(file => URL.revokeObjectURL(file.preview));
      fileRef.current = result.accepted; setFiles(result.accepted); setSkipped(result.skipped); setFolderName(label);
    } catch (error) { if (live.current.mounted && live.current.scope === scope) setError(error instanceof Error ? error.message : '本机素材读取失败，尚未上传'); }
    finally { lock.current = false; if (live.current.mounted && live.current.scope === scope) setPreviewing(false); }
  }
  async function chooseSources() {
    if (!canSelectBatchDirectory()) { directoryInput.current?.click(); return; }
    const scope = scopedKey;
    try {
      const directory = await selectBatchDirectory('read');
      const selected = await readBatchDirectory(directory);
      if (live.current.mounted && live.current.scope === scope) await previewFiles(selected.files, directory.name, selected.skipped);
    } catch (error) { if (live.current.mounted && live.current.scope === scope && !(error instanceof DOMException && error.name === 'AbortError')) setError(error instanceof Error ? error.message : '素材目录权限失效或无法读取，请重新选择'); }
  }
  async function query() {
    if (!pending || lock.current) return;
    const scope = scopedKey;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await readBatchResponse(await fetch(`/api/image-studio/batches?requestId=${encodeURIComponent(pending)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }), true);
      if (!live.current.mounted || live.current.scope !== scope) return;
      setId(result.batch.id); setPending(null); localStorage.removeItem(pendingKey);
    } catch { if (live.current.mounted && live.current.scope === scope) setError('原提交尚未核对，不会自动再生成；请稍后查询或联系管理员'); }
    finally { lock.current = false; if (live.current.mounted && live.current.scope === scope) setBusy(false); }
  }
  async function submit(payload: Record<string, unknown>) {
    if (pending) { await query(); return false; }
    if (lock.current || !loaded) return false;
    if (!Number.isInteger(total) || total < 1 || total > STUDIO_BATCH_LIMITS.images || !Number.isInteger(perFile) || perFile < 1 || perFile > 8) { setError('本批总图数须为1至100张，请选择有效素材或调整次级数量设置'); return false; }
    if (estimated == null || !Number.isInteger(estimated) || estimated < 0 || estimated > 10000000) { setError('本批报价尚未就绪，请重新读取设置'); return false; }
    const scope = scopedKey, expected = signature, snapshot = JSON.parse(JSON.stringify(payload)), localFiles = [...files];
    const valid = () => live.current.mounted && live.current.scope === scope && live.current.signature === expected;
    lock.current = true; setBusy(true); setError('');
    let submittedRequest: string | null = null;
    try {
      const checkSettings = async () => {
        const current = await readBatchResponse(await fetch('/api/image-studio/settings', { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
        if (!valid() || current.revision !== snapshot.revision || current.prices?.[String(snapshot.model)] !== unitCredits) throw new Error('素材、模型或报价已变化，请重新读取设置后确认；尚未生成');
      };
      await checkSettings();
      if (!valid()) return false;
      const sources: Array<{ name: string; assetId?: string }> = [];
      if (source === 'folder') {
        for (let index = 0; index < localFiles.length; index++) {
          if (!valid()) throw new Error('已离开或切换本批，未继续上传或生成');
          const local = localFiles[index];
          if (!local.assetId) {
            const asset = await uploadFileAsAsset(local.file, { onProgress: progress => { if (valid()) setProgress(`上传素材 ${index + 1}/${localFiles.length} · ${progress.label}`); } });
            if (!asset.id) throw new Error('素材上传尚未确认，请重新核对');
            local.assetId = asset.id;
            if (!valid()) throw new Error('素材已保存，但原页面已变化；未提交生成');
            setFiles([...localFiles]);
          }
          for (let variant = 0; variant < perFile; variant++) sources.push({ name: `${local.file.name.replace(/\.[^.]+$/, '')}-v${variant + 1}`, assetId: local.assetId });
        }
      } else for (let index = 0; index < total; index++) sources.push({ name: `image-${index + 1}` });
      if (!valid()) throw new Error('当前设置已变化，未提交生成');
      await checkSettings();
      const quoteKey = JSON.stringify([expected, sources]);
      const priorQuote = billingQuote?.signature === quoteKey ? billingQuote : null;
      const requestId = priorQuote?.requestId || crypto.randomUUID();
      const quoteRequest = { ...snapshot, action: 'quote', requestId, count: 1, sources };
      const readQuote = async () => {
        const result = await readBatchResponse(await fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteRequest), signal: AbortSignal.timeout(120000) })) as StudioBatchQuote;
        if (!valid()) throw new Error('当前设置已变化，报价未用于生成');
        if (!['fixed', 'actual'].includes(result.billingMode) || !Number.isFinite(result.estimatedCredits) || result.estimatedCredits < 0
          || !Number.isFinite(result.unitCredits) || result.unitCredits < 0 || !result.expiresAt
          || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()
          || (result.batchQuoteId !== null && typeof result.batchQuoteId !== 'string')
          || (result.billingMode === 'actual' && !result.batchQuoteId)) throw new Error('本批报价信息不完整，尚未生成');
        return result;
      };
      let quote = priorQuote && !priorQuote.expired && Date.parse(priorQuote.quote.expiresAt) > Date.now() ? priorQuote.quote : await readQuote();
      previousQuoteSignature.current = quoteKey;
      setBillingQuote({ signature: quoteKey, requestId, quote });
      const quoteTotal = Math.ceil(quote.estimatedCredits);
      if (!Number.isSafeInteger(quoteTotal) || quoteTotal < 0 || quoteTotal > 10000000) throw new Error('本批报价超出可确认范围，尚未生成');
      const currentBalance = await readBatchResponse(await fetch('/api/me/credits', { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      if (!valid()) return false;
      if (quoteTotal > 0 && (!Number.isFinite(currentBalance.available) || currentBalance.available < quoteTotal)) throw new Error('可用点数不足，素材已上传但尚未生成');
      const model = IMAGE_STUDIO_MODEL_LABELS[String(snapshot.model) as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || String(snapshot.model);
      const quality = IMAGE_STUDIO_QUALITY_LABELS[String(snapshot.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || String(snapshot.quality || '默认');
      if (!await confirm(`${source === 'folder' ? localFiles.length + '张已上传素材' : '当前正文'} · 生成${total}张\n${model} · ${quality} · ${String(snapshot.resolution || '默认')} · ${String(snapshot.aspectRatio || '自动')}\n本批预计合计 ${quoteTotal} 点`, { title: '确认生成', confirmLabel: `确认生成 · ${quoteTotal}点`, anchor: null })) return false;
      if (!valid()) throw new Error('当前设置已变化，尚未生成，请重新确认');
      await checkSettings();
      let confirmedTotal = quoteTotal;
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        setProgress('报价已过期，正在重新获取本批报价');
        quote = await readQuote();
        setBillingQuote({ signature: quoteKey, requestId, quote });
        if (Math.ceil(quote.estimatedCredits) > confirmedTotal) {
          setError(`报价已更新为 ${Math.ceil(quote.estimatedCredits)} 点，本批尚未生成；请再次点击并确认新总额。`);
          return false;
        }
        const refreshedBalance = await readBatchResponse(await fetch('/api/me/credits', { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
        if (!valid()) return false;
        if (confirmedTotal > 0 && (!Number.isFinite(refreshedBalance.available) || refreshedBalance.available < confirmedTotal)) throw new Error('可用点数不足，素材已上传但尚未生成');
      }
      if (Date.parse(quote.expiresAt) <= Date.now()) {
        setBillingQuote(current => current?.requestId === requestId ? { ...current, expired: true } : current);
        setError('本批报价再次过期，尚未生成；请重新获取并确认报价。');
        return false;
      }
      localStorage.setItem(pendingKey, requestId);
      if (localStorage.getItem(pendingKey) !== requestId) throw new Error('提交编号未能保存，尚未提交生成');
      submittedRequest = requestId; setPending(requestId); setProgress('正在登记本批素材和设置');
      setBillingQuote(null);
      const response = await fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...snapshot, requestId, count: 1, budget: confirmedTotal, sources, ...(quote.batchQuoteId ? { batchQuoteId: quote.batchQuoteId } : {}) }), signal: AbortSignal.timeout(120000) });
      if (response.status >= 400 && response.status < 500) { localStorage.removeItem(pendingKey); submittedRequest = null; if (valid()) setPending(null); }
      const result = await readBatchResponse(response, true);
      localStorage.removeItem(pendingKey);
      if (!valid()) return false;
      watchGenerationCompletion(userId, result.batch.id, 'batch', total);
      setId(result.batch.id); setPending(null); return true;
    } catch (error) { if (valid()) { setError(error instanceof Error ? error.message : '批次提交结果未确认'); if (submittedRequest) setPending(submittedRequest); } return false; }
    finally { lock.current = false; if (live.current.mounted && live.current.scope === scope) { setBusy(false); setProgress(''); } }
  }
  const blocker = mode !== 'batch' ? '' : previewing ? '正在本机读取图片' : busy ? '正在处理本批' : pending ? '' : !loaded ? '正在恢复批次设置' : !Number.isInteger(total) || total < 1 || total > STUDIO_BATCH_LIMITS.images ? '请先选择有效素材，本批最多100张' : estimated == null ? '本批报价尚未就绪' : '';
  const controls = <div className={styles.controls}>
    <p>{displayEstimate != null ? `合计约 ${displayEstimate} 点数` : '费用待估算'}</p>
    <div className={styles.actions}>
      {source === 'folder' && <button type="button" disabled={busy || previewing || Boolean(pending)} onClick={() => void chooseSources()}><FolderOpen size={16} />{canSelectBatchDirectory() ? '选择素材文件夹' : '选择素材'}</button>}
      <label><input type="checkbox" checked={pack} disabled={busy} onChange={event => setPack(event.target.checked)} />完成后打包</label>
      {source === 'folder' && files.length > 0 && <span>{folderName} · {files.length}张素材{perFile > 1 ? ` · 共${total}张结果` : ''}</span>}
      <button type="button" title="其他批量设置" aria-expanded={advanced} disabled={busy || previewing || Boolean(pending)} onClick={() => setAdvanced(value => !value)}>其他设置</button>
    </div>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void previewFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <input ref={directoryInput} type="file" {...{ webkitdirectory: '', directory: '' }} multiple hidden onChange={event => { const files = Array.from(event.target.files || []); void previewFiles(files, (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath?.split('/')[0] || '所选素材'); event.target.value = ''; }} />
    {advanced && <div className={styles.fields}><label>批量来源<select value={source} disabled={busy || Boolean(pending)} onChange={event => setSource(event.target.value as 'current' | 'folder')}><option value="folder">素材逐图</option><option value="current">当前正文</option></select></label><label>{source === 'current' ? '本批结果数' : '每张素材结果数'}<input type="number" min={1} max={source === 'current' ? 100 : 8} step={1} value={source === 'current' ? quantity : perFile} disabled={busy || Boolean(pending)} onChange={event => source === 'current' ? setQuantity(Number(event.target.value)) : setPerFile(Number(event.target.value))} /></label>{source === 'folder' && <button type="button" disabled={busy || previewing || Boolean(pending)} onClick={() => fileInput.current?.click()}>选择多张图片</button>}<button type="button" title="重置本批设置" aria-label="重置本批设置" disabled={busy || Boolean(pending)} onClick={() => { setSource('folder'); setQuantity(8); setPerFile(1); setPack(false); fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); fileRef.current = []; setFiles([]); setSkipped([]); setFolderName(''); }}><RotateCcw size={16} /></button></div>}
    {!!skipped.length && <details><summary>跳过{skipped.length}项</summary>{skipped.map((reason, index) => <p key={index}>{reason}</p>)}</details>}
    {progress && <p role="status">{progress}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    {pending && <p>原提交待核对，不会重新生成。<button type="button" disabled={busy} onClick={() => void query()}><RefreshCw size={16} />查询原批次</button></p>}
    {productDialog}
  </div>;
  return { mode, setMode, source, busy, previewing, pending, blocker, submit, query, controls, id, pack, localPreviews: files.slice(0, 24).map(file => file.preview) };
}
