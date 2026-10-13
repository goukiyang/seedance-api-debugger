'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Download, RefreshCw, Undo2, X } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { VideoLoopButton } from '@/components/VideoLoopButton';
import { useProductDialog } from '@/components/useProductDialog';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useVideoLoopState } from '@/lib/hooks/use-media-preview-state';
import { candidateFrames, DEFAULT_MULTIVIEW_LAYOUT, multiviewDimensions, parseMultiviewDraft,
  type MultiviewDraft, type MultiviewInfo, type MultiviewSlot } from '@/lib/video/multiview-contract';
import styles from './multiview.module.css';

type FrameState = { url?: string; error?: string; loading?: boolean };
function sourceReturn(value: string | null, taskId: string) {
  if (value?.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u001f]/.test(value)) return value;
  return taskId ? `/tasks/${encodeURIComponent(taskId)}` : '/tasks';
}
function slot(frame: number): MultiviewSlot { return { id: crypto.randomUUID(), frame, name: '', manual: false }; }
function initialDraft(info: MultiviewInfo): MultiviewDraft {
  return { schema: 1, sourceVersion: info.sourceVersion, slots: candidateFrames(info.timestamps.length, 8).map(slot), reserve: [],
    layout: { ...DEFAULT_MULTIVIEW_LAYOUT }, editing: null };
}
export default function MultiviewPage() {
  const query = useSearchParams();
  const taskId = query.get('taskId') || '';
  const backHref = sourceReturn(query.get('returnTo'), taskId);
  const { user, hasLoadedUser, refreshUser } = useAppSession();
  const owner = user?.id || '';
  const [info, setInfo] = useState<MultiviewInfo | null>(null);
  const [loadedOwner, setLoadedOwner] = useState('');
  const [draft, setDraft] = useState<MultiviewDraft | null>(null);
  const [frames, setFrames] = useState<Record<number, FrameState>>({});
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportFile, setExportFile] = useState<{ url: string; name: string } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [editorFrame, setEditorFrame] = useState(0);
  const [reduceCount, setReduceCount] = useState<number | null>(null);
  const [retained, setRetained] = useState<string[]>([]);
  const [undo, setUndo] = useState<MultiviewDraft | null>(null);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [partialFormat, setPartialFormat] = useState<'png' | 'zip' | null>(null);
  const { confirm, productDialog } = useProductDialog();
  const video = useRef<HTMLVideoElement>(null);
  const requests = useRef(new Map<number, Promise<boolean>>());
  const frameQueue = useRef<Promise<unknown>>(Promise.resolve());
  const objectUrls = useRef(new Set<string>());
  const context = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const frameRef = useRef(frames); frameRef.current = frames;
  const exportLock = useRef(false);
  const source = `/api/video/play/${encodeURIComponent(taskId)}`;
  const loop = useVideoLoopState(taskId ? source : undefined, taskId ? `video_task:${taskId}` : undefined);
  const storageKey = info && owner ? `sd2:multiview:v1:${owner}:${taskId}:${info.sourceVersion}` : '';
  const visible = authorized && loadedOwner === owner && info?.taskId === taskId;
  useUnsavedNavigation(!saved || exporting, confirm, { unsaved: saved ? [] : ['多角度选帧尚未保存到本机'], busy: exporting ? ['拼图文件仍在准备'] : [], revision: JSON.stringify(draft) });

  const clearUrls = useCallback(() => {
    for (const url of Array.from(objectUrls.current)) URL.revokeObjectURL(url);
    objectUrls.current.clear(); requests.current.clear(); setFrames({}); setExportFile(null); setPreview(null);
  }, []);
  const load = useCallback(async (recheck = false) => {
    if (!owner || !/^[a-z0-9_-]{8,80}$/i.test(taskId)) {
      setLoading(false); setAuthorized(false); setError(owner ? '请从已完成的视频旁打开“制作多角度图”' : '请先登录后再查看原视频'); return;
    }
    const generation = ++context.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    requests.current.clear();
    setFrames(value => Object.fromEntries(Object.entries(value).filter(([, state]) => state.url)));
    setAuthorized(false); setLoading(true); setError(''); setPreview(null);
    try {
      const response = await fetch(`/api/video/multiview/${encodeURIComponent(taskId)}`, { cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !result.info) throw new Error(result.error || '原视频读取失败');
      if (generation !== context.current) return;
      const next = result.info as MultiviewInfo;
      const previous = draftRef.current;
      if (!recheck || previous?.sourceVersion !== next.sourceVersion) {
        clearUrls();
        let restored: MultiviewDraft | null = null;
        try { restored = parseMultiviewDraft(localStorage.getItem(`sd2:multiview:v1:${owner}:${taskId}:${next.sourceVersion}`), next); setSaved(true); }
        catch { setSaved(false); }
        const state = restored || initialDraft(next);
        if (!restored) setSaved(false);
        setDraft(state); setUndo(null); setReduceCount(null);
        setEditorFrame(state.editorFrame ?? state.slots.find(item => item.id === state.editing)?.frame ?? 0);
        if (recheck && previous) setNotice('原视频版本已变化，已载入新候选；旧草稿未覆盖新原片。');
      }
      setInfo(next); setLoadedOwner(owner); setAuthorized(true);
    } catch (cause) {
      if (generation !== context.current || controller.signal.aborted) return;
      clearUrls(); setError(cause instanceof Error ? cause.message : '原视频暂不可用');
    } finally { if (generation === context.current) setLoading(false); }
  }, [clearUrls, owner, taskId]);
  useEffect(() => { if (!hasLoadedUser) void refreshUser(); }, [hasLoadedUser, refreshUser]);
  useEffect(() => {
    clearUrls(); setInfo(null); setDraft(null); setLoadedOwner(''); setAuthorized(false); setOriginalOpen(false);
    if (hasLoadedUser) void load();
    return () => { context.current += 1; abort.current?.abort(); clearUrls(); };
  }, [clearUrls, hasLoadedUser, load]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === 'visible' && draftRef.current && !exportLock.current) void load(true); };
    window.addEventListener('focus', recheck); document.addEventListener('visibilitychange', recheck);
    return () => { window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, [load]);
  useEffect(() => {
    if (!draft || !storageKey || !visible) return;
    try { localStorage.setItem(storageKey, JSON.stringify(draft)); setSaved(true); }
    catch { setSaved(false); }
  }, [draft, storageKey, visible]);
  useEffect(() => {
    const media = video.current;
    if (!visible) media?.pause();
    return () => { media?.pause(); };
  }, [visible, originalOpen, draft?.editing]);

  const loadFrame = useCallback(async (frame: number, retry = false): Promise<boolean> => {
    if (!info || !visible) return false;
    if (frameRef.current[frame]?.url) return true;
    if (requests.current.has(frame)) return requests.current.get(frame)!;
    if (frameRef.current[frame]?.error && !retry) return false;
    const generation = context.current;
    const previous = frameQueue.current;
    const pending = (async () => {
      setFrames(value => ({ ...value, [frame]: { loading: true } }));
      try {
        await previous.catch(() => undefined);
        if (generation !== context.current) return false;
        const response = await fetch(`/api/video/multiview/${encodeURIComponent(taskId)}?version=${info.sourceVersion}&frame=${frame}`, { cache: 'no-store', signal: abort.current?.signal });
        if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || '这一帧未提取成功'); }
        const blob = await response.blob();
        if (generation !== context.current) return false;
        const url = URL.createObjectURL(blob); objectUrls.current.add(url);
        setFrames(value => ({ ...value, [frame]: { url } }));
        return true;
      } catch (cause) {
        if (generation === context.current && !abort.current?.signal.aborted) setFrames(value => ({ ...value, [frame]: { error: cause instanceof Error ? cause.message : '提取失败，可单独重试' } }));
        return false;
      } finally { if (generation === context.current) requests.current.delete(frame); }
    })();
    frameQueue.current = pending;
    requests.current.set(frame, pending); return pending;
  }, [info, taskId, visible]);
  const frameSignature = draft?.slots.map(item => item.frame).join(',') || '';
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // Bounded sequential reads reuse private server frames after refresh; never resubmit a video.
    void (async () => { for (const frame of Array.from(new Set(frameSignature.split(',').filter(Boolean).map(Number)))) {
      if (cancelled) break; await loadFrame(frame);
    } })();
    return () => { cancelled = true; };
  }, [frameSignature, loadFrame, visible]);
  useEffect(() => {
    if (!draft?.editing || !visible) return;
    let cancelled = false;
    const timer = window.setTimeout(() => { void (async () => {
      await loadFrame(editorFrame);
      for (const adjacent of [editorFrame - 1, editorFrame + 1, editorFrame - 2, editorFrame + 2]) {
        if (cancelled) break;
        if (adjacent >= 0 && info && adjacent < info.timestamps.length) await loadFrame(adjacent);
      }
    })(); }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draft?.editing, editorFrame, info, loadFrame, visible]);
  useEffect(() => {
    if (Object.keys(frames).length <= 24 || !draft) return;
    const keep = new Set([...draft.slots.map(item => item.frame), ...(draft.editing ? [-2, -1, 0, 1, 2].map(delta => editorFrame + delta) : []), ...(preview !== null ? [preview] : [])]);
    const removable = Object.keys(frames).map(Number).filter(frame => !keep.has(frame) && !requests.current.has(frame));
    if (!removable.length) return;
    for (const frame of removable) { const url = frames[frame]?.url; if (url) { URL.revokeObjectURL(url); objectUrls.current.delete(url); } }
    setFrames(value => Object.fromEntries(Object.entries(value).filter(([key]) => !removable.includes(Number(key)))));
  }, [draft, editorFrame, frames, preview]);

  function update(next: MultiviewDraft, allowUndo = false) {
    if (allowUndo) setUndo(draft);
    setDraft(next); setNotice('');
    setSaved(false);
    setPartialFormat(null);
    if (exportFile) { URL.revokeObjectURL(exportFile.url); objectUrls.current.delete(exportFile.url); setExportFile(null); }
  }
  function chooseCount(count: number) {
    if (!draft || !info || count === draft.slots.length) return;
    if (count < draft.slots.length) { setReduceCount(count); setRetained(draft.slots.slice(0, count).map(item => item.id)); return; }
    const restored = draft.reserve.slice(0, count - draft.slots.length);
    const slots = [...draft.slots, ...restored];
    const candidates = [...candidateFrames(info.timestamps.length, count), ...Array.from({ length: info.timestamps.length }, (_, index) => index)];
    for (const frame of candidates) { if (slots.length >= count) break; if (!slots.some(item => item.frame === frame)) slots.push(slot(frame)); }
    update({ ...draft, slots, reserve: draft.reserve.slice(restored.length) }, true);
  }
  function move(index: number, delta: number) {
    if (!draft || index + delta < 0 || index + delta >= draft.slots.length) return;
    const slots = [...draft.slots]; [slots[index], slots[index + delta]] = [slots[index + delta], slots[index]];
    update({ ...draft, slots }, true);
  }
  function openEditor(item: MultiviewSlot) {
    if (!draft) return;
    video.current?.pause(); setEditorFrame(item.frame); update({ ...draft, editing: item.id, editorFrame: item.frame });
  }
  function seek(frame: number) {
    if (!info) return;
    const value = Math.min(info.timestamps.length - 1, Math.max(0, frame));
    setEditorFrame(value);
    setSaved(false);
    setDraft(current => current ? { ...current, editorFrame: value } : current);
    if (video.current) { video.current.pause(); video.current.currentTime = info.timestamps[value]; }
  }
  const validSlots = draft?.slots.filter(item => frames[item.frame]?.url) || [];
  const dimensions = useMemo(() => info && draft ? multiviewDimensions(info, draft.slots.length, draft.layout) : null, [draft, info]);
  async function prepareExport(format: 'png' | 'zip', onlyReady = false) {
    if (!draft || !info || !visible || exportLock.current) return;
    const selected = onlyReady ? validSlots : draft.slots;
    if (!selected.length) return;
    if (selected.length !== draft.slots.length && !await confirm(`将仅导出已就绪的 ${selected.length} 张，按当前顺序重新排版，未就绪的图片不会进入文件。`, { title: '仅导出可用图', confirmLabel: '准备文件' })) return;
    exportLock.current = true; setExporting(true); setNotice('正在准备文件，不会重新生成视频…');
    const generation = context.current;
    try {
      const response = await fetch(`/api/video/multiview/${encodeURIComponent(taskId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: info.sourceVersion, format, frames: selected.map(item => item.frame), names: selected.map(item => item.name), layout: draft.layout }), signal: abort.current?.signal });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '文件准备失败，可重试'); }
      const blob = await response.blob();
      if (generation !== context.current) return;
      if (exportFile) { URL.revokeObjectURL(exportFile.url); objectUrls.current.delete(exportFile.url); }
      const url = URL.createObjectURL(blob); objectUrls.current.add(url);
      setExportFile({ url, name: `multiview-${taskId}.${format}` }); setNotice(`文件已准备好：${selected.length} 张。请点击下载保存到设备。`);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '导出失败，选帧已保留'); }
    finally { exportLock.current = false; setExporting(false); }
  }
  const editing = draft?.slots.find(item => item.id === draft.editing);
  const currentFrame = frames[editorFrame];
  function collagePreview(selected: MultiviewSlot[]) {
    if (!info || !draft || !selected.length) return null;
    const size = multiviewDimensions(info, selected.length, draft.layout);
    const columns = Math.min(selected.length, draft.layout.columns);
    return <div className={styles.collagePreview}><svg role="img" aria-label={`${selected.length} 张拼图排版预览`} viewBox={`0 0 ${size.width} ${size.height}`}>
      <rect width={size.width} height={size.height} fill={draft.layout.background} />
      {selected.map((item, index) => frames[item.frame]?.url && <image key={item.id} href={frames[item.frame].url}
        x={draft.layout.margin + index % columns * (info.width + draft.layout.gap)} y={draft.layout.margin + Math.floor(index / columns) * (info.height + draft.layout.gap)}
        width={info.width} height={info.height} />)}
    </svg><small>{selected.length} 张 · 拼图 {size.width} × {size.height} · 原图未裁剪或缩放</small></div>;
  }
  const player = info && <div className={styles.videoArea}>
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <video ref={video} src={source} controls playsInline preload="metadata" loop={loop.enabled}
      onLoadedMetadata={event => { if (editing) { event.currentTarget.pause(); event.currentTarget.currentTime = info.timestamps[editorFrame]; } }}
      onPause={event => {
        if (!editing) return;
        const time = event.currentTarget.currentTime;
        let nearest = 0; for (let i = 1; i < info.timestamps.length; i++) if (Math.abs(info.timestamps[i] - time) < Math.abs(info.timestamps[nearest] - time)) nearest = i;
        setEditorFrame(nearest);
        setSaved(false);
        setDraft(current => current ? { ...current, editorFrame: nearest } : current);
      }} />
    <VideoLoopButton enabled={loop.enabled} onToggle={loop.toggle} disabled={!loop.ready} storageUnavailable={loop.storageUnavailable} />
    <small>原片版本与原生成轮次未知 · 原视频预览（未重新生成）</small>
  </div>;

  return <div className={styles.page}>
    <PageBanner title="多角度图" description="从原视频选帧，角度由你确认。不会重跑视频，也不会裁剪或放大原图。" backHref={backHref} backLabel="返回原视频" />
    {loading && <p className={styles.empty} role="status">正在读取原视频与候选图片…</p>}
    {error && <div className={styles.empty} role="alert"><p>{error}</p><button type="button" onClick={() => void load()}>重新读取</button></div>}
    {visible && info && draft && <>
      <div className={styles.toolbar}>
        <div className={styles.count}><span>图片数量</span>{[3, 4, 8].map(count => <button type="button" key={count} aria-pressed={draft.slots.length === count} disabled={exporting} onClick={() => chooseCount(count)}>{count} 张</button>)}</div>
        <div className={styles.exportActions}>
          <button type="button" className={styles.primary} disabled={exporting || validSlots.length !== draft.slots.length} onClick={() => void prepareExport('png')}><Download size={16} />{exporting ? '准备中…' : '导出拼图'}</button>
          <button type="button" disabled={exporting || validSlots.length !== draft.slots.length} onClick={() => void prepareExport('zip')}>下载单图包</button>
        </div>
      </div>
      <div className={styles.caption}><span>{validSlots.length} / {draft.slots.length} 张就绪 · 每张 {info.width} × {info.height} · 拼图 {dimensions?.width} × {dimensions?.height}</span><span>{saved ? '选帧已保存在此设备' : '本次修改暂未保存，请勿关闭页面'}</span></div>
      {notice && <div className={styles.notice} role="status">{notice} {exportFile && <a className={styles.primary} href={exportFile.url} download={exportFile.name}>下载已准备文件</a>}</div>}
      {!saved && <p className={styles.warning} role="alert">本机存储不可用，刷新可能丢失选帧。导出原图不受影响。</p>}
      {undo && <button className={styles.quiet} type="button" disabled={exporting} onClick={() => { const value = undo; setUndo(null); update(value); }}><Undo2 size={14} />撤销上次调整</button>}
      {reduceCount !== null && <section className={styles.retain} aria-label="选择保留图片">
        <h2>保留哪 {reduceCount} 张？</h2><p>未选中的图片留在本次草稿，增加数量或撤销时可找回。</p>
        <div>{draft.slots.map((item, index) => <label key={item.id}><input type="checkbox" checked={retained.includes(item.id)} onChange={event => setRetained(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} />第 {index + 1} 张{item.manual ? ' · 已手选' : ''}</label>)}</div>
        <button className={styles.primary} type="button" disabled={retained.length !== reduceCount} onClick={() => {
          update({ ...draft, slots: draft.slots.filter(item => retained.includes(item.id)), reserve: [...draft.slots.filter(item => !retained.includes(item.id)), ...draft.reserve].slice(0, 16), editing: null }, true); setReduceCount(null);
        }}>保留所选 {retained.length} 张</button><button type="button" onClick={() => setReduceCount(null)}>取消</button>
      </section>}
      <div className={styles.board} style={{ '--columns': Math.min(draft.layout.columns, draft.slots.length) } as CSSProperties}>
        {draft.slots.map((item, index) => <article key={item.id} className={styles.card} data-editing={draft.editing === item.id || undefined}>
          <button type="button" className={styles.image} style={{ aspectRatio: `${info.width}/${info.height}`, background: draft.layout.background }} disabled={!frames[item.frame]?.url} onClick={() => setPreview(item.frame)} aria-label={`预览第 ${index + 1} 张`}>
            {frames[item.frame]?.url ? <img src={frames[item.frame].url} alt={item.name || `第 ${index + 1} 张候选图`} /> : <span>{frames[item.frame]?.error ? '这一帧未就绪' : '正在提取候选图片…'}</span>}
          </button>
          <div className={styles.cardTitle}><strong>第 {index + 1} 张</strong><small>{info.timestamps[item.frame].toFixed(3)} 秒{item.manual ? ' · 已手选' : ''}</small></div>
          <input aria-label={`第 ${index + 1} 张方向名称`} placeholder="方向名称（可选）" maxLength={40} value={item.name} disabled={exporting}
            onChange={event => update({ ...draft, slots: draft.slots.map(value => value.id === item.id ? { ...value, name: event.target.value } : value) })} />
          <div className={styles.cardActions}><button type="button" disabled={exporting} onClick={() => openEditor(item)}>换一帧</button>
            <button type="button" disabled={exporting || index === 0} title="向前移动" aria-label={`第 ${index + 1} 张向前移动`} onClick={() => move(index, -1)}><ArrowLeft size={15} /></button>
            <button type="button" disabled={exporting || index === draft.slots.length - 1} title="向后移动" aria-label={`第 ${index + 1} 张向后移动`} onClick={() => move(index, 1)}><ArrowRight size={15} /></button></div>
          {frames[item.frame]?.error && <div className={styles.frameError} role="status">{frames[item.frame].error}<button type="button" onClick={() => void loadFrame(item.frame, true)}><RefreshCw size={13} />重试这一格</button></div>}
        </article>)}
      </div>
      {editing && <section className={styles.editor} aria-label="单格换帧">
        <header><h2>替换第 {draft.slots.indexOf(editing) + 1} 张</h2><button type="button" aria-label="取消换帧" onClick={() => update({ ...draft, editing: null })}><X size={18} /></button></header>
        <div className={styles.editorBody}><div className={styles.candidate}>{currentFrame?.url ? <img src={currentFrame.url} alt="待选帧预览" /> : <p>{currentFrame?.error || '正在读取这一帧…'}</p>}</div>{player}</div>
        <label className={styles.timeline}>帧位置：{editorFrame + 1} / {info.timestamps.length} · {info.timestamps[editorFrame].toFixed(3)} 秒
          <input aria-label="选择视频帧" type="range" min={0} max={info.timestamps.length - 1} step={1} value={editorFrame} onChange={event => seek(Number(event.target.value))} />
        </label>
        <div className={styles.neighbors}>{[-2, -1, 0, 1, 2].map(delta => editorFrame + delta).filter(frame => frame >= 0 && frame < info.timestamps.length).map(frame => <button type="button" key={frame} aria-pressed={frame === editorFrame} onClick={() => seek(frame)}>
          {frames[frame]?.url && <img src={frames[frame].url} alt={`邻近第 ${frame + 1} 帧`} />}<span>{frame === editorFrame ? '当前' : frame < editorFrame ? `前 ${editorFrame - frame} 帧` : `后 ${frame - editorFrame} 帧`}</span></button>)}</div>
        <footer><button type="button" disabled={editorFrame === 0} onClick={() => seek(editorFrame - 1)}>上一帧</button><button type="button" disabled={editorFrame === info.timestamps.length - 1} onClick={() => seek(editorFrame + 1)}>下一帧</button>
          {currentFrame?.error && <button type="button" onClick={() => void loadFrame(editorFrame, true)}>重试此帧</button>}
          <button className={styles.primary} type="button" disabled={!currentFrame?.url || exporting} onClick={() => {
            video.current?.pause(); update({ ...draft, slots: draft.slots.map(item => item.id === editing.id ? { ...item, frame: editorFrame, manual: true } : item), editing: null }, true);
          }}>使用这一帧</button><button type="button" onClick={() => update({ ...draft, editing: null })}>取消</button></footer>
      </section>}
      {validSlots.length > 0 && validSlots.length < draft.slots.length && <div className={styles.partial}><span>有图片尚未就绪，可重试单格，或仅导出已就绪的 {validSlots.length} 张。</span><button type="button" disabled={exporting} onClick={() => setPartialFormat('png')}>仅导出可用拼图</button><button type="button" disabled={exporting} onClick={() => setPartialFormat('zip')}>仅下载可用单图</button>
        {partialFormat && <div className={styles.partialPreview}>{collagePreview(validSlots)}<button className={styles.primary} type="button" disabled={exporting} onClick={() => void prepareExport(partialFormat, true)}>确认这 {validSlots.length} 张，准备文件</button><button type="button" onClick={() => setPartialFormat(null)}>取消</button></div>}
      </div>}
      <details className={styles.settings}><summary>排版</summary><div className={styles.settingsFields}>
        <label>拼图列数<select value={draft.layout.columns} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, columns: Number(event.target.value) } })}>{[1, 2, 3, 4, 8].map(value => <option key={value} value={value}>{value} 列</option>)}</select></label>
        <label>外侧留白<input type="number" min={0} max={128} step={1} value={draft.layout.margin} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, margin: Math.round(Math.max(0, Math.min(128, Number(event.target.value) || 0))) } })} /></label>
        <label>图片间距<input type="number" min={0} max={128} step={1} value={draft.layout.gap} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, gap: Math.round(Math.max(0, Math.min(128, Number(event.target.value) || 0))) } })} /></label>
        <label>留白底色<input type="color" value={draft.layout.background} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, background: event.target.value } })} /></label>
        <button type="button" disabled={exporting} onClick={() => update({ ...draft, layout: { ...DEFAULT_MULTIVIEW_LAYOUT } }, true)}>重置排版</button>
      </div><p>底色只作用于拼图留白，不会去掉视频背景。原图保持原尺寸。</p>{collagePreview(draft.slots)}</details>
      {!editing && <details className={styles.original} open={originalOpen} onToggle={event => setOriginalOpen(event.currentTarget.open)}><summary>查看原视频</summary>{originalOpen && player}</details>}
      <p className={styles.footnote}>选帧草稿仅存此设备、此账号。原视频权限失效时停止显示；临时图片过期后可重新提取，不会重跑生成。</p>
      {preview !== null && frames[preview]?.url && <ZoomableImagePreview src={frames[preview].url!} alt="多角度候选图片" imageSharing={false} sourceVersion={info.sourceVersion}
        previewKey={`multiview-${taskId}-${preview}`} onClose={() => setPreview(null)} safeDetails={{ width: info.width, height: info.height }} />}
    </>}
    {productDialog}
  </div>;
}
