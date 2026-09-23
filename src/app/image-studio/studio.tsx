'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Download, ImagePlus, Settings, X, RefreshCw, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { uploadFileAsAsset, type UploadedAssetPayload } from '@/lib/http/file-upload';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import styles from './studio.module.css';
import { RatioPicker } from './ratio-picker';
import { normalizeStudioRatio } from '@/lib/image-studio/ratios';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_QUALITY_LABELS, defaultImageStudioQuality, normalizeImageStudioQuality } from '@/lib/image-studio/model-catalog';

type SettingsValue = { context?: string; revision: number; contextConfigured?: boolean; providerReady: boolean; prices: Record<string, number | null> };
type StudioSnapshot = { prompt: string; model: string; quality?: string; count: number; aspectRatio: string; outputSize?: string | null; unitCredits?: number | null; sourceAvailable?: boolean; referenceImages: UploadedAssetPayload[] };
type StudioTask = { id: string; batchId: string; ordinal: number; prompt: string; model: string; quality?: string; status: string; error?: string; unitCredits: number; referenceIds: string[]; aspectRatio: string; outputSize?: string; createdAt: string; snapshot?: StudioSnapshot; asset: { id?: string; original_url: string; width?: number; height?: number } | null };
type StudioModule = { id: string; name: string; prompt: string; context?: string; contextConfigured: boolean; count: number; referenceLimit: number; aspectRatio: string; model: string; quality: string; groupName: string; banner: UploadedAssetPayload | null; prices: Record<string, number | null>; unitCredits: number | null; reproduceFromTaskId: string | null; images: UploadedAssetPayload[]; revision: number; saved: boolean; createdAt: string };
type StudioPreset = { id: string; name: string; scope: 'admin' | 'creator'; groupName: string; model: string; quality: string; count: number; referenceLimit: number; aspectRatio: string; images: UploadedAssetPayload[]; banner: UploadedAssetPayload | null; contextConfigured: boolean; createdAt: string };
type RatioPreferences = { custom: string[]; busy: boolean; error: string; onRetry: () => void; onCustom: (ratio: string, remove: boolean) => Promise<boolean> };
const models = IMAGE_STUDIO_MODELS;
const DEFAULT_GROUPS = ['未分组', '常用', '角色', '场景', '海报'];
async function readResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw new Error(value.error || '请求失败，请重试');
  return value;
}

export default function ImageStudio({ isAdmin, userId }: { isAdmin: boolean; userId: string }) {
  const [modules, setModules] = useState<StudioModule[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [coverView, setCoverView] = useState(false);
  const [settings, setSettings] = useState<SettingsValue | null>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [settingsReload, setSettingsReload] = useState(0);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError] = useState('');
  const presetDialog = useRef<HTMLDialogElement>(null);
  const presetApplyLock = useRef(false);
  const [presetApplying, setPresetApplying] = useState(false);
  useEffect(() => { if (presetDialogOpen) presetDialog.current?.showModal(); else presetDialog.current?.close(); }, [presetDialogOpen]);
  const [customRatios, setCustomRatios] = useState<string[]>([]);
  const [ratiosBusy, setRatiosBusy] = useState(false);
  const [ratiosError, setRatiosError] = useState('');
  const ratiosLock = useRef(false);
  async function syncRatios(ratio?: string, remove = false) {
    if (ratiosLock.current) return false;
    ratiosLock.current = true; setRatiosBusy(true); setRatiosError('');
    try {
      const result = await readResponse(await fetch('/api/image-studio/ratios', ratio ? { method: remove ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratio }) } : { cache: 'no-store' }));
      setCustomRatios(result.ratios); return true;
    } catch (e) { setRatiosError(e instanceof Error ? e.message : '比例未保存'); return false; }
    finally { ratiosLock.current = false; setRatiosBusy(false); }
  }
  useEffect(() => { void syncRatios(); }, []);
  const createId = useRef<string | null>(null);
  const createLock = useRef(false);
  const listLock = useRef(false);
  const loadModules = useCallback(async (next?: string) => {
    if (listLock.current) return;
    listLock.current = true; setLoading(true); setError('');
    try {
      const data = await readResponse(await fetch(`/api/image-studio/modules${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' }));
      setModules(current => {
        const ids = new Set(current.map(item => item.id));
        return [...current, ...data.modules.filter((item: StudioModule) => !ids.has(item.id))]
          .sort((a, b) => Number(b.id === `default-${userId}`) - Number(a.id === `default-${userId}`)
            || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
      });
      setCursor(data.nextCursor); setActive(current => current || data.modules[0]?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : '模块读取失败'); }
    finally { listLock.current = false; setLoading(false); }
  }, [userId]);
  useEffect(() => { void loadModules(); }, [loadModules]);
  async function createModule() {
    if (createLock.current) return;
    createLock.current = true; setCreating(true); setError('');
    createId.current ||= crypto.randomUUID();
    try {
      const workspace: StudioModule = await readResponse(await fetch('/api/image-studio/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: createId.current }) }));
      setModules(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
      setSelectedGroup(workspace.groupName || '未分组'); setActive(workspace.id); createId.current = null;
      requestAnimationFrame(() => document.getElementById(`module-${workspace.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (e) { setError(e instanceof Error ? e.message : '新建失败'); }
    finally { createLock.current = false; setCreating(false); }
  }
  async function openPresetLibrary() {
    setPresetDialogOpen(true); setPresetsLoading(true); setPresetsError('');
    try { const result = await readResponse(await fetch('/api/image-studio/presets', { cache: 'no-store' })); setPresets(result.presets); }
    catch (e) { setPresetsError(e instanceof Error ? e.message : '模板读取失败'); }
    finally { setPresetsLoading(false); }
  }
  async function applyPreset(preset: StudioPreset) {
    if (presetApplyLock.current) return;
    presetApplyLock.current = true; setPresetApplying(true); setPresetsError('');
    try {
      const created: StudioModule = await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', presetId: preset.id }) }));
      setModules(current => [created, ...current.filter(item => item.id !== created.id)]); setSelectedGroup(created.groupName || '未分组'); setActive(created.id); setPresetDialogOpen(false);
      requestAnimationFrame(() => document.getElementById(`module-${created.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (e) { setPresetsError(e instanceof Error ? e.message : '应用模板失败'); }
    finally { presetApplyLock.current = false; setPresetApplying(false); }
  }
  const groupedModules = useMemo(() => modules.reduce<Record<string, StudioModule[]>>((groups, item) => {
    const group = item.groupName || '未分组';
    (groups[group] ||= []).push(item);
    return groups;
  }, {}), [modules]);
  const groups = useMemo(() => Array.from(new Set([...DEFAULT_GROUPS, ...modules.map(item => item.groupName).filter(Boolean)])), [modules]);
  const visibleModules = useMemo(() => selectedGroup ? modules.filter(item => item.groupName === selectedGroup) : modules, [modules, selectedGroup]);
  useEffect(() => {
    if (!groups.length) return;
    const availableGroups = Object.keys(groupedModules);
    setSelectedGroup(current => current && availableGroups.includes(current) ? current : availableGroups[0] || groups[0]);
  }, [groups, groupedModules]);
  async function deleteGroup(group: string) {
    if (DEFAULT_GROUPS.includes(group)) return;
    const targets = modules.filter(item => item.groupName === group);
    if (!targets.length || !window.confirm(`删除分组“${group}”？其中的模块会移到“未分组”，图片和生成结果不会删除。`)) return;
    try {
      const replacements: StudioModule[] = [];
      for (const item of targets) {
        replacements.push(await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          id: item.id, revision: item.revision, name: item.name, prompt: item.prompt, context: item.context || '', count: item.count, referenceLimit: item.referenceLimit,
          aspectRatio: item.aspectRatio, model: item.model, quality: item.quality, groupName: '未分组', bannerAssetId: item.banner?.id || null,
          referenceIds: item.images.map(image => image.id), reproduceFromTaskId: item.reproduceFromTaskId || null,
        }) })));
      }
      const replacementById = new Map(replacements.map(item => [item.id, item]));
      setModules(current => current.map(item => replacementById.get(item.id) || item));
      setSelectedGroup('未分组');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除分组失败，请重试');
      void loadModules();
    }
  }
  return <main className={styles.page}>
    <aside className={styles.moduleRail} aria-label="分组快捷栏">
      <div className={styles.moduleRailTitle}>分组快捷栏</div>
      {Object.entries(groupedModules).map(([group, items]) => <div key={group} className={styles.moduleRailGroup}>
        <button type="button" className={selectedGroup === group ? styles.moduleRailActive : ''} aria-current={selectedGroup === group ? 'page' : undefined} onClick={() => {
          setCoverView(false); setSelectedGroup(group); setActive(items[0]?.id || '');
        }}><span>{group}</span><small>{items.length}</small></button>
        <div className={styles.moduleRailChildren}>{items.map(item => <button key={item.id} type="button" className={styles.moduleRailChild} onClick={() => {
          setCoverView(false); setSelectedGroup(group); setActive(item.id); requestAnimationFrame(() => document.getElementById(`module-${item.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        }}>{item.name}</button>)}</div>
      </div>)}
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-current={coverView ? 'page' : undefined} onClick={() => setCoverView(true)}>全部封面<small>{modules.length}</small></button>
    </aside>
    <div className={styles.content}>
    <header className={styles.header}><div><h1>{coverView ? '模板封面' : '图片生成'}</h1><p className={styles.muted}>{coverView ? '所有模板的 3:4 封面预览' : `当前分组：${selectedGroup || '未分组'}`}</p></div><div className={styles.counts}>
      <button type="button" onClick={() => void openPresetLibrary()}>模板库</button>
      {isAdmin && <button type="button" disabled={!settings} onClick={() => setGlobalSettingsOpen(true)}><Settings size={17} />通用上下文</button>}
      <button type="button" disabled={creating || !modules.length} onClick={() => void createModule()}><Plus size={17} />{creating ? '新建中' : '新建模块'}</button></div></header>
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => void loadModules(cursor || undefined)}>重试读取</button></p>}
    {coverView ? <section className={styles.coverGrid} aria-label="模板封面"><div className={styles.coverGridInner}>{modules.map(module => {
      const cover = module.banner?.originalUrl || module.images[0]?.originalUrl;
      return <button key={module.id} type="button" className={styles.coverCard} onClick={() => { setCoverView(false); setSelectedGroup(module.groupName || '未分组'); setActive(module.id); requestAnimationFrame(() => document.getElementById(`module-${module.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }}>
        <span className={styles.coverVisual} style={cover ? { backgroundImage: `url("${cover.replaceAll('"', '%22')}")` } : undefined}>{!cover && <span>暂无封面</span>}</span>
        <span className={styles.coverDescription}><strong>{module.name}</strong><small>{module.prompt.trim() || '暂未填写模板描述'}</small></span>
      </button>;
    })}</div>{cursor && <button type="button" disabled={loading} onClick={() => void loadModules(cursor)}>加载更多模板</button>}</section> : <>
    {visibleModules.map((module, index) => <ImageStudioBlock key={module.id} module={module} groups={groups} onDeleteGroup={deleteGroup} isAdmin={isAdmin} isFirst={index === 0}
      userId={userId} settings={settings} setSettings={setSettings} active={active === module.id} onActivate={() => setActive(module.id)}
      onModuleChange={next => { setModules(current => current.map(item => item.id === next.id ? next : item)); setSelectedGroup(next.groupName || '未分组'); }}
      globalSettingsOpen={globalSettingsOpen && index === 0} onCloseGlobal={() => setGlobalSettingsOpen(false)}
      ratios={{ custom: customRatios, busy: ratiosBusy, error: ratiosError, onRetry: () => void syncRatios(), onCustom: syncRatios }}
      settingsReload={settingsReload} onReloadSettings={() => setSettingsReload(current => current + 1)} />)}
    {loading && <p role="status">正在读取模块…</p>}
    {cursor && <button disabled={loading} onClick={() => void loadModules(cursor)}>加载更多模块</button>}
    {visibleModules.length > 0 && <button type="button" className={styles.newModule} disabled={creating} onClick={() => void createModule()}><Plus size={17} />新建模块</button>}
    </>}
    </div>
    <dialog ref={presetDialog} className={styles.dialog} onCancel={() => setPresetDialogOpen(false)}>
      <header className={styles.header}><h2>模板库</h2><button type="button" aria-label="关闭模板库" onClick={() => setPresetDialogOpen(false)}><X size={20} /></button></header>
      {presetsError && <p role="alert" className={styles.error}>{presetsError}</p>}
      {presetsLoading ? <p role="status">正在读取模板…</p> : !presets.length ? <p className={styles.muted}>暂无模板</p> : <div className={styles.presetList}>{presets.map(preset => <article key={preset.id} className={styles.presetItem}><div><strong>{preset.name}</strong><span>{preset.groupName} · {IMAGE_STUDIO_MODEL_LABELS[preset.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || preset.model} · 应用后生成自己的配置</span></div><button type="button" disabled={presetApplying} onClick={() => void applyPreset(preset)}>新建并应用</button></article>)}</div>}
    </dialog>
  </main>;
}

function ImageStudioBlock({ isAdmin, isFirst, userId, module, groups, onDeleteGroup, settings, setSettings, active, onActivate, onModuleChange, globalSettingsOpen, onCloseGlobal, settingsReload, onReloadSettings, ratios }: {
  isAdmin: boolean; isFirst: boolean; userId: string; module: StudioModule; groups: string[]; onDeleteGroup: (group: string) => Promise<void>; settings: SettingsValue | null;
  setSettings: Dispatch<SetStateAction<SettingsValue | null>>; active: boolean; onActivate: () => void; onModuleChange: (module: StudioModule) => void;
  globalSettingsOpen: boolean; onCloseGlobal: () => void;
  settingsReload: number; onReloadSettings: () => void;
  ratios: RatioPreferences;
}) {
  const [draftContext, setDraftContext] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [prompt, setPrompt] = useState(module.prompt);
  const [count, setCount] = useState(module.count);
  const [referenceLimit, setReferenceLimit] = useState(Math.max(1, Math.min(MAX_REFERENCE_IMAGES, module.referenceLimit || MAX_REFERENCE_IMAGES)));
  const [aspectRatio, setAspectRatio] = useState(module.aspectRatio || 'auto');
  const [moduleModel, setModuleModel] = useState(module.model);
  const [quality, setQuality] = useState(module.quality || defaultImageStudioQuality(module.model));
  const [groupName, setGroupName] = useState(module.groupName || '未分组');
  const [banner, setBanner] = useState<UploadedAssetPayload | null>(module.banner || null);
  const [ratioEditing, setRatioEditing] = useState(false);
  const [images, setImages] = useState<UploadedAssetPayload[]>(module.images.slice(0, Math.max(1, Math.min(MAX_REFERENCE_IMAGES, module.referenceLimit || MAX_REFERENCE_IMAGES))));
  const [name, setName] = useState(module.name);
  const [nameEditing, setNameEditing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const [moduleRevision, setModuleRevision] = useState(module.revision);
  const [moduleSaving, setModuleSaving] = useState(false);
  const [moduleContext, setModuleContext] = useState(module.context || '');
  const [savedModuleContext, setSavedModuleContext] = useState(module.context || '');
  const [moduleContextConfigured, setModuleContextConfigured] = useState(module.contextConfigured);
  const [moduleSaveError, setModuleSaveError] = useState('');
  const [moduleSaved, setModuleSaved] = useState(module.saved ? JSON.stringify({ name: module.name, prompt: module.prompt, context: module.context || '', count: module.count, referenceLimit: module.referenceLimit || MAX_REFERENCE_IMAGES, aspectRatio: module.aspectRatio || 'auto', model: module.model, quality: module.quality || 'auto', groupName: module.groupName || '未分组', bannerAssetId: module.banner?.id || null, referenceIds: module.images.map(image => image.id), reproduceFromTaskId: module.reproduceFromTaskId || null }) : '');
  const moduleSaveLock = useRef(false);
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<Record<string, unknown> | null>(null);
  const [reproduceSourceTaskId, setReproduceSourceTaskId] = useState<string | null>(module.reproduceFromTaskId || null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StudioTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deletedIds = useRef(new Set<string>());
  const deleteLock = useRef(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);
  const submitLock = useRef(false);
  const listLock = useRef(false);
  const loadedMore = useRef(false);
  const uploadLock = useRef(false);
  const saving = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const moduleDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bannerFileInput = useRef<HTMLInputElement>(null);
  const [globalPrices, setGlobalPrices] = useState<Record<string, number | null>>(settings?.prices || module.prices);
  const currentDraft = useRef({ context: draftContext, prices: globalPrices });
  currentDraft.current = { context: draftContext, prices: globalPrices };
  const dirty = Boolean(isFirst && isAdmin && settings && (
    draftContext !== (settings.context || '') || JSON.stringify(globalPrices) !== JSON.stringify(settings.prices)
  ));
  const globalDirty = useRef(dirty);
  const settingsRequest = useRef(0);
  globalDirty.current = dirty;
  const unsavedContext = dirty || moduleContext !== savedModuleContext;
  const suffix = module.id === `default-${userId}` ? userId : `${userId}:${module.id}`;
  const draftKey = `sd2-image-studio-draft:${suffix}`;
  const pendingKey = `sd2-image-studio-pending:${suffix}`;
  const moduleDraft = { name, prompt, context: moduleContext, count, referenceLimit, aspectRatio, model: moduleModel, quality, groupName, bannerAssetId: banner?.id || null, referenceIds: images.map(image => image.id), reproduceFromTaskId: reproduceSourceTaskId || null };
  const moduleSaveSnapshot = { ...moduleDraft };
  const moduleDirty = JSON.stringify(moduleSaveSnapshot) !== moduleSaved;

  useEffect(() => { if (globalSettingsOpen) dialog.current?.showModal(); }, [globalSettingsOpen]);
  useEffect(() => { if (deleteTarget) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [deleteTarget]);
  useEffect(() => { if (nameEditing) nameInput.current?.focus(); }, [nameEditing]);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '200px' });
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, []);

  async function saveModule(reproduceTaskId = reproduceSourceTaskId, revisionOverride = moduleRevision) {
    if (moduleSaveLock.current || uploading || bannerUploading) return false;
    moduleSaveLock.current = true; setModuleSaving(true); setError(''); setModuleSaveError('');
    const snapshot = { ...moduleDraft, reproduceFromTaskId: reproduceTaskId || null };
    const contextSnapshot = moduleContext;
    try {
      const result = await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: module.id, revision: revisionOverride, ...snapshot, context: contextSnapshot }) }));
      setModuleRevision(result.revision); setModuleSaved(JSON.stringify({ ...snapshot, context: contextSnapshot }));
      setSavedModuleContext(contextSnapshot); setModuleContextConfigured(result.contextConfigured);
      onModuleChange(result);
      return result.revision as number;
    } catch (e) { const message = e instanceof Error ? e.message : '保存失败'; setError(message); setModuleSaveError(message); return false; }
    finally { moduleSaveLock.current = false; setModuleSaving(false); }
  }

  function restoreDefaults() {
    if (!window.confirm('恢复当前模块默认设置？参考图、banner 和历史生成结果会保留。')) return;
    const nextModel = moduleModel;
    setPrompt(''); setModuleContext(''); setCount(1); setReferenceLimit(MAX_REFERENCE_IMAGES); setAspectRatio('auto'); setModuleModel(nextModel);
    setQuality(defaultImageStudioQuality(nextModel)); setGroupName('未分组'); setReproduceSourceTaskId(null);
    setModuleSaveError('');
  }

  async function saveAsPreset() {
    const presetName = window.prompt('模板名称', name);
    if (!presetName?.trim()) return;
    try {
      await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        scope: isAdmin ? 'admin' : 'creator', name: presetName.trim(), groupName, prompt, context: moduleContext, model: moduleModel, quality,
        count, referenceLimit, aspectRatio, bannerAssetId: banner?.id || null, referenceIds: images.map(image => image.id),
      }) }));
      setSaveStatus('模板已保存');
      window.setTimeout(() => setSaveStatus(''), 2200);
    } catch (e) { setError(e instanceof Error ? e.message : '模板保存失败'); }
  }

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (saved && (!module.saved || saved.revision === module.revision)) {
        if (typeof saved.name === 'string') setName(saved.name.slice(0, 80));
        if (typeof saved.prompt === 'string') setPrompt(saved.prompt.slice(0, 20000));
        if (Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 8) setCount(saved.count);
        if (Number.isInteger(saved.referenceLimit) && saved.referenceLimit >= 1 && saved.referenceLimit <= MAX_REFERENCE_IMAGES) setReferenceLimit(saved.referenceLimit);
        if (typeof saved.model === 'string') setModuleModel(saved.model);
        if (typeof saved.quality === 'string') setQuality(saved.quality);
        if (typeof saved.groupName === 'string') setGroupName(saved.groupName.slice(0, 40));
        if (saved.banner && typeof saved.banner.id === 'string') setBanner(saved.banner);
        if (typeof saved.aspectRatio === 'string') { try { setAspectRatio(normalizeStudioRatio(saved.aspectRatio)); } catch {} }
        if (Array.isArray(saved.images)) setImages(saved.images.filter((image: UploadedAssetPayload) => image && typeof image.id === 'string' && typeof image.originalUrl === 'string').slice(0, Number.isInteger(saved.referenceLimit) ? saved.referenceLimit : MAX_REFERENCE_IMAGES));
        if (Object.prototype.hasOwnProperty.call(saved, 'reproduceSourceTaskId')) {
          setReproduceSourceTaskId(typeof saved.reproduceSourceTaskId === 'string' && saved.reproduceSourceTaskId.length <= 120 ? saved.reproduceSourceTaskId : null);
        }
      }
      const pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (pending && typeof pending.requestId === 'string') setPendingSubmission(pending);
    } catch { /* A damaged local draft must not block the page. */ }
    setDraftLoaded(true);
  }, [draftKey, pendingKey, module.saved, module.revision, isAdmin]);
  useEffect(() => {
    if (!draftLoaded) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ prompt, count, referenceLimit, aspectRatio, images, name, model: moduleModel, quality, groupName, banner, reproduceSourceTaskId: reproduceSourceTaskId || null, revision: moduleRevision })); } catch { /* Generation does not depend on browser storage. */ }
  }, [draftLoaded, draftKey, prompt, count, referenceLimit, aspectRatio, images, name, moduleModel, quality, groupName, banner, reproduceSourceTaskId, moduleRevision]);

  function closeSettings() {
    if (dirty && !window.confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？')) return;
    dialog.current?.close();
    onCloseGlobal();
  }

  function changeGroup(value: string) {
    if (value !== '__other__') { setGroupName(value); return; }
    const next = window.prompt('输入新分组名称（最多 40 字）', '未命名分组')?.trim().slice(0, 40);
    if (next) setGroupName(next);
  }

  const loadSettings = useCallback(async () => {
    if (saving.current) {
      setSettingsError('正在保存，请保存完成后重新读取');
      return;
    }
    const request = ++settingsRequest.current;
    const draftBeforeLoad = JSON.stringify(currentDraft.current);
    setSettingsError('');
    try {
      const value: SettingsValue = await readResponse(await fetch('/api/image-studio/settings', { cache: 'no-store' }));
      if (request !== settingsRequest.current) return;
      if (JSON.stringify(currentDraft.current) !== draftBeforeLoad) {
        setSettingsError('读取期间有新的修改，已保留草稿。请保存当前修改或重新读取');
        return;
      }
      setSettings(value); setDraftContext(value.context || ''); setGlobalPrices(value.prices || module.prices); setSaveStatus('');
    } catch (e) { if (request === settingsRequest.current) setSettingsError(e instanceof Error ? e.message : '读取失败'); }
  }, [setSettings, module.prices]);
  useEffect(() => {
    if (!isFirst) return;
    if (globalDirty.current) { setSettingsError('通用设置已更新，请先保存当前修改或重新读取'); return; }
    void loadSettings();
  }, [isFirst, loadSettings, settingsReload, module.prices]);

  const saveSettings = useCallback(async () => {
    if (!settings || !isFirst || !isAdmin || saving.current) return;
    ++settingsRequest.current;
    saving.current = true;
    const snapshot = { context: currentDraft.current.context, prices: currentDraft.current.prices, revision: settings.revision };
    setSaveStatus('正在保存'); setSettingsError('');
    try {
      const value: SettingsValue = await readResponse(await fetch('/api/image-studio/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
      }));
      setSettings({ ...settings, ...value, contextConfigured: Boolean(value.context?.trim()) });
      setSettingsError('');
      setSaveStatus(JSON.stringify(currentDraft.current) === JSON.stringify({ context: snapshot.context, prices: snapshot.prices }) ? '已保存，下次生成生效' : '等待保存');
    } catch (e) { setSaveStatus('未保存'); setSettingsError(e instanceof Error ? e.message : '保存失败'); }
    finally { saving.current = false; }
  }, [settings, isAdmin, isFirst, setSettings]);

  useEffect(() => {
    if (!isFirst || !isAdmin || !dirty || settingsError) return;
    const timer = setTimeout(() => { void saveSettings(); }, 700);
    return () => clearTimeout(timer);
  }, [dirty, draftContext, globalPrices, isAdmin, isFirst, saveSettings, settingsError]);

  const loadTasks = useCallback(async (cursor?: string) => {
    if (listLock.current) return;
    listLock.current = true;
    try {
      const query = new URLSearchParams({ moduleId: module.id });
      if (cursor) query.set('cursor', cursor);
      const result = await readResponse(await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store' }));
      setTasks(current => {
        const fresh: StudioTask[] = result.tasks.filter((task: StudioTask) => !deletedIds.current.has(task.id));
        const ids = new Set(fresh.map(task => task.id));
        const previous = current.filter(task => !ids.has(task.id) && !deletedIds.current.has(task.id));
        return cursor ? [...previous, ...fresh] : loadedMore.current ? [...fresh, ...previous] : fresh;
      });
      if (cursor || !loadedMore.current) setNextCursor(result.nextCursor);
      if (cursor) loadedMore.current = true;
      setTasksError('');
    } catch (e) { setTasksError(e instanceof Error ? e.message : '读取记录失败'); }
    finally { listLock.current = false; setLoadingTasks(false); }
  }, [module.id]);
  useEffect(() => { if (visible) void loadTasks(); }, [visible, loadTasks]);
  const hasPending = tasks.some(task => task.status === 'queued' || task.status === 'running');
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => { if (!document.hidden) void loadTasks(); }, hasPending ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [hasPending, loadTasks, visible]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden && visible) void loadTasks(); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [loadTasks, visible]);
  useEffect(() => () => { if (downloadReady) URL.revokeObjectURL(downloadReady.url); }, [downloadReady]);

  async function submit(retryTask?: StudioTask) {
    if (!settings || submitLock.current || ratioEditing) return;
    let submitModuleRevision = moduleRevision;
    if (!pendingSubmission && moduleDirty) {
      const savedRevision = await saveModule();
      if (!savedRevision) return;
      submitModuleRevision = savedRevision;
    }
    const payload = pendingSubmission || { requestId: crypto.randomUUID(), prompt: retryTask?.prompt ?? prompt,
      moduleId: module.id, moduleRevision: submitModuleRevision, reproduceFromTaskId: reproduceSourceTaskId || undefined, count: retryTask ? 1 : count, aspectRatio: retryTask?.aspectRatio || aspectRatio, revision: settings.revision, referenceIds: retryTask?.referenceIds || images.map(image => image.id) };
    try { sessionStorage.setItem(pendingKey, JSON.stringify(payload)); } catch { /* The in-memory request ID still prevents duplicate retries. */ }
    submitLock.current = true; setSubmitting(true); setError('');
    let ambiguous = true;
    try {
      const response = await fetch('/api/image-studio/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.status >= 400 && response.status < 500) { ambiguous = false; setPendingSubmission(null); try { sessionStorage.removeItem(pendingKey); } catch {} if (response.status === 409) onReloadSettings(); await readResponse(response); }
      else {
        await readResponse(response);
        if (reproduceSourceTaskId) {
          const clearedRevision = await saveModule(null, submitModuleRevision);
          if (!clearedRevision) { setError('生成已完成，但历史复现模式尚未清除；请重试保存模块后再继续。'); return; }
        }
        setPendingSubmission(null); setReproduceSourceTaskId(null); try { sessionStorage.removeItem(pendingKey); } catch {} await loadTasks();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交结果未确认');
      // Reuse the exact request ID after ambiguous transport failures.
      setPendingSubmission(ambiguous ? payload : null);
    } finally { submitLock.current = false; setSubmitting(false); }
  }

  function restoreTask(task: StudioTask) {
    if (!task.snapshot) {
      setError('这条历史记录没有可恢复的完整设置，请按当前模块重新填写后生成。');
      return;
    }
    if (pendingSubmission) {
      setError('上次提交尚未确认，请先查看生成记录或放弃核对后再恢复设置。');
      return;
    }
    if (uploading || moduleSaving) {
      setError('当前仍在上传或保存模块，请完成后再恢复历史设置。');
      return;
    }
    if (moduleDirty && !window.confirm('当前模块有未保存内容，恢复后会替换当前输入，但不会立即保存、提交或扣积分。确定继续吗？')) return;
    const snapshot = task.snapshot;
    setPrompt(snapshot.prompt || '');
    setCount(Math.max(1, Math.min(8, snapshot.count || 1)));
    try { setAspectRatio(normalizeStudioRatio(snapshot.aspectRatio || 'auto')); } catch { setAspectRatio('auto'); }
    setImages(snapshot.referenceImages.filter(image => image && typeof image.id === 'string' && typeof image.originalUrl === 'string').slice(0, referenceLimit));
    if (typeof snapshot.model === 'string' && snapshot.model) setModuleModel(snapshot.model);
    if (typeof snapshot.quality === 'string') setQuality(normalizeImageStudioQuality(snapshot.model || moduleModel, snapshot.quality));
    setReproduceSourceTaskId(snapshot.sourceAvailable ? task.id : null);
    setSelected([]);
    setError(snapshot.sourceAvailable
      ? '已恢复当时的参考图和生成设置，并会沿用当时上下文。点击“生成图片”后才会创建新任务并扣积分。'
      : '已恢复当时可读取的参考图和生成设置。该旧记录没有独立上下文快照，本次会按当前模块上下文生成。点击“生成图片”后才会创建新任务并扣积分。');
  }

  function exitReproductionMode(message = '已退出历史复现模式，接下来会使用当前模块上下文。') {
    setReproduceSourceTaskId(null);
    setError(message);
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
  async function deleteResult() {
    if (!deleteTarget || deleteLock.current) return;
    const target = deleteTarget;
    deleteLock.current = true; setDeleting(true); setDeleteError('');
    try {
      await readResponse(await fetch('/api/image-studio/tasks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: target.id }) }));
      deletedIds.current.add(target.id);
      setTasks(current => current.filter(task => task.id !== target.id));
      setSelected(current => current.filter(id => id !== target.id));
      setDownloadReady(null); setDeleteTarget(null);
      if (preview === target.asset?.original_url) setPreview(null);
    } catch (e) { setDeleteError(e instanceof Error ? e.message : '删除未确认，请重试'); }
    finally { deleteLock.current = false; setDeleting(false); }
  }
  const moduleUnitCredits = settings?.prices?.[moduleModel] ?? module.prices[moduleModel] ?? null;
  const providerCostUsd = IMAGE_STUDIO_MODEL_COST_USD[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_COST_USD];
  const ready = Boolean(settings?.providerReady && (settings.contextConfigured || moduleContextConfigured) && moduleUnitCredits !== null && !dirty && !settingsError && moduleContext === savedModuleContext);

  useEffect(() => {
    if (!unsavedContext) return;
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
  }, [unsavedContext]);

  const addImages = useCallback(async (files: File[], replaceSingle = false) => {
    if (uploadLock.current || submitting || pendingSubmission || !files.length) return;
    const uploadFiles = replaceSingle && referenceLimit === 1 ? files.slice(-1) : files;
    if (!(replaceSingle && referenceLimit === 1) && uploadFiles.length + images.length > referenceLimit) { setError(`当前模板最多选择 ${referenceLimit} 张参考图`); return; }
    if (uploadFiles.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)) {
      setError('请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    uploadLock.current = true; setUploading(true); setError('');
    try {
      for (const file of uploadFiles) {
        const asset = await uploadFileAsAsset(file);
        if (!asset.id || !asset.originalUrl) throw new Error('上传结果不完整，请重试');
        setImages(current => replaceSingle && referenceLimit === 1 ? [asset] : [...current, asset]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { uploadLock.current = false; setUploading(false); }
  }, [images.length, referenceLimit, submitting, pendingSubmission]);

  async function uploadBanner(file: File) {
    if (bannerUploading || submitting || pendingSubmission) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError('banner 请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    setBannerUploading(true); setError('');
    try {
      const asset = await uploadFileAsAsset(file);
      if (!asset.id || !asset.originalUrl) throw new Error('banner 上传结果不完整，请重试');
      setBanner(asset);
    } catch (e) { setError(e instanceof Error ? e.message : 'banner 上传失败'); }
    finally { setBannerUploading(false); }
  }

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (!active || document.querySelector('dialog[open]') || preview || event.defaultPrevented) return;
      const files = Array.from(event.clipboardData?.items || [])
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
      if (!files.length) return;
      event.preventDefault();
      void addImages(files, referenceLimit === 1);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [addImages, preview, active, referenceLimit]);

  return <section ref={section} id={`module-${module.id}`} className={styles.module} aria-label={name} data-active={active}
    onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className={styles.header}>
      {nameEditing ? <input ref={nameInput} className={styles.moduleName} aria-label="模块名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} onBlur={() => setNameEditing(false)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setNameEditing(false); } }} /> : <button type="button" className={styles.moduleNameDisplay} aria-label={`编辑模块标题：${name}`} onClick={() => setNameEditing(true)}>{name}</button>}
      <div className={styles.counts}>
        <label className={styles.moduleGroupControl}>分组
          <select aria-label="模块分组" value={groupName} onChange={event => changeGroup(event.target.value)}>
            {groups.map(group => <option key={group} value={group}>{group}</option>)}
            <option value="__other__">其他…</option>
          </select>
        </label>
        {!DEFAULT_GROUPS.includes(groupName) && <button type="button" title="删除当前分组" onClick={() => void onDeleteGroup(groupName)}>删除分组</button>}
        <span role="status" className={styles.muted}>{moduleSaving ? '保存中' : moduleDirty ? '未保存' : '已保存'}</span>
        <button type="button" onClick={() => moduleDialog.current?.showModal()}><Settings size={17} />模块上下文</button>
      </div>
    </header>
    <div className={`${styles.moduleBanner} ${banner?.originalUrl ? styles.moduleBannerHasImage : ''}`}>
      {banner?.originalUrl ? <>
        {/* 保留图片原始比例，让 banner 高度随上传图片自适应。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.moduleBannerImage} src={banner.originalUrl} alt="模块 banner" />
        <span className={styles.bannerLabel}>模块 banner</span>
        <button type="button" className={styles.bannerReplace} disabled={bannerUploading || submitting} onClick={() => bannerFileInput.current?.click()}>{bannerUploading ? '上传中' : '更换图片'}</button>
        <button type="button" className={styles.bannerRemove} disabled={bannerUploading || submitting} onClick={() => setBanner(null)} aria-label="移除模块 banner"><X size={16} /></button>
      </> : <button type="button" className={styles.bannerEmpty} disabled={bannerUploading || submitting} onClick={() => bannerFileInput.current?.click()}><ImagePlus size={20} />{bannerUploading ? '上传中' : '点击上传模块 banner'}</button>}
    </div>
    <input ref={bannerFileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void uploadBanner(file); event.target.value = ''; }} />
    <div className={styles.workspace}>
      <section className={styles.inputs} aria-label="生成参数">
        {reproduceSourceTaskId && <p role="status" className={styles.muted}>历史复现模式：生成时会沿用所选历史记录的上下文；当前修改不会自动提交或扣积分。<button type="button" onClick={() => exitReproductionMode()}>退出历史复现</button></p>}
        <label className={styles.label}>参考图片 <span className={styles.referenceLimitControl}>固定数量
          <select aria-label="固定参考图片数量" value={referenceLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => {
            const next = Math.max(1, Math.min(MAX_REFERENCE_IMAGES, Number(event.target.value)));
            setReferenceLimit(next);
            setImages(current => current.slice(0, next));
          }}>{[1, 2, 4, 8, 10].map(value => <option key={value} value={value}>{value} 张</option>)}</select>
          <em>{images.length}/{referenceLimit}</em>
        </span></label>
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
          {images.length < referenceLimit && <button type="button" className={styles.add} disabled={uploading || submitting || Boolean(pendingSubmission)} onClick={() => fileInput.current?.click()}><ImagePlus size={24} />{uploading ? '上传中' : '添加图片'}</button>}
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => {
          void addImages(Array.from(event.target.files || [])); event.target.value = '';
        }} />
        <label className={styles.label} htmlFor={`studio-prompt-${module.id}`}>补充 <span>有图片时选填</span></label>
        <textarea id={`studio-prompt-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={prompt} maxLength={20000} onChange={event => setPrompt(event.target.value)} placeholder="补充想生成的画面" rows={9} />
        <label className={styles.label} htmlFor={`studio-count-${module.id}`}>生成张数</label>
        <div className={styles.counts}>
          {[1, 2, 4, 8].map(n => <button type="button" disabled={submitting || Boolean(pendingSubmission)} key={n} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
          <input id={`studio-count-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} type="number" min={1} max={8} step={1} value={count} onChange={event => setCount(Number(event.target.value))} />
        </div>
        <button type="button" className={styles.generate} disabled={submitting || uploading || moduleSaving || ratioEditing || (!pendingSubmission && (!ready || (!prompt.trim() && !images.length) || !Number.isInteger(count) || count < 1 || count > 8))} onClick={() => void submit()}>{submitting ? '正在提交' : pendingSubmission ? '重试提交' : '生成图片'}</button>
        <RatioPicker value={aspectRatio} onChange={setAspectRatio} onEditing={setRatioEditing} disabled={submitting || Boolean(pendingSubmission)} {...ratios} />
        <div className={styles.modelQualityRow}>
          <label className={styles.compactField} htmlFor={`studio-model-${module.id}`}><strong>生成模型</strong>
            <select id={`studio-model-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={moduleModel} onChange={event => { const next = event.target.value; setModuleModel(next); setQuality(defaultImageStudioQuality(next)); }}>
              {models.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}
            </select>
          </label>
          <label className={styles.compactField} htmlFor={`studio-quality-${module.id}`}><strong>图片质量</strong>
            <select id={`studio-quality-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={normalizeImageStudioQuality(moduleModel, quality)} onChange={event => setQuality(event.target.value)}>
              {(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || ['auto']).map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option]}</option>)}
            </select>
          </label>
        </div>
        {!IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS]?.some(option => option !== 'auto') && <p className={styles.muted}>当前模型不支持质量档位，按模型默认质量生成。</p>}
        <p className={styles.muted}>{moduleUnitCredits == null ? '当前模型积分单价尚未设置' : `每张 ${moduleUnitCredits} 积分 · 本次 ${moduleUnitCredits * (Number.isInteger(count) ? count : 0)} 积分`} · 上游成本 {providerCostUsd == null ? '待配置' : `$${providerCostUsd.toFixed(3)} / 张`}</p>
        <div className={styles.moduleQuickActions} aria-label="模板快捷设置">
          <button type="button" onClick={restoreDefaults}><RefreshCw size={16} />恢复默认</button>
          <button type="button" disabled={moduleSaving || uploading || bannerUploading || !moduleDirty} className={moduleDirty ? styles.saveReady : ''} onClick={() => void saveModule()}><Save size={16} />保存当前模板配置</button>
          <button type="button" onClick={() => void saveAsPreset()}><Save size={16} />另存为模板</button>
        </div>
        {saveStatus && <p role="status" className={styles.muted}>{saveStatus}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
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
              <img src={task.asset.original_url} alt={task.prompt || '参考图生成结果'} loading="lazy" />
            </button>
            <button type="button" className={styles.deleteResult} disabled={deleting || downloadBusy} title="删除生成图片" aria-label={`删除第 ${task.ordinal} 张生成图片`} onClick={() => { setDeleteError(''); setDeleteTarget(task); }}><Trash2 size={17} /></button>
            <input className={styles.select} type="checkbox" aria-label={`选择第 ${task.ordinal} 张图片`} checked={selected.includes(task.id)} onChange={event => {
              if (event.target.checked && selected.length >= 8) { setError('每次最多下载 8 张'); return; }
              setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id));
            }} />
          </> : <div className={styles.taskState}>{['queued', 'running'].includes(task.status) && <LoaderCircle className={styles.spinner} size={24} />}
            {task.status === 'queued' ? '等待生成' : task.status === 'running' ? '正在生成' : task.status === 'succeeded' ? '图片已移除' : '未能交付图片'}</div>}</div>
          <p className={styles.prompt} title={task.prompt || '参考图生成'}>{task.prompt || '参考图生成'}</p>
          {task.asset?.width && task.asset.height && <p className={styles.muted}>{task.asset.width} × {task.asset.height}{task.outputSize && `${task.asset.width}x${task.asset.height}` !== task.outputSize ? ` · 模型返回尺寸与请求 ${task.outputSize} 不同` : ''}</p>}
          <div className={styles.resultActions}><span className={styles.muted}>{new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><div className={styles.resultCommands}>
            {task.asset && <button type="button" disabled={downloadBusy} onClick={() => void download([task.id])}><Download size={15} />下载</button>}
            {task.snapshot && <button type="button" disabled={submitting || uploading || moduleSaving || ratioEditing || Boolean(pendingSubmission)} onClick={() => restoreTask(task)}><RefreshCw size={15} />重新生成</button>}
            <button type="button" className={styles.deleteInline} disabled={deleting || downloadBusy} title="删除生成记录" aria-label="删除生成记录" onClick={() => { setDeleteError(''); setDeleteTarget(task); }}><Trash2 size={15} /></button>
          </div>
          </div>{task.error && <p className={styles.error}>{task.error}</p>}
        </article>)}</div>
        {nextCursor && <button type="button" onClick={() => void loadTasks(nextCursor)}>加载更多</button>}
      </section>
    </div>
    <dialog ref={deleteDialog} className={styles.dialog} aria-labelledby={`delete-title-${module.id}`} onCancel={event => { if (deleting) event.preventDefault(); else setDeleteTarget(null); }}>
      <h2 id={`delete-title-${module.id}`}>删除这张图片？</h2>
      <p>将从本模块的生成结果中移除，不退还已消耗积分。其他模块、参考图和已保存的副本不受影响。</p>
      {deleteError && <p role="alert" className={styles.error}>{deleteError}</p>}
      <div className={styles.resultActions}><button type="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className={styles.danger} disabled={deleting} onClick={() => void deleteResult()}><Trash2 size={16} />{deleting ? '删除中' : '确认删除'}</button></div>
    </dialog>
    <dialog ref={moduleDialog} className={styles.dialog} onCancel={event => {
      if (moduleContext !== savedModuleContext && !window.confirm('上下文尚未保存，确定关闭吗？当前草稿会保留。')) event.preventDefault();
    }}>
      <header className={styles.header}><h2>模块上下文</h2><button type="button" aria-label="关闭模块上下文" onClick={() => {
        if (moduleContext === savedModuleContext || window.confirm('上下文尚未保存，确定关闭吗？当前草稿会保留。')) moduleDialog.current?.close();
      }}><X size={20} /></button></header>
      <textarea aria-label="模块上下文" rows={12} maxLength={20000} value={moduleContext} onChange={event => { if (reproduceSourceTaskId) exitReproductionMode('模块上下文已修改，已退出历史复现模式，接下来会使用新上下文。'); setModuleContext(event.target.value); setModuleSaveError(''); }} />
      <div className={styles.modelQualityRow}>
        <label className={styles.compactField} htmlFor={`studio-module-model-${module.id}`}><strong>模块模型</strong>
          <select id={`studio-module-model-${module.id}`} value={moduleModel} onChange={event => { const next = event.target.value; setModuleModel(next); setQuality(defaultImageStudioQuality(next)); }}>
            {models.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}
          </select>
        </label>
        <label className={styles.compactField} htmlFor={`studio-module-quality-${module.id}`}><strong>图片质量</strong>
          <select id={`studio-module-quality-${module.id}`} value={normalizeImageStudioQuality(moduleModel, quality)} onChange={event => setQuality(event.target.value)}>
            {(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || ['auto']).map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option]}</option>)}
          </select>
        </label>
      </div>
      <p className={styles.muted}>{isAdmin ? '模型和质量属于当前模块；积分规则统一在通用上下文中设置。' : '这是当前账号自己的模块上下文，只有你能查看和修改。'}上游美元成本由模型目录记录，GPT Image 2 的价格待补充。修改后请点击“保存当前模板配置”。</p>
      <p role="status">{moduleSaving ? '正在保存' : moduleDirty ? '未保存' : '已保存'}</p>
      {moduleSaveError && <p role="alert" className={styles.error}>{moduleSaveError}<button onClick={() => void saveModule()}>重试保存</button></p>}
    </dialog>
    {isAdmin && isFirst && <dialog ref={dialog} className={styles.dialog} onCancel={event => { event.preventDefault(); closeSettings(); }}>
      <header className={styles.header}><h2>通用上下文</h2><button type="button" title="关闭" aria-label="关闭设置" onClick={() => {
        closeSettings();
      }}><X size={20} /></button></header>
      {settings && <>
        <label className={styles.label} htmlFor="studio-context">通用上下文</label>
        <textarea id="studio-context" rows={12} maxLength={20000} value={draftContext} onChange={event => setDraftContext(event.target.value)} />
        <p className={styles.label}>通用模型积分规则</p>
        {models.map(model => <label className={styles.label} key={model}>{IMAGE_STUDIO_MODEL_LABELS[model]} 每张积分
          <input type="number" min={0} max={100000} step={1} placeholder={model === 'gemini-3-pro-image-preview' ? '未设置' : '20'} value={globalPrices[model] ?? ''} onChange={event => {
            const next = event.target.value === '' ? null : Number(event.target.value);
            setGlobalPrices(current => ({ ...current, [model]: next }));
          }} />
        </label>)}
        <p className={styles.muted}>这组积分规则对所有模块生效。默认除 Banana Pro 外均为 20；Banana Pro 需要单独设置。修改后自动保存。</p>
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
  </section>;
}
