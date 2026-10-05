'use client';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useProductDialog } from '@/components/useProductDialog';
import { STUDIO_BATCH_LIMITS } from '@/lib/image-studio/batch-contract';
import { BatchResults, readBatchResponse } from './batch-results';
import { canSelectBatchDirectory, selectBatchDirectory, readBatchDirectory, previewBatchFiles, type BatchDirectoryHandle, type BatchLocalFile } from './batch-files';
import styles from './batch.module.css';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';

export function useStudioBatch({ userId, moduleId, unitCredits }: { userId: string; moduleId: string; unitCredits: number | null }) {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [source, setSource] = useState<'current' | 'folder'>('current');
  const [quantity, setQuantity] = useState(8), [perFile, setPerFile] = useState(1), [budget, setBudget] = useState('');
  const [files, setFiles] = useState<BatchLocalFile[]>([]), [skipped, setSkipped] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('');
  const [id, setId] = useState<string | null>(null), [pending, setPending] = useState<string | null>(null), [outputDirectory, setOutputDirectory] = useState<BatchDirectoryHandle | null>(null);
  const [loaded, setLoaded] = useState(false), [showResults, setShowResults] = useState(false);
  const [smallScreen, setSmallScreen] = useState(false);
  useEffect(() => { const media = matchMedia('(max-width: 640px)'); const update = () => setSmallScreen(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null), lock = useRef(false), fileRef = useRef<BatchLocalFile[]>([]);
  const scopedKey = `sd2-studio-batch-draft:v1:${userId}:${moduleId}`;
  const pendingKey = `${scopedKey}:request`;
  const { confirm } = useProductDialog();
  const total = source === 'current' ? quantity : files.length * perFile;
  const estimated = unitCredits == null ? null : unitCredits * total;
  useUnsavedNavigation(busy || previewing || files.some(file => !file.assetId), confirm, { unsaved: files.some(file => !file.assetId) ? ['尚未上传的本机批量素材，离开后需重新选择'] : [], busy: busy ? ['批次素材或提交正在处理'] : previewing ? ['本机图片正在读取'] : [], revision: `${source}:${files.length}:${busy}` });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(scopedKey) || 'null');
      if (saved?.version === 1) {
        if (saved.mode === 'batch') setMode('batch');
        if (saved.source === 'folder') setSource('folder');
        if (Number.isInteger(saved.quantity) && saved.quantity >= 1 && saved.quantity <= STUDIO_BATCH_LIMITS.images) setQuantity(saved.quantity);
        if (Number.isInteger(saved.perFile) && saved.perFile >= 1 && saved.perFile <= 8) setPerFile(saved.perFile);
        if (typeof saved.budget === 'string' && /^\d{0,8}$/.test(saved.budget)) setBudget(saved.budget);
        if (typeof saved.id === 'string' && /^[a-f0-9]{64}$/.test(saved.id)) { setId(saved.id); setShowResults(saved.showResults === true); }
      }
      const request = localStorage.getItem(pendingKey);
      if (request && /^[a-zA-Z0-9-]{16,80}$/.test(request)) { setPending(request); setMode('batch'); }
    } catch { /* Broken cache never replays generation. */ }
    setLoaded(true);
  }, [scopedKey, pendingKey]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(scopedKey, JSON.stringify({ version: 1, mode, source, quantity, perFile, budget, id, showResults })); }
    catch { setError('批次设置无法在本机记住，已有服务端批次仍可从我的批次找回'); }
  }, [loaded, scopedKey, mode, source, quantity, perFile, budget, id, showResults]);
  useEffect(() => { fileRef.current = files; }, [files]);
  useEffect(() => () => fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)), []);
  async function previewFiles(selected: File[], initialSkipped: string[] = []) {
    if (lock.current) return;
    lock.current = true; setPreviewing(true); setError('');
    try {
      const result = await previewBatchFiles(selected, initialSkipped);
      fileRef.current.forEach(file => URL.revokeObjectURL(file.preview));
      setFiles(result.accepted); setSkipped(result.skipped);
    } catch { setError('本机素材读取失败，尚未上传，请重新选择'); }
    finally { lock.current = false; setPreviewing(false); }
  }
  async function chooseSources() {
    if (!canSelectBatchDirectory()) { directoryInput.current?.click(); return; }
    try {
      const directory = await selectBatchDirectory('read');
      const selected = await readBatchDirectory(directory); await previewFiles(selected.files, selected.skipped);
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setError('素材目录权限失效或无法读取，请重新选择'); }
  }
  async function chooseOutput() {
    try { setOutputDirectory(await selectBatchDirectory('readwrite')); setError(''); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setError('无法获得保存目录权限，请重选或使用 ZIP'); }
  }
  async function query() {
    if (!pending || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await readBatchResponse(await fetch(`/api/image-studio/batches?requestId=${encodeURIComponent(pending)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      setId(result.batch.id); setShowResults(true); setPending(null); localStorage.removeItem(pendingKey);
    } catch { setError('原提交尚未核对，不能确认是否受理。请稍后查询或联系管理员，不会自动再生成'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function submit(payload: Record<string, unknown>) {
    if (pending) { await query(); return; }
    if (lock.current || !loaded) return;
    if (!Number.isInteger(total) || total < 1 || total > STUDIO_BATCH_LIMITS.images || !Number.isInteger(perFile) || perFile < 1 || perFile > 8) { setError('本批总图数须为 1 至 100 张，每张素材最多生成 8 张'); return; }
    if (estimated == null || budget === '' || !Number.isInteger(Number(budget)) || Number(budget) < estimated || Number(budget) > 10000000) { setError('请填写不少于预计点数的最高预算'); return; }
    lock.current = true; setBusy(true); setError('');
    let submittedRequest: string | null = null;
    try {
      const sources: Array<{ name: string; assetId?: string }> = [];
      if (source === 'folder') {
        for (let index = 0; index < files.length; index++) {
          const local = files[index]; setProgress(`准备素材 ${index + 1}/${files.length}，开始后才上传`);
          if (!local.assetId) {
            const asset = await uploadFileAsAsset(local.file, { onProgress: progress => setProgress(`上传 ${index + 1}/${files.length} · ${local.file.name} · ${progress.label}`) });
            if (!asset.id) throw new Error('素材上传尚未确认，请重新核对');
            local.assetId = asset.id; setFiles([...files]);
          }
          for (let variant = 0; variant < perFile; variant++) sources.push({ name: `${local.file.name.replace(/\.[^.]+$/, '')}-v${variant + 1}`, assetId: local.assetId });
        }
      } else for (let index = 0; index < total; index++) sources.push({ name: `image-${index + 1}` });
      const requestId = crypto.randomUUID();
      localStorage.setItem(pendingKey, requestId);
      if (localStorage.getItem(pendingKey) !== requestId) throw new Error('提交编号未能保存，尚未提交生成');
      submittedRequest = requestId; setPending(requestId); setProgress('正在持久登记本批素材和设置');
      const response = await fetch('/api/image-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId, count: 1, budget: Number(budget), sources }), signal: AbortSignal.timeout(120000) });
      if (response.status >= 400 && response.status < 500) { setPending(null); localStorage.removeItem(pendingKey); submittedRequest = null; }
      const result = await readBatchResponse(response);
      watchGenerationCompletion(userId, result.batch.id, 'batch', total);
      setId(result.batch.id); setShowResults(true); setPending(null); localStorage.removeItem(pendingKey);
    } catch (error) { setError(error instanceof Error ? error.message : '批次提交结果未确认'); if (submittedRequest) setPending(submittedRequest); }
    finally { lock.current = false; setBusy(false); setProgress(''); }
  }
  const blocker = mode !== 'batch' ? '' : previewing ? '正在本机读取图片' : busy ? '正在处理本批' : pending ? '' : !loaded ? '正在恢复批次设置' : !Number.isInteger(total) || total < 1 || total > STUDIO_BATCH_LIMITS.images ? '请设置 1 至 100 张图片，素材模式需先选择有效图片' : budget === '' || estimated == null || !Number.isInteger(Number(budget)) || Number(budget) < estimated ? '请填写不少于预计点数的最高预算' : '';
  const controls = <div className={styles.controls}>
    <div className={styles.actions} role="group" aria-label="批量来源"><button type="button" aria-pressed={source === 'current'} disabled={busy || Boolean(pending)} onClick={() => setSource('current')}>当前正文</button><button type="button" aria-pressed={source === 'folder'} disabled={busy || Boolean(pending)} onClick={() => setSource('folder')}>素材逐图</button></div>
    {source === 'folder' && <>
      <div className={styles.actions}><button type="button" disabled={busy || previewing || Boolean(pending)} onClick={() => void chooseSources()}><FolderOpen size={16} />选择素材文件夹</button><button type="button" disabled={busy || previewing || Boolean(pending)} onClick={() => fileInput.current?.click()}>选择图片</button><span>有效素材 {files.length} 张，选择时只在本机预览</span></div>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void previewFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <input ref={directoryInput} type="file" {...{ webkitdirectory: '', directory: '' }} multiple hidden onChange={event => { void previewFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <div onPaste={event => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); void previewFiles(pasted); } }} tabIndex={0} aria-label="批量素材，可粘贴图片">
        {!!files.length && <div className={styles.previews}>{files.map((local, index) => <figure key={`${index}:${local.file.name}`}><img src={local.preview} alt={local.file.name} /><figcaption>{local.file.name}</figcaption></figure>)}</div>}
      </div>
      {!!skipped.length && <details><summary>跳过 {skipped.length} 项</summary>{skipped.map((reason, index) => <p key={index}>{reason}</p>)}</details>}
      <p>点击开始才上传有效素材。只读取当前层，不监控新文件；重开网页后需重选尚未上传素材。</p>
    </>}
    <div className={styles.fields}><label>{source === 'current' ? '本批总图数' : '每张素材生成数'}<input type="number" min={1} max={source === 'current' ? 100 : 8} step={1} value={source === 'current' ? quantity : perFile} disabled={busy || Boolean(pending)} onChange={event => source === 'current' ? setQuantity(Number(event.target.value)) : setPerFile(Number(event.target.value))} /></label><label>最高预算（点）<input type="number" min={estimated ?? 0} max={10000000} step={1} value={budget} disabled={busy || Boolean(pending)} onChange={event => setBudget(event.target.value)} /></label></div>
    <p>{source === 'folder' ? `${files.length} 张素材 × ${perFile} = ` : ''}本批 {total} 张 · 单图 {unitCredits ?? '待配置'} 点 · 预计 {estimated ?? '待配置'} 点。四宫格和演化多档组合图各算 1 张。</p>
    <div className={styles.actions}>{canSelectBatchDirectory() && <button type="button" disabled={busy} onClick={() => void chooseOutput()}><FolderOpen size={16} />{outputDirectory ? '已选结果保存位置' : '选择结果保存位置'}</button>}<span>{outputDirectory ? '保存在新批次子目录；页面打开且权限有效时可保存' : '结果通过 ZIP 保存，可在结果区选择目录'}</span></div>
    <p>后台仅继续素材已准备并登记的条目。预算不足或价格变化停止新派发，与普通任务共享最多 8 张在途。</p>
    {progress && <p role="status">{progress}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    {id && <button type="button" onClick={() => setShowResults(value => !value)}>{showResults ? '收起本批结果' : '查看本批结果'}</button>}
    {smallScreen && showResults && id && <BatchResults key={`${userId}:${id}`} userId={userId} id={id} outputDirectory={outputDirectory} compact />}
    {pending && <p>原提交待核对，只查询同一批次，不会重新生成。<button type="button" disabled={busy} onClick={() => void query()}><RefreshCw size={16} />查询原批次</button></p>}
    <button type="button" disabled={busy || Boolean(pending)} onClick={() => { setSource('current'); setQuantity(8); setPerFile(1); setBudget(''); fileRef.current.forEach(file => URL.revokeObjectURL(file.preview)); setFiles([]); setSkipped([]); setOutputDirectory(null); }}><X size={16} />重置本批参数</button>
  </div>;
  return { mode, setMode, source, busy, previewing, pending, blocker, submit, query, controls, id, outputDirectory, inlineResults: smallScreen && showResults && mode === 'batch', showResults: () => setShowResults(true) };
}
