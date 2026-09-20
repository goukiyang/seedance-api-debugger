'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, Settings, X, RefreshCw, LoaderCircle } from 'lucide-react';
import { uploadFileAsAsset, type UploadedAssetPayload } from '@/lib/http/file-upload';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import styles from './studio.module.css';

type SettingsValue = { context?: string; model: string; revision: number; contextConfigured?: boolean; providerReady: boolean; unitCredits: number | null; prices?: Record<string, number | null> };
type StudioTask = { id: string; batchId: string; ordinal: number; prompt: string; model: string; status: string; error?: string; unitCredits: number; referenceIds: string[]; createdAt: string; asset: { original_url: string } | null };
const models = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
async function readResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw new Error(value.error || '请求失败，请重试');
  return value;
}

export default function ImageStudio({ isAdmin, userId }: { isAdmin: boolean; userId: string }) {
  const [settings, setSettings] = useState<SettingsValue | null>(null);
  const [draftContext, setDraftContext] = useState('');
  const [draftModel, setDraftModel] = useState('gpt-image-2.5-flare');
  const [draftPrices, setDraftPrices] = useState<Record<string, number | null>>({ 'gpt-image-2.5-flare': null, 'gpt-image-2.5-sunburst': null });
  const [saveStatus, setSaveStatus] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [images, setImages] = useState<UploadedAssetPayload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<Record<string, unknown> | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);
  const submitLock = useRef(false);
  const listLock = useRef(false);
  const loadedMore = useRef(false);
  const uploadLock = useRef(false);
  const saving = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentDraft = useRef({ context: draftContext, model: draftModel, prices: draftPrices });
  currentDraft.current = { context: draftContext, model: draftModel, prices: draftPrices };
  const dirty = Boolean(isAdmin && settings && (draftContext !== (settings.context || '') || draftModel !== settings.model || JSON.stringify(draftPrices) !== JSON.stringify(settings.prices)));
  const draftKey = `sd2-image-studio-draft:${userId}`;
  const pendingKey = `sd2-image-studio-pending:${userId}`;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (saved) {
        if (typeof saved.prompt === 'string') setPrompt(saved.prompt.slice(0, 12000));
        if (Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 8) setCount(saved.count);
        if (Array.isArray(saved.images)) setImages(saved.images.filter((image: UploadedAssetPayload) => image && typeof image.id === 'string' && typeof image.originalUrl === 'string').slice(0, 2));
      }
      const pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (pending && typeof pending.requestId === 'string') setPendingSubmission(pending);
    } catch { /* A damaged local draft must not block the page. */ }
    setDraftLoaded(true);
  }, [draftKey, pendingKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ prompt, count, images })); } catch { /* Generation does not depend on browser storage. */ }
  }, [draftLoaded, draftKey, prompt, count, images]);

  function closeSettings() {
    if (dirty && !window.confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？')) return;
    dialog.current?.close();
  }

  const loadSettings = useCallback(async () => {
    setSettingsError('');
    try {
      const value: SettingsValue = await readResponse(await fetch('/api/image-studio/settings', { cache: 'no-store' }));
      setSettings(value); setDraftContext(value.context || ''); setDraftModel(value.model); if (value.prices) setDraftPrices(value.prices); setSaveStatus('');
    } catch (e) { setSettingsError(e instanceof Error ? e.message : '读取失败'); }
  }, []);
  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const saveSettings = useCallback(async () => {
    if (!settings || !isAdmin || saving.current) return;
    saving.current = true;
    const snapshot = { ...currentDraft.current, revision: settings.revision };
    setSaveStatus('正在保存'); setSettingsError('');
    try {
      const value: SettingsValue = await readResponse(await fetch('/api/image-studio/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
      }));
      setSettings({ ...settings, ...value, contextConfigured: Boolean(value.context?.trim()), unitCredits: value.prices?.[value.model] ?? null });
      setSaveStatus(JSON.stringify(currentDraft.current) === JSON.stringify({ context: snapshot.context, model: snapshot.model, prices: snapshot.prices }) ? '已保存，下次生成生效' : '等待保存');
    } catch (e) { setSaveStatus('未保存'); setSettingsError(e instanceof Error ? e.message : '保存失败'); }
    finally { saving.current = false; }
  }, [settings, isAdmin]);

  useEffect(() => {
    if (!isAdmin || !dirty || settingsError) return;
    const timer = setTimeout(() => { void saveSettings(); }, 700);
    return () => clearTimeout(timer);
  }, [dirty, draftContext, draftModel, draftPrices, isAdmin, saveSettings, settingsError]);

  const loadTasks = useCallback(async (cursor?: string) => {
    if (listLock.current) return;
    listLock.current = true;
    try {
      const result = await readResponse(await fetch(`/api/image-studio/tasks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' }));
      setTasks(current => {
        const fresh: StudioTask[] = result.tasks;
        const ids = new Set(fresh.map(task => task.id));
        return cursor ? [...current.filter(task => !ids.has(task.id)), ...fresh] : [...fresh, ...current.filter(task => !ids.has(task.id))];
      });
      if (cursor || !loadedMore.current) setNextCursor(result.nextCursor);
      if (cursor) loadedMore.current = true;
      setTasksError('');
    } catch (e) { setTasksError(e instanceof Error ? e.message : '读取记录失败'); }
    finally { listLock.current = false; setLoadingTasks(false); }
  }, []);
  useEffect(() => { void loadTasks(); }, [loadTasks]);
  const hasPending = tasks.some(task => task.status === 'queued' || task.status === 'running');
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void loadTasks(); }, hasPending ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [hasPending, loadTasks]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void loadTasks(); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [loadTasks]);
  useEffect(() => () => { if (downloadReady) URL.revokeObjectURL(downloadReady.url); }, [downloadReady]);

  async function submit(retryTask?: StudioTask) {
    if (!settings || submitLock.current) return;
    if (retryTask && !window.confirm(`将按当前设置重新生成 1 张，预计 ${settings.unitCredits ?? 0} 积分。确定继续吗？`)) return;
    const payload = pendingSubmission || { requestId: crypto.randomUUID(), prompt: retryTask?.prompt || prompt,
      count: retryTask ? 1 : count, revision: settings.revision, referenceIds: retryTask?.referenceIds || images.map(image => image.id) };
    try { sessionStorage.setItem(pendingKey, JSON.stringify(payload)); } catch { /* The in-memory request ID still prevents duplicate retries. */ }
    submitLock.current = true; setSubmitting(true); setError('');
    let ambiguous = true;
    try {
      const response = await fetch('/api/image-studio/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.status >= 400 && response.status < 500) { ambiguous = false; setPendingSubmission(null); try { sessionStorage.removeItem(pendingKey); } catch {} if (response.status === 409 && !dirty) await loadSettings(); await readResponse(response); }
      else { await readResponse(response); setPendingSubmission(null); try { sessionStorage.removeItem(pendingKey); } catch {} await loadTasks(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交结果未确认');
      // Reuse the exact request ID after ambiguous transport failures.
      setPendingSubmission(ambiguous ? payload : null);
    } finally { submitLock.current = false; setSubmitting(false); }
  }

  async function download(ids: string[]) {
    if (downloadBusy) return;
    setDownloadBusy(true); setError(''); setDownloadReady(null);
    try {
      const query = new URLSearchParams(); ids.forEach(id => query.append('id', id));
      const response = await fetch(`/api/image-studio/download?${query}`);
      if (!response.ok) { await readResponse(response); return; }
      const expectedType = ids.length === 1 ? 'image/png' : 'application/zip';
      if (!response.headers.get('content-type')?.startsWith(expectedType)) throw new Error('下载未返回图片，请重新登录后重试');
      const blob = await response.blob();
      if (!blob.size) throw new Error('下载文件为空，请重试');
      const url = URL.createObjectURL(blob);
      const name = ids.length === 1 ? 'generated-image.png' : 'generated-images.zip';
      setDownloadReady({ url, name });
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } catch (e) { setError(e instanceof Error ? e.message : '下载失败，请重试'); }
    finally { setDownloadBusy(false); }
  }
  const ready = Boolean(settings?.providerReady && settings.contextConfigured && settings.unitCredits !== null && !dirty && !settingsError);

  useEffect(() => {
    if (!isAdmin || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const guardNavigation = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return;
      if (link.href === window.location.href || link.hash && link.pathname === window.location.pathname) return;
      if (!window.confirm('上下文尚未保存，离开后将丢失这次修改。确定离开吗？')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', guardNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', guardNavigation, true);
    };
  }, [dirty, isAdmin]);

  async function addImages(files: File[]) {
    if (uploadLock.current || submitting || pendingSubmission || !files.length) return;
    if (files.length + images.length > 2) { setError('最多选择两张参考图'); return; }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)) {
      setError('请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    uploadLock.current = true; setUploading(true); setError('');
    try {
      for (const file of files) {
        const asset = await uploadFileAsAsset(file);
        if (!asset.id || !asset.originalUrl) throw new Error('上传结果不完整，请重试');
        setImages(current => [...current, asset]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { uploadLock.current = false; setUploading(false); }
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <h1>图片生成</h1>
      {isAdmin && <button type="button" onClick={() => dialog.current?.showModal()}><Settings size={17} />上下文设置</button>}
    </header>
    <div className={styles.workspace}>
      <section className={styles.inputs} aria-label="生成参数" onPaste={event => {
        const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
        if (files.length) { event.preventDefault(); void addImages(files); }
      }}>
        <label className={styles.label}>参考图片 <span>选填 · {images.length}/2</span></label>
        <div className={styles.references} onDragOver={event => event.preventDefault()} onDrop={event => {
          event.preventDefault(); void addImages(Array.from(event.dataTransfer.files));
        }}>
          {images.map((asset, index) => <div key={`${asset.id}-${index}`} className={styles.reference}>
            <button type="button" className={styles.preview} onClick={() => setPreview(asset.originalUrl || null)} aria-label={`预览参考图 ${index + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={asset.originalUrl || ''} alt={`参考图 ${index + 1}`} />
            </button>
            <button type="button" className={styles.remove} disabled={uploading || submitting || Boolean(pendingSubmission)} onClick={() => setImages(current => current.filter((_, i) => i !== index))} title="移除参考图" aria-label={`移除参考图 ${index + 1}`}><X size={16} /></button>
          </div>)}
          {images.length < 2 && <button type="button" className={styles.add} disabled={uploading || submitting || Boolean(pendingSubmission)} onClick={() => fileInput.current?.click()}><ImagePlus size={24} />{uploading ? '上传中' : '添加图片'}</button>}
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => {
          void addImages(Array.from(event.target.files || [])); event.target.value = '';
        }} />
        <label className={styles.label} htmlFor="studio-prompt">画面描述</label>
        <textarea id="studio-prompt" disabled={submitting || Boolean(pendingSubmission)} value={prompt} maxLength={12000} onChange={event => setPrompt(event.target.value)} placeholder="描述想生成的画面" rows={9} />
        <label className={styles.label} htmlFor="studio-count">生成张数</label>
        <div className={styles.counts}>
          {[1, 2, 4, 8].map(n => <button type="button" disabled={submitting || Boolean(pendingSubmission)} key={n} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
          <input id="studio-count" disabled={submitting || Boolean(pendingSubmission)} type="number" min={1} max={8} step={1} value={count} onChange={event => setCount(Number(event.target.value))} />
        </div>
        <p className={styles.muted}>{settings?.model === 'gpt-image-2.5-sunburst' ? 'GPT Image 2.5 Sunburst' : 'GPT Image 2.5 Flare'}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <p className={styles.muted}>{settings?.unitCredits == null ? '积分单价尚未设置' : `每张 ${settings.unitCredits} 积分 · 本次 ${settings.unitCredits * (Number.isInteger(count) ? count : 0)} 积分`}</p>
        <button type="button" className={styles.generate} disabled={submitting || uploading || (!pendingSubmission && (!ready || !prompt.trim() || !Number.isInteger(count) || count < 1 || count > 8))} onClick={() => void submit()}>{submitting ? '正在提交' : pendingSubmission ? '重试提交' : '生成图片'}</button>
        {pendingSubmission && <p className={styles.muted}>将核对刚才的提交，不会重复创建同一批任务。<button type="button" disabled={submitting} onClick={() => {
          if (window.confirm('上次提交可能已成功，请先查看生成记录。确定放弃核对并开始新任务吗？')) { setPendingSubmission(null); try { sessionStorage.removeItem(pendingKey); } catch {} }
        }}>放弃核对</button></p>}
        {!ready && <p className={styles.muted}>{dirty ? '等待设置保存完成' : !settings?.providerReady ? '图片服务尚未就绪' : '请管理员先完成上下文和积分设置'}</p>}
      </section>
      <section className={styles.outputs} aria-label="生成结果">
        <header className={styles.header}><h2>生成结果</h2><div className={styles.counts}>
          {selected.length > 0 && <button type="button" disabled={downloadBusy} onClick={() => void download(selected)}><Download size={16} />{downloadBusy ? '准备下载中' : `下载 ${selected.length} 张`}</button>}
          <button type="button" title="刷新记录" aria-label="刷新记录" onClick={() => void loadTasks()}><RefreshCw size={16} /></button>
        </div></header>
        {tasksError && <p role="alert" className={styles.error}>{tasksError}</p>}
        {downloadReady && <p role="status">文件已准备好。<a href={downloadReady.url} download={downloadReady.name}>再次保存</a></p>}
        {loadingTasks && <p role="status">正在读取生成记录…</p>}
        {!loadingTasks && !tasks.length && !tasksError && <div className={styles.empty}>暂无生成记录</div>}
        <div className={styles.grid}>{tasks.map(task => <article key={task.id} className={styles.result}>
          <div className={styles.resultMedia}>{task.asset ? <>
            <button type="button" className={styles.preview} aria-label="预览生成图片" onClick={() => setPreview(task.asset!.original_url)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={task.asset.original_url} alt={task.prompt} loading="lazy" />
            </button>
            <input className={styles.select} type="checkbox" aria-label={`选择第 ${task.ordinal} 张图片`} checked={selected.includes(task.id)} onChange={event => {
              if (event.target.checked && selected.length >= 8) { setError('每次最多下载 8 张'); return; }
              setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id));
            }} />
          </> : <div className={styles.taskState}>{['queued', 'running'].includes(task.status) && <LoaderCircle className={styles.spinner} size={24} />}
            {task.status === 'queued' ? '等待生成' : task.status === 'running' ? '正在生成' : task.status === 'succeeded' ? '图片已移除' : '未能交付图片'}</div>}</div>
          <p className={styles.prompt} title={task.prompt}>{task.prompt}</p>
          <div className={styles.resultActions}><span className={styles.muted}>{new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            {task.asset && <button type="button" disabled={downloadBusy} onClick={() => void download([task.id])}><Download size={15} />下载</button>}
            {['failed', 'uncertain'].includes(task.status) && <button type="button" disabled={!ready || submitting || Boolean(pendingSubmission)} onClick={() => void submit(task)}><RefreshCw size={15} />重新生成</button>}
          </div>{task.error && <p className={styles.error}>{task.error}</p>}
        </article>)}</div>
        {nextCursor && <button type="button" onClick={() => void loadTasks(nextCursor)}>加载更多</button>}
      </section>
    </div>
    {isAdmin && <dialog ref={dialog} className={styles.dialog} onCancel={event => { event.preventDefault(); closeSettings(); }}>
      <header className={styles.header}><h2>上下文设置</h2><button type="button" title="关闭" aria-label="关闭设置" onClick={() => {
        closeSettings();
      }}><X size={20} /></button></header>
      {settings && <>
        <label className={styles.label} htmlFor="studio-model">模型</label>
        <select id="studio-model" value={draftModel} onChange={event => setDraftModel(event.target.value)}>
          <option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option>
          <option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option>
        </select>
        <label className={styles.label} htmlFor="studio-context">固定上下文</label>
        <textarea id="studio-context" rows={12} maxLength={20000} value={draftContext} onChange={event => setDraftContext(event.target.value)} />
        <p className={styles.muted}>适用于所有用户的新生成任务；正在执行的任务不受影响。</p>
        {models.map(model => <label className={styles.label} key={model}>{model.endsWith('flare') ? 'Flare' : 'Sunburst'} 每张积分
          <input type="number" min={0} max={100000} step={1} placeholder="未设置" value={draftPrices[model] ?? ''} onChange={event => {
            const next = event.target.value === '' ? null : Number(event.target.value);
            setDraftPrices(current => ({ ...current, [model]: next }));
          }} />
        </label>)}
        <p className={styles.muted}>0 表示不扣站内积分，上游接口仍可能产生费用。</p>
        <p role="status">{saveStatus || '修改后自动保存'}</p>
      </>}
      {settingsError && <div role="alert" className={styles.error}>{settingsError}<button type="button" onClick={() => { if (settings) void saveSettings(); else void loadSettings(); }}><RefreshCw size={16} />重试</button>
        {settings && <button type="button" onClick={() => {
          if (!dirty || window.confirm('重新读取会替换当前未保存的上下文，确定继续吗？')) void loadSettings();
        }}>重新读取</button>}
      </div>}
    </dialog>}
    {!settings && settingsError && <p role="alert" className={styles.error}>{settingsError}<button onClick={() => void loadSettings()}>重试</button></p>}
    {preview && <ZoomableImagePreview src={preview} alt="参考图片" onClose={() => setPreview(null)} />}
  </main>;
}
