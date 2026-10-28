'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Copy, Download, Expand, Pencil, RefreshCw } from 'lucide-react';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { copyPngBlob } from '@/lib/media/copy-image';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { MultiviewWorkDto, MultiviewWorkFileRole } from '@/lib/video/multiview-work-contract';
import { multiviewWorkFile, readMultiviewWorkFile, workFileUrl } from './multiview-work-client';
import styles from './multiview-works.module.css';

export type WorkViewerProps = {
  owner: string; authority: string; work: MultiviewWorkDto; busy: boolean;
  onBack: () => void; onPrevious?: () => void; onNext?: () => void;
  onEdit: (work: MultiviewWorkDto) => void; onRename: (title: string) => void;
  onBranch: () => void; onRemove: () => void; onRefresh: () => void; onRetry: () => void;
  onUseReference?: (work: MultiviewWorkDto, role: string) => void;
  onShare?: () => void;
};
const statusText = (work: MultiviewWorkDto) => work.sourceState === 'changed' ? '原视频已变化，保留上次成品'
  : work.ready?.revision === work.draftRevision && work.status === 'ready' ? '已保存'
    : work.status === 'failed' ? '拼图准备未完成，选帧已保留'
      : work.ready ? '更新正在准备，当前查看上次已保存结果' : '选帧已保存，正在准备拼图';

export function MultiviewWorkViewer(props: WorkViewerProps) {
  const { owner, authority, work, busy } = props;
  const [mode, setMode] = useState<'collage' | 'single'>('collage');
  const [selected, setSelected] = useState('');
  const [zoom, setZoom] = useState(false);
  const [title, setTitle] = useState(work.title);
  const [titleRetained, setTitleRetained] = useState(true);
  const [notice, setNotice] = useState('');
  const [reading, setReading] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useDialogDismiss({ open: menuOpen, dialogRef: menu, modal: false, restoreFocus: false,
    onDismiss: () => { if (menu.current) menu.current.open = false; setMenuOpen(false); } });
  const controller = useRef<AbortController | null>(null);
  const token = useRef<symbol | null>(null);
  const ready = work.ready;
  const identity = JSON.stringify([owner, authority, work.id, work.sourceVersion, ready?.revision]);
  const current = useRef(identity); current.current = identity;
  const titleContext = useRef({ id: `${owner}:${work.id}`, value: work.title });
  const titleAttempted = useRef('');
  const { confirm, productDialog } = useProductDialog();
  const uniqueTitle = Boolean(title.trim() && title.trim() !== work.title && !titleRetained);
  useUnsavedNavigation(uniqueTitle, confirm, { unsaved: uniqueTitle ? ['本次作品名称'] : [], busy: [], revision: `${owner}:${work.id}:${title}` });
  const preferenceKey = `sd2:multiview:work-view:v1:${owner}:${work.id}:${work.sourceVersion || ''}`;
  useEffect(() => {
    controller.current?.abort(); token.current = null;
    setNotice(''); setReading(false); setImageFailed(false); setZoom(false);
    let nextMode: 'collage' | 'single' = 'collage', nextSelected = '';
    try {
      const raw = localStorage.getItem(preferenceKey);
      setTitleRetained(true);
      if (raw && raw.length < 1000) {
        const value = JSON.parse(raw);
        nextMode = value.mode === 'single' ? 'single' : 'collage';
        if (typeof value.selected === 'string' && ready?.recipe.slots.some(slot => slot.id === value.selected)) nextSelected = value.selected;
        if (typeof value.titleDraft === 'string' && value.titleDraft.trim() && value.titleDraft.length <= 120 && value.titleDraft !== work.title) {
          setTitle(value.titleDraft); titleAttempted.current = value.titleDraft.trim();
          setNotice('此设备保留了未保存的作品名称，按回车可重新保存；原操作待确认时请先核对');
        }
      }
    } catch { setTitleRetained(false); /* A title draft is not assumed recoverable when storage is unreadable. */ }
    setMode(nextMode); setSelected(nextSelected || ready?.recipe.slots[0]?.id || '');
    return () => { controller.current?.abort(); token.current = null; };
  // Work identity, not draft refreshes, owns reading context.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, preferenceKey]);
  useEffect(() => {
    const previous = titleContext.current;
    const id = `${owner}:${work.id}`;
    setTitle(value => previous.id !== id || value === previous.value ? work.title : value);
    titleContext.current = { id, value: work.title };
  }, [owner, work.id, work.title]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(preferenceKey);
      if (!raw || raw.length > 1500) return;
      const value = JSON.parse(raw);
      if (value.titleDraft === work.title) { delete value.titleDraft; localStorage.setItem(preferenceKey, JSON.stringify(value)); }
    } catch { /* Optional cleanup does not prove a mutation succeeded. */ }
  }, [preferenceKey, work.title]);
  function retainReader(nextMode: 'collage' | 'single', nextSelected: string, nextTitle = title) {
    try {
      const value = JSON.stringify({ mode: nextMode, selected: nextSelected,
        ...(nextTitle.trim() && nextTitle.trim() !== work.title ? { titleDraft: nextTitle } : {}) });
      localStorage.setItem(preferenceKey, value);
      if (localStorage.getItem(preferenceKey) !== value) throw new Error('not_retained');
      setTitleRetained(true);
    } catch { setTitleRetained(false); setNotice('浏览位置和未保存名称本次无法记住，服务器作品不会受影响'); }
  }
  function choose(nextMode: 'collage' | 'single', nextSelected = selected, keepZoom = false) {
    setMode(nextMode); setSelected(nextSelected); setImageFailed(false); if (!keepZoom) setZoom(false);
    retainReader(nextMode, nextSelected);
  }
  // In the enlarged view, ←/→ walk 拼图 → each angle → 拼图.
  function step(delta: 1 | -1) {
    const slots = ready?.recipe.slots || [];
    if (!slots.length) return;
    const views = ['', ...slots.map(item => item.id)];
    const at = mode === 'collage' ? 0 : Math.max(1, views.indexOf(slot?.id || ''));
    const next = views[(at + delta + views.length) % views.length];
    choose(next ? 'single' : 'collage', next || selected, true);
  }
  async function leave(action?: () => void) {
    if (!action) return;
    if (uniqueTitle && !await confirm('本次名称尚未保存，且无法保留在此设备。离开会丢失这段名称。', { title: '未保存名称', confirmLabel: '放弃并离开' })) return;
    action();
  }
  useEffect(() => {
    const clean = title.trim();
    if (busy || !clean || clean === work.title || clean.length > 120 || clean === titleAttempted.current) return;
    const timeout = setTimeout(() => { titleAttempted.current = clean; props.onRename(clean); }, 750);
    return () => clearTimeout(timeout);
  }, [title, work.title, busy, props.onRename]);
  const slot = ready?.recipe.slots.find(item => item.id === selected) || ready?.recipe.slots[0];
  const role: MultiviewWorkFileRole = mode === 'single' && slot ? `frame-${slot.id}` : 'collage';
  const file = multiviewWorkFile(work, role);
  let src = '';
  try { if (file) src = workFileUrl(work.id, file); } catch { /* Invalid output never becomes a remote URL. */ }
  const perform = (format: 'copy' | 'png' | 'zip' | 'single') => {
    if (!ready || reading || busy || isClientSessionBlocked()) return;
    const captured = identity, operation = Symbol('work-file');
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort; token.current = operation;
    const alive = () => current.current === captured && token.current === operation && !abort.signal.aborted && !isClientSessionBlocked();
    setReading(true); setNotice('正在准备原尺寸文件…');
    const outputRole: MultiviewWorkFileRole = format === 'zip' ? 'zip' : format === 'single' && slot ? `frame-${slot.id}` : 'collage';
    const data = readMultiviewWorkFile(owner, work, outputRole, abort.signal, alive);
    // Clipboard write is invoked in this original user event, before awaiting preparation.
    const result = format === 'copy' ? copyPngBlob(data) : data.then(blob => {
      if (!alive()) throw new Error('当前作品已变化，请重试当前操作');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `3D多视图-${format === 'single' ? '单张' : format === 'zip' ? '单图包' : '拼图'}.${format === 'zip' ? 'zip' : 'png'}`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    void result.then(() => { if (alive()) setNotice(format === 'copy' ? '拼图已复制，可直接粘贴' : '文件已交给浏览器下载'); })
      .catch(error => { if (alive()) setNotice(error instanceof Error ? error.message : '操作未完成，请重试或下载拼图'); })
      .finally(() => { if (token.current === operation) { token.current = null; controller.current = null; setReading(false); } });
  };
  return <section className={styles.viewer} aria-label="作品快速浏览">
    <header className={styles.viewerHeader}>
      <button type="button" className={styles.button} onClick={() => void leave(props.onBack)}><ArrowLeft size={16} />返回作品库</button>
      <input aria-label="作品名称" value={title} maxLength={120} disabled={busy} onChange={event => { titleAttempted.current = ''; setTitle(event.target.value); retainReader(mode, selected, event.target.value); }}
        onKeyDown={event => { if (event.key === 'Enter' && !busy && title.trim() && title.trim() !== work.title) { event.preventDefault(); titleAttempted.current = title.trim(); props.onRename(title.trim()); } }} />
      <span className={styles.status}>{statusText(work)}</span>
      <details ref={menu} className={styles.menu} onToggle={event => setMenuOpen(event.currentTarget.open)}><summary>作品操作</summary><div onClick={event => {
        if ((event.target as HTMLElement).closest('button') && menu.current) { menu.current.open = false; setMenuOpen(false); }
      }}>
        <button type="button" disabled={busy || !work.recipe} onClick={props.onBranch}>另存一版</button>
        {props.onShare && work.recipe?.schema !== 3 && <button type="button" onClick={props.onShare}>分享</button>}
        <button type="button" disabled={busy} onClick={props.onRemove}>{work.removed ? '恢复到作品库' : '移出作品库'}</button>
      </div></details>
    </header>
    <div className={styles.meta}>{work.projectTitle || '未关联项目'} · <RelativeTime value={work.updatedAt} /></div>
    <div className={styles.mediaStage}>
      <button type="button" className={`${styles.button} ${styles.previous}`} disabled={!props.onPrevious || busy} onClick={() => void leave(props.onPrevious)} aria-label="上一件作品"><ArrowLeft size={20} /></button>
      {src && !imageFailed ? <button type="button" className={styles.mainImage} onClick={() => setZoom(true)} aria-label="放大查看当前图片">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={`${identity}:${role}`} src={src} alt={mode === 'single' ? slot?.name || '当前单张' : work.title} onError={() => { setImageFailed(true); setNotice('当前图片暂不可读取，请重新核对作品'); }} />
        <Expand size={18} className={styles.expand} />
      </button> : <div className={styles.mediaPlaceholder}>{imageFailed ? '图片暂不可读取' : ready ? '此文件尚未准备好' : '正在准备作品成品'}</div>}
      <button type="button" className={`${styles.button} ${styles.next}`} disabled={!props.onNext || busy} onClick={() => void leave(props.onNext)} aria-label="下一件作品"><ArrowRight size={20} /></button>
    </div>
    {ready && <><div className={styles.readerTools}>
      <div className={styles.thumbnails} aria-label="组内图片">{ready.recipe.slots.map((item, index) => {
        const frame = multiviewWorkFile(work, `frame-${item.id}`);
        return <button type="button" key={item.id} aria-label={`查看第${index + 1}张${item.name ? ` ${item.name}` : ''}`} aria-pressed={mode === 'single' && slot?.id === item.id}
          title="单击放大这个角度" onClick={() => { choose('single', item.id, true); setZoom(true); }}>{frame && <img src={workFileUrl(work.id, frame)} alt="" loading="lazy" />}<span>{item.name || index + 1}</span></button>;
      })}</div>
      <div className={styles.segment} aria-label="浏览模式"><button type="button" aria-pressed={mode === 'collage'} onClick={() => choose('collage')}>拼图</button>
        <button type="button" aria-pressed={mode === 'single'} onClick={() => choose('single')}>单张</button></div>
    </div><div className={styles.meta}>{mode === 'single' ? slot?.name || '当前单张' : `${ready.frameCount}张 · ${ready.width}×${ready.height}`}
      {ready.revision !== work.draftRevision && ' · 上次已保存版本'}</div></>}
    <footer className={styles.viewerActions}>
      <button type="button" className={styles.button} onClick={() => void leave(() => props.onEdit(work))} disabled={busy || work.removed || work.sourceState !== 'current'}><Pencil size={16} />继续编辑</button>
      {props.onUseReference && <button type="button" className={styles.button} disabled={!ready || reading || busy || work.removed || mode === 'single' && !slot}
        title={mode === 'single' ? '把当前单张设为编辑页的主图' : '把拼图成品设为编辑页的主图'}
        onClick={() => void leave(() => props.onUseReference!(work, mode === 'single' ? `frame-${slot!.id}` : 'collage'))}>用作参考图</button>}
      <button type="button" className={styles.primary} disabled={!ready || reading || busy} onClick={() => perform('copy')}><Copy size={16} />复制拼图</button>
      <button type="button" className={styles.button} disabled={!ready || reading || busy} onClick={() => perform('png')}><Download size={16} />下载PNG</button>
      <button type="button" className={styles.button} disabled={!ready || reading || busy} onClick={() => perform('zip')}>下载单图ZIP</button>
      {mode === 'single' && <button type="button" className={styles.button} disabled={!slot || reading || busy} onClick={() => perform('single')}>下载当前单张</button>}
      {work.status === 'failed' && <button type="button" className={styles.button} disabled={busy || work.removed || !work.recipe || work.sourceState !== 'current'} onClick={props.onRetry}>重新准备拼图</button>}
      <button type="button" className={styles.button} disabled={busy} onClick={props.onRefresh}><RefreshCw size={15} />重新核对</button>
    </footer>
    <p role="status" className={styles.notice}>{notice || work.lastError || ''}</p>
    <details className={styles.original}><summary>查看原视频</summary><a href={`/tasks/${encodeURIComponent(work.sourceTaskId)}?returnTo=${encodeURIComponent(`/multiview?view=works&workId=${work.id}`)}`}>打开原视频</a></details>
    {zoom && src && !imageFailed && <ZoomableImagePreview src={src} alt={mode === 'single' ? slot?.name || '当前单张' : work.title}
      title={mode === 'single' ? slot?.name || '当前单张' : '拼图'} sourceVersion={`${work.sourceVersion}:${ready?.revision}:${role}`}
      previewKey={`multiview-work:${owner}:${work.id}:${ready?.revision}:${role}`} hasNavigation={Boolean(ready?.recipe.slots.length)}
      onPrevious={() => step(-1)} onNext={() => step(1)} onClose={() => setZoom(false)} />}
    {productDialog}
  </section>;
}
