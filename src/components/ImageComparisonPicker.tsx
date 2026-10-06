'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, ImagePlus, RotateCcw, Search, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';
import type { PickerAlbum, PickerItem, PickerResponse, PickerScope } from '@/lib/assets/picker-types';
import { comparisonScopes, pickerImageSource, type ImageComparisonSource } from '@/lib/media/image-comparison';
import { useDialogDismiss } from './useDialogDismiss';
import { useImagePreviewHistoryDismiss } from './useImagePreviewHistoryDismiss';
import styles from './ImageComparisonPicker.module.css';

type Props = { side: 'current' | 'comparison'; candidates: ImageComparisonSource[]; container: HTMLElement;
  onSelect: (image: ImageComparisonSource) => Promise<boolean>; onLocal: (file: File) => Promise<boolean>; onClose: () => void };
type Preferences = { view: 'context' | 'library' | 'favorites' | 'recent'; scope: PickerScope; source: string; query: string; album: string; project: string; sort: string };
const defaults: Preferences = { view: 'context', scope: 'mine', source: 'all', query: '', album: '', project: '', sort: 'newest' };
const scopeLabels = { mine: '我的素材', project: '项目素材', shared: '共享给我', public: '公共素材' };

export function ImageComparisonPicker({ side, candidates, container, onSelect, onLocal, onClose }: Props) {
  const { user } = useAppSession();
  const owner = user?.id || '';
  const prefsKey = owner ? `sd2:resource-picker:comparison:v1:${owner}` : '';
  const [prefs, setPrefs] = useState(defaults), [initialized, setInitialized] = useState('');
  const [items, setItems] = useState<PickerItem[]>([]), [albums, setAlbums] = useState<PickerAlbum[]>([]);
  const [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false);
  const [contextLimit, setContextLimit] = useState(24);
  const [loading, setLoading] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState(''), [epoch, setEpoch] = useState(0);
  const dialog = useRef<HTMLDivElement>(null), backdrop = useRef<HTMLDivElement>(null), localInput = useRef<HTMLInputElement>(null);
  const querySequence = useRef(0), selectionSequence = useRef(0);
  const close = useImagePreviewHistoryDismiss(true, dialog, onClose);
  useDialogDismiss({ open: true, dialogRef: dialog, dismissSurfaceRef: backdrop, onDismiss: close });
  useEffect(() => {
    const next = { ...defaults, view: candidates.length ? 'context' : 'library' } as Preferences;
    try {
      const saved = JSON.parse(localStorage.getItem(prefsKey) || '{}');
      if (['context', 'library', 'favorites', 'recent'].includes(saved.view)) next.view = saved.view;
      if (next.view === 'context' && !candidates.length) next.view = 'library';
      if (comparisonScopes.includes(saved.scope)) next.scope = saved.scope;
      if (['all', 'uploaded', 'generated'].includes(saved.source)) next.source = saved.source;
      if (typeof saved.query === 'string') next.query = saved.query.slice(0, 160);
      if (saved.sort === 'name') next.sort = 'name';
      for (const field of ['album', 'project'] as const) if (typeof saved[field] === 'string' && /^[a-zA-Z0-9_-]{0,100}$/.test(saved[field])) next[field] = saved[field];
    } catch { /* Preferences are optional. */ }
    setPrefs(next); setInitialized(prefsKey); setItems([]); setError('');
    return () => { querySequence.current++; selectionSequence.current++; };
  // Candidates may refresh without resetting the user's current search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsKey]);
  useEffect(() => { if (prefsKey && initialized === prefsKey) { try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch { /* Optional persistence. */ } } }, [initialized, prefs, prefsKey]);
  useEffect(() => {
    if (!owner || initialized !== prefsKey || prefs.view === 'context') return;
    const sequence = ++querySequence.current, controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError('');
      const params = new URLSearchParams({ target: 'workspace', types: 'image', view: prefs.view, scope: prefs.scope, source: prefs.source,
        q: prefs.query, sort: prefs.sort, page: String(page) });
      if (prefs.album) params.set('album', prefs.album);
      if (prefs.project) params.set('project', prefs.project);
      if (prefs.view === 'recent') {
        let keys: string[] = [];
        try { const saved = JSON.parse(localStorage.getItem(`sd2:resource-recent:v1:${owner}:image-studio`) || '[]');
          if (Array.isArray(saved)) keys = saved.filter(key => typeof key === 'string' && /^(asset|reference_image):[a-zA-Z0-9_-]+$/.test(key)).slice(0, 60); } catch { /* Empty recents are safe. */ }
        params.set('keys', keys.join(','));
      }
      void fetch(`/api/assets/picker?${params}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
        const data = await readJsonResponse<PickerResponse>(response);
        if (!response.ok) throw new Error('素材读取失败，请重试或重新登录');
        if (sequence !== querySequence.current) return;
        setItems(previous => page === 1 ? data.items : [...previous, ...data.items.filter(item => !previous.some(old => old.identity === item.identity))]);
        setAlbums(data.albums); setHasMore(data.hasMore);
        if (prefs.album && !data.albums.some(album => album.scope === prefs.scope && album.id === prefs.album)
          || prefs.project && !data.albums.some(album => album.scope === prefs.scope && album.project?.id === prefs.project)) {
          setPage(1); setPrefs(current => ({ ...current, album: '', project: '' }));
        }
      }).catch(e => { if (sequence === querySequence.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '素材读取失败'); })
        .finally(() => { if (sequence === querySequence.current) setLoading(false); });
    }, 200);
    return () => { querySequence.current++; controller.abort(); window.clearTimeout(timer); };
  }, [initialized, owner, page, prefs, prefsKey, epoch]);
  const change = (patch: Partial<Preferences>) => { querySequence.current++; setPage(1); setContextLimit(24); setItems([]); setPrefs(current => ({ ...current, ...patch })); };
  const choose = async (image?: ImageComparisonSource, file?: File) => {
    const sequence = ++selectionSequence.current;
    setChoosing(true); setError('');
    try {
      const applied = file ? await onLocal(file) : image ? await onSelect(image) : false;
      if (sequence === selectionSequence.current && applied) close();
    } catch (e) { if (sequence === selectionSequence.current) setError(e instanceof Error ? e.message : '图片未能加载，原图保留'); }
    finally { if (sequence === selectionSequence.current) setChoosing(false); }
  };
  const visibleCandidates = candidates.filter(image => !prefs.query || (image.alt + (image.fileName || '')).toLowerCase().includes(prefs.query.toLowerCase()));
  return createPortal(<div ref={backdrop} className={styles.backdrop}>
    <div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-label={side === 'current' ? '选择当前图' : '选择对比图'} tabIndex={-1}>
      <header className={styles.header}><h2>{side === 'current' ? '选择当前图' : '选择对比图'}</h2><button type="button" title="关闭选图" aria-label="关闭选图" onClick={close}><X size={18} /></button></header>
      <div className={styles.filters}>
        <div className={styles.tabs} role="tablist" aria-label="图片来源">{([['context', '本次图片'], ['library', '素材库'], ['favorites', '我的喜欢'], ['recent', '最近选用']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={prefs.view === value} disabled={value === 'context' && !candidates.length} onClick={() => change({ view: value })}>{label}</button>)}</div>
        <label className={styles.search}><Search size={16} /><input aria-label="搜索图片" value={prefs.query} maxLength={160} onChange={event => change({ query: event.target.value })} /></label>
        {prefs.view !== 'context' && <>
          <select aria-label="素材范围" value={prefs.scope} onChange={event => change({ scope: event.target.value as PickerScope, album: '', project: '' })}>{comparisonScopes.map(scope => <option key={scope} value={scope}>{scopeLabels[scope]}</option>)}</select>
          <select aria-label="素材来源" value={prefs.source} onChange={event => change({ source: event.target.value })}><option value="all">全部来源</option><option value="uploaded">上传图片</option><option value="generated">生成图片</option></select>
          <select aria-label="图集" value={prefs.album} onChange={event => change({ album: event.target.value })}><option value="">全部图集</option>{albums.filter(album => album.scope === prefs.scope).map(album => <option key={album.id} value={album.id}>{album.name}</option>)}</select>
          <select aria-label="项目" value={prefs.project} onChange={event => change({ project: event.target.value, album: '' })}><option value="">全部项目</option>{Array.from(new Map(albums.filter(album => album.scope === prefs.scope && album.project).map(album => [album.project!.id, album.project!])).values()).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <select aria-label="排序" value={prefs.sort} onChange={event => change({ sort: event.target.value })}><option value="newest">最近优先</option><option value="name">名称</option></select>
        </>}
        <button type="button" title="还原选图筛选" aria-label="还原选图筛选" onClick={() => change({ ...defaults, view: candidates.length ? 'context' : 'library' })}><RotateCcw size={16} /></button>
        <button type="button" onClick={() => localInput.current?.click()}><FolderOpen size={16} />本机图片</button>
        <input ref={localInput} type="file" accept="image/*" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(undefined, file); }} />
      </div>
      {(error || choosing) && <div className={styles.status} role="status">{error || '正在加载所选图片，原图保留'}{error && prefs.view !== 'context' && <button type="button" title="重试读取" aria-label="重试读取素材" onClick={() => setEpoch(value => value + 1)}><RotateCcw size={16} /></button>}</div>}
      <div className={styles.body} aria-busy={loading}>
        <div className={styles.grid}>{prefs.view === 'context'
          ? visibleCandidates.slice(0, contextLimit).map((image, index) => <button key={`${image.src}:${index}`} type="button" className={styles.item} onClick={() => void choose(image)}><img src={image.thumbnailSrc || image.src} alt="" loading="lazy" /><span>{image.alt || '本次图片'}</span></button>)
          : items.map(item => <button key={item.identity} type="button" className={styles.item} onClick={() => void choose(pickerImageSource(item))}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <ImagePlus size={28} />}<span>{item.fileName}</span></button>)}</div>
        {!loading && !error && !(prefs.view === 'context' ? visibleCandidates.length : items.length) && <p className={styles.status}>没有符合条件的图片</p>}
        {loading && <p className={styles.status}>正在读取图片</p>}
        {prefs.view !== 'context' && hasMore && <button type="button" className={styles.more} disabled={loading} onClick={() => setPage(value => value + 1)}>加载更多</button>}
        {prefs.view === 'context' && visibleCandidates.length > contextLimit && <button type="button" className={styles.more} onClick={() => setContextLimit(value => value + 24)}>加载更多</button>}
      </div>
    </div>
  </div>, container);
}
