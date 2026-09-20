'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Settings, X, RefreshCw } from 'lucide-react';
import { uploadFileAsAsset, type UploadedAssetPayload } from '@/lib/http/file-upload';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import styles from './studio.module.css';

type SettingsValue = { context?: string; model: string; revision: number; contextConfigured?: boolean };
async function readResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw new Error(value.error || '请求失败，请重试');
  return value;
}

export default function ImageStudio({ isAdmin }: { isAdmin: boolean }) {
  const [settings, setSettings] = useState<SettingsValue | null>(null);
  const [draftContext, setDraftContext] = useState('');
  const [draftModel, setDraftModel] = useState('gpt-image-2.5-flare');
  const [saveStatus, setSaveStatus] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [images, setImages] = useState<UploadedAssetPayload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const uploadLock = useRef(false);
  const saving = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentDraft = useRef({ context: draftContext, model: draftModel });
  currentDraft.current = { context: draftContext, model: draftModel };
  const dirty = Boolean(settings && (draftContext !== (settings.context || '') || draftModel !== settings.model));

  function closeSettings() {
    if (dirty && !window.confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？')) return;
    dialog.current?.close();
  }

  const loadSettings = useCallback(async () => {
    setSettingsError('');
    try {
      const value: SettingsValue = await readResponse(await fetch('/api/image-studio/settings', { cache: 'no-store' }));
      setSettings(value); setDraftContext(value.context || ''); setDraftModel(value.model); setSaveStatus('');
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
      setSettings(value);
      setSaveStatus(currentDraft.current.context === snapshot.context && currentDraft.current.model === snapshot.model ? '已保存，下次生成生效' : '等待保存');
    } catch (e) { setSaveStatus('未保存'); setSettingsError(e instanceof Error ? e.message : '保存失败'); }
    finally { saving.current = false; }
  }, [settings, isAdmin]);

  useEffect(() => {
    if (!isAdmin || !dirty || settingsError) return;
    const timer = setTimeout(() => { void saveSettings(); }, 700);
    return () => clearTimeout(timer);
  }, [dirty, draftContext, draftModel, isAdmin, saveSettings, settingsError]);

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
    if (uploadLock.current || !files.length) return;
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
            <button type="button" className={styles.remove} disabled={uploading} onClick={() => setImages(current => current.filter((_, i) => i !== index))} title="移除参考图" aria-label={`移除参考图 ${index + 1}`}><X size={16} /></button>
          </div>)}
          {images.length < 2 && <button type="button" className={styles.add} disabled={uploading} onClick={() => fileInput.current?.click()}><ImagePlus size={24} />{uploading ? '上传中' : '添加图片'}</button>}
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => {
          void addImages(Array.from(event.target.files || [])); event.target.value = '';
        }} />
        <label className={styles.label} htmlFor="studio-prompt">画面描述</label>
        <textarea id="studio-prompt" value={prompt} maxLength={12000} onChange={event => setPrompt(event.target.value)} placeholder="描述想生成的画面" rows={9} />
        <label className={styles.label} htmlFor="studio-count">生成张数</label>
        <div className={styles.counts}>
          {[1, 2, 4, 8].map(n => <button type="button" key={n} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
          <input id="studio-count" type="number" min={1} max={8} step={1} value={count} onChange={event => setCount(Number(event.target.value))} />
        </div>
        <p className={styles.muted}>{settings?.model === 'gpt-image-2.5-sunburst' ? 'GPT Image 2.5 Sunburst' : 'GPT Image 2.5 Flare'}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button type="button" className={styles.generate} disabled>生成图片</button>
        <p className={styles.muted}>生成入口待积分规则确认后开放</p>
      </section>
      <section className={styles.outputs} aria-label="生成结果"><h2>生成结果</h2><div className={styles.empty}>暂无生成记录</div></section>
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
