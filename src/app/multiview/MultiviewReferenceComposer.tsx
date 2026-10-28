'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, Copy, Download, LockKeyhole, Move, Undo2, Redo2, UnlockKeyhole } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { DEFAULT_CUTOUT_SETTINGS } from '@/lib/cutout/settings';
import { copyPngBlob } from '@/lib/media/copy-image';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { readJsonResponse } from '@/lib/http/json-response';
import { createMultiviewReferenceRecipe, referencePixelGeometry, resizeMultiviewReference, referencePanels, moveReferencePlacements, scaleReferencePlacements,
  type ReferenceLayout, type ReferencePlacement, type ReferenceScaleCorner } from '@/lib/video/multiview-reference-layout';
import { MULTIVIEW_SAVE_PROTOCOL, parseMultiviewWorkRecipe, type MultiviewReferenceRecipe, type MultiviewWorkDto, type MultiviewSourceAccess } from '@/lib/video/multiview-work-contract';
import type { MultiviewInfo, MultiviewSlot } from '@/lib/video/multiview-contract';
import { MultiviewActionPanel } from './MultiviewActionPanel';
import styles from './multiview-action.module.css';

type Props = { ownerId: string; authority: string; taskId: string; info: MultiviewInfo; slots: MultiviewSlot[];
  mediaBase: string; initialWorkId?: string; videoDefaults?: {model:string;duration:number;resolution:string;projectId:string;videoCardId:string|null}; access?: MultiviewSourceAccess; onWorkBound(id:string):void; onBack(): void };
type BackgroundState = { stage: string; message: string; priceMessage?: string; resultUrl?: string | null; foreground?: MultiviewReferenceRecipe['foregrounds'][number] | null };
type Pending = { mutationId: string; workId: string | null; signature: string };
const dimensions = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1536, 1536] } as const;
export function MultiviewReferenceComposer(props: Props) {
  const key = `sd2:multiview-reference:v3:${props.ownerId}:${props.taskId}:${props.info.sourceVersion}:${props.initialWorkId || props.slots.map(slot => slot.id).join(',')}`;
  const [recipe, setRecipe] = useState<MultiviewReferenceRecipe>(() => createMultiviewReferenceRecipe(props.info, props.slots, { width: 1920, height: 1080, background: '#d6dbdf' }));
  const [referenceKey, setReferenceKey] = useState('');
  const [work, setWork] = useState<MultiviewWorkDto | null>(null);
  const [selected, setSelected] = useState(props.slots[0]?.id || '');
  const [history, setHistory] = useState<MultiviewReferenceRecipe[]>([]), [future, setFuture] = useState<MultiviewReferenceRecipe[]>([]);
  const [hydrated, setHydrated] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [pending, setPending] = useState<Pending | null>(null), [blocked, setBlocked] = useState(false);
  const { confirm, productDialog } = useProductDialog();
  const [backgrounds, setBackgrounds] = useState<Record<string,BackgroundState>>({}), [backgroundBusy, setBackgroundBusy] = useState('');
  const [showStyle, setShowStyle] = useState(false), [precise, setPrecise] = useState(false);
  const [syncAdjust, setSyncAdjust] = useState(false), [dragging, setDragging] = useState(false);
  const [activeView, setActiveView] = useState<'reference' | 'video'>('reference');
  const recipeRef = useRef(recipe); recipeRef.current = recipe;
  const workRef = useRef(work); workRef.current = work;
  const live = useRef(props); live.current = props;
  const identity = `${props.ownerId}:${props.authority}:${props.taskId}:${props.info.sourceVersion}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const numericGesture = useRef<MultiviewReferenceRecipe | null>(null);
  const lock = useRef(false), canvas = useRef<HTMLDivElement>(null), saved = useRef('');
  const drag = useRef<{ id: string; pointer: number; target: Element; x: number; y: number; rectWidth: number; rectHeight: number; start: MultiviewReferenceRecipe; synchronized: boolean; mode: 'move' | 'scale'; corner: ReferenceScaleCorner } | null>(null);
  const headers = useCallback(() => ({ 'Content-Type': 'application/json', 'x-app-session-user': props.ownerId }), [props.ownerId]);
  const valid = (scope = identity) => currentIdentity.current === scope && !isClientSessionBlocked();
  const signature = JSON.stringify(recipe);
  const ready = Boolean(work?.ready && work.ready.revision === work.draftRevision && saved.current === signature && work.status === 'ready');
  const collage = ready ? work?.ready?.files.find(file => file.role === 'collage') : null;
  const ratio = recipe.output.width === recipe.output.height ? '1:1' : recipe.output.width > recipe.output.height ? '16:9' : '9:16';
  const geometry = referencePixelGeometry(recipe, props.info);
  function edit(next: MultiviewReferenceRecipe, undo = true) {
    if (!valid() || JSON.stringify(next) === JSON.stringify(recipeRef.current)) return;
    if (undo) { setHistory(values => [...values.slice(-29), recipeRef.current]); setFuture([]); }
    recipeRef.current = next; setRecipe(next); setMessage('');
  }
  const readWork = useCallback(async (id: string) => {
    const response = await fetch(`/api/video/multiview/works/${encodeURIComponent(id)}`, { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(30000) });
    const value = await readJsonResponse<{ work: MultiviewWorkDto; error?: string }>(response);
    if (!response.ok || !value.work || value.work.recipe?.schema !== 3) throw new Error(value.error || '参考拼图暂不可读取，当前编辑保留。');
    return value.work;
  }, [headers]);
  useEffect(() => {
    let cancelled = false; const scope = identity; setHydrated(false); setSyncAdjust(false); setDragging(false);
    const previousDrag = drag.current; drag.current = null; numericGesture.current = null; setHistory([]); setFuture([]);
    if (previousDrag?.target.hasPointerCapture(previousDrag.pointer)) previousDrag.target.releasePointerCapture(previousDrag.pointer);
    void (async () => {
      try {
        const raw = localStorage.getItem(key); const stored = raw ? JSON.parse(raw) : null;
        const id = props.initialWorkId || stored?.workId;
        const local = stored?.recipe ? parseMultiviewWorkRecipe(stored.recipe, props.info) : null;
        const next = id ? await readWork(id) : null;
        if (cancelled || !valid(scope)) return;
        const restored = local?.schema === 3 ? local : next?.recipe?.schema === 3 ? next.recipe : recipeRef.current;
        recipeRef.current = restored; setRecipe(restored); setSelected(restored.slots[0]?.id || '');
        setSyncAdjust(stored?.syncAdjust === true);
        setReferenceKey(typeof stored?.referenceKey === 'string' ? stored.referenceKey : crypto.randomUUID());
        if (next) { setWork(next); saved.current = JSON.stringify(next.recipe); if(local && stored?.baseRevision !== undefined && stored.baseRevision !== next.revision && JSON.stringify(local)!==JSON.stringify(next.recipe)){setBlocked(true);setMessage('作品已在另一处更新，当前排版保留，请先核对最新版本。');} }
        if (stored?.pending) setPending(stored.pending);
        const preference = localStorage.getItem(`sd2:multiview-reference-style:${props.ownerId}`);
        if (!local && !next && preference) { const style = JSON.parse(preference); if (/^#[a-f0-9]{6}$/i.test(style.background)) restored.output.background = style.background; if (typeof style.divider === 'boolean') restored.divider.enabled = style.divider; setRecipe({ ...restored }); }
        setHydrated(true);
      } catch (cause) { if (!cancelled && valid(scope)) { setBlocked(true); setMessage(cause instanceof Error ? cause.message : '参考拼图恢复未完成，请保留当前页面。'); } }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, key, readWork]);
  useEffect(()=>{if(!work?.id)return;live.current.onWorkBound(work.id);const url=new URL(window.location.href);url.searchParams.set('referenceWorkId',work.id);window.history.replaceState(window.history.state,'',url.pathname+url.search);},[work?.id]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      const retained=JSON.stringify({ recipe, referenceKey, workId: work?.id || null, baseRevision:work?.revision, pending, syncAdjust });
      localStorage.setItem(key, retained);
      if(work?.id)localStorage.setItem(`sd2:multiview-reference:v3:${props.ownerId}:${props.taskId}:${props.info.sourceVersion}:${work.id}`,retained);
      localStorage.setItem(`sd2:multiview-reference-style:${props.ownerId}`, JSON.stringify({ background: recipe.output.background, divider: recipe.divider.enabled }));
    } catch { setBlocked(true); setMessage('当前排版暂不能在本机保留，请保留页面。'); }
  }, [hydrated, key, recipe, referenceKey, work?.id, pending, props.ownerId, syncAdjust]);
  async function queryOriginal() {
    if (!pending || lock.current) return;
    const scope = identity; lock.current = true; setBusy(true);
    try {
      const response = await fetch(`/api/video/multiview/works/mutations/${encodeURIComponent(pending.mutationId)}`, { headers: headers(), cache: 'no-store' });
      const receipt = await readJsonResponse<{ workId?: string; mutationId?: string }>(response);
      if (!valid(scope)) return;
      if (!response.ok || receipt.mutationId !== pending.mutationId || !receipt.workId) throw new Error('原保存结果待确认，请继续查询原号。');
      const next = await readWork(receipt.workId); if (!valid(scope)) return;
      saved.current = pending.signature; setWork(next); setPending(null); setMessage('');
    } catch (cause) { if (valid(scope)) setMessage(cause instanceof Error ? cause.message : '原保存结果待确认。'); }
    finally { lock.current = false; if (valid(scope)) setBusy(false); }
  }
  async function prepare() {
    if (!hydrated || blocked || pending || lock.current || saved.current === signature && work?.status !== 'failed') return;
    const scope = identity, frozen = recipeRef.current, serialized = JSON.stringify(frozen), original = workRef.current;
    lock.current = true; setBusy(true); setMessage('');
    const mutation: Pending = { mutationId: crypto.randomUUID(), workId: original?.id || null, signature: serialized };
    let sent = false;
    try {
      const body = original ? { protocol: MULTIVIEW_SAVE_PROTOCOL, mutationId: mutation.mutationId, action: 'save', baseRevision: original.revision, recipe: frozen, title: original.title }
        : { protocol: MULTIVIEW_SAVE_PROTOCOL, mutationId: mutation.mutationId, referenceKey, taskId: props.taskId, sourceVersion: props.info.sourceVersion, recipe: frozen, title: '动作参考拼图', ...(props.access?.kind === 'work' ? { sourceWorkId: props.access.id } : {}) };
      localStorage.setItem(key, JSON.stringify({ recipe: frozen, referenceKey, workId: original?.id || null, baseRevision:original?.revision,pending: mutation,syncAdjust }));
      setPending(mutation); sent = true;
      const response = await fetch(original ? `/api/video/multiview/works/${original.id}` : '/api/video/multiview/works', { method: original ? 'PATCH' : 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const value = await readJsonResponse<{ work?: MultiviewWorkDto; workId?: string; receipt?: { mutationId: string }; error?: string; notCommitted?: boolean }>(response);
      if (!valid(scope)) return;
      if (!response.ok || !value.work || value.receipt?.mutationId !== mutation.mutationId) {
        if (value.notCommitted === true) { setPending(null); setBlocked(true); if(value.workId){const latest=await readWork(value.workId);if(valid(scope))setWork(latest);} throw new Error(value.error || '本次保存未受理，当前排版保留。'); }
        throw new Error('保存结果待确认，请查询原保存。');
      }
      saved.current = serialized; setWork(value.work); setPending(null);
    } catch (cause) { if (valid(scope)) { if (!sent) setBlocked(true); setMessage(cause instanceof Error ? cause.message : '拼图准备未完成，当前编辑保留。'); } }
    finally { lock.current = false; if (valid(scope)) setBusy(false); }
  }
  useEffect(() => { if (!hydrated || busy || blocked || pending || drag.current || saved.current === signature) return; const timer = setTimeout(() => void prepare(), 650); return () => clearTimeout(timer); });
  useEffect(() => {
    if (!work || !['waiting_source', 'queued', 'rendering'].includes(work.status)) return;
    const scope = identity; let cancelled = false;
    const timer = setTimeout(() => { void readWork(work.id).then(next => { if (!cancelled && valid(scope)) {if(next.revision!==work.revision&&JSON.stringify(next.recipe)!==saved.current){setBlocked(true);setMessage('作品已在另一处更新，当前排版保留，请核对最新版本。');}setWork(next);} }).catch(cause => { if (!cancelled && valid(scope)) setMessage(cause.message); }); }, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [work, identity, readWork]);
  function start(event: PointerEvent, id: string, mode: 'move' | 'scale', corner: ReferenceScaleCorner = 'se') {
    if (busy || !hydrated || drag.current || !canvas.current || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setSelected(id); setDragging(true);
    const rect = canvas.current.getBoundingClientRect(); drag.current = { id, pointer: event.pointerId, target: event.currentTarget, x: event.clientX, y: event.clientY, rectWidth: rect.width, rectHeight: rect.height, start: recipeRef.current, synchronized: syncAdjust, mode, corner };
  }
  function moving(event: PointerEvent) {
    const operation = drag.current; if (!operation || operation.pointer !== event.pointerId) return;
    const dx = event.clientX - operation.x, dy = event.clientY - operation.y;
    const placement = operation.start.placements.find(item => item.slotId === operation.id)!;
    const width = placement.width * operation.rectWidth, height = placement.height * operation.rectHeight;
    const factor = 1 + (dx * (operation.corner.includes('w') ? -1 : 1) * width + dy * (operation.corner.includes('n') ? -1 : 1) * height) / (width * width + height * height);
    const placements = operation.mode === 'move'
      ? moveReferencePlacements(operation.start, operation.id, dx / operation.rectWidth, dy / operation.rectHeight, operation.synchronized)
      : scaleReferencePlacements(operation.start, operation.id, factor, operation.corner, operation.synchronized);
    edit({ ...recipeRef.current, placements }, false);
  }
  function releaseDrag() {
    const operation = drag.current; if (!operation) return null; drag.current = null; setDragging(false);
    if (operation.target.hasPointerCapture(operation.pointer)) operation.target.releasePointerCapture(operation.pointer);
    return operation;
  }
  function cancelDrag() {
    const operation = releaseDrag(); if (operation) edit({ ...recipeRef.current, placements: operation.start.placements }, false);
  }
  function finish(event: PointerEvent, cancel = false) {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    if (cancel) { cancelDrag(); return; }
    const operation = releaseDrag()!;
    if (JSON.stringify(operation.start.placements) === JSON.stringify(recipeRef.current.placements)) return;
    setHistory(values => [...values.slice(-29), { ...recipeRef.current, placements: operation.start.placements }]); setFuture([]);
  }
  function adjust(change: Partial<ReferencePlacement>, record = true, id = selected) {
    const current = recipeRef.current, placement = current.placements.find(item => item.slotId === id); if (!placement || drag.current) return;
    let placements = typeof change.width === 'number' ? scaleReferencePlacements(current, id, change.width / placement.width, 'center', syncAdjust) : current.placements;
    const resized = placements.find(item => item.slotId === id)!;
    placements = moveReferencePlacements({ ...current, placements }, id, typeof change.x === 'number' ? change.x - resized.x : 0, typeof change.y === 'number' ? change.y - resized.y : 0, syncAdjust);
    edit({ ...current, placements }, record);
  }
  function resetPlacement() {
    if (drag.current) return;
    const current = recipeRef.current, ratio = props.info.width / props.info.height * current.output.height / current.output.width;
    edit({ ...current, placements: current.placements.map(item => {
      if (!syncAdjust && item.slotId !== selected) return item;
      const panel = current.panels.find(value => value.slotId === item.slotId)!, width = Math.min(panel.width, panel.height * ratio) * .94, height = width / ratio;
      return { ...item, width, height, x: panel.x + (panel.width - width) / 2, y: panel.y + (panel.height - height) / 2 };
    }) });
  }
  function finishNumericGesture() {
    const original = numericGesture.current; numericGesture.current = null;
    if (!original || JSON.stringify(original.placements) === JSON.stringify(recipeRef.current.placements)) return;
    setHistory(values => [...values.slice(-29), { ...recipeRef.current, placements: original.placements }]); setFuture([]);
  }
  async function output(copy: boolean) {
    if (!collage) return;
    const scope = identity; setMessage('');
    const png = (async()=>{ const response = await fetch(collage.url, { cache: 'no-store', headers: headers() }); if (!response.ok) throw new Error('成品暂不可读取。'); const blob = await response.blob(); if (!valid(scope)) throw new Error('当前拼图已变化，输出已取消。'); return blob; })();
    try {
      if (copy) { await copyPngBlob(png); if(valid(scope))setMessage('已复制图片。'); }
      else { const blob=await png;const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = '动作参考拼图.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (cause) { if (valid(scope)) setMessage(cause instanceof Error ? cause.message : '图片未交付，可改用下载PNG。'); }
  }

  async function background(slotId: string, start = false) {
    if (!work || backgroundBusy) return;
    const scope = identity; setBackgroundBusy(slotId); setMessage('');
    const url = `/api/video/multiview/works/${work.id}/slots/${slotId}/cutout`;
    const call = async (body?: unknown) => {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
      const value = await readJsonResponse<BackgroundState & { error?: string }>(response);
      if (!response.ok) throw new Error(value.error || '背景处理暂不可用，原图保留。');
      return value;
    };
    try {
      let value = await call();
      if (!valid(scope)) return;
      if (start && ['import-ready','awaiting-confirmation','not-submitted'].includes(value.stage)) {
        if (value.stage === 'import-ready') value = await call({action:'prepare'});
        if (!valid(scope)) return;
        if (value.stage === 'awaiting-confirmation' || value.stage === 'not-submitted') {
          setBackgrounds(current => ({ ...current, [slotId]: value }));
          if (!await confirm(value.priceMessage || '抠图服务费用尚未核实。确认后只处理这一张图片。', {title:'处理背景',confirmLabel:'确认处理本张'})) return;
          if (!valid(scope)) return;
          value = await call({action:'start',settings:DEFAULT_CUTOUT_SETTINGS,confirmUnknownPrice:true});
        }
      }
      if (!valid(scope)) return;
      setBackgrounds(current => ({ ...current, [slotId]: value }));
      if (value.foreground && !recipeRef.current.foregrounds.some(item => item.slotId === slotId && item.sha256 === value.foreground!.sha256)) {
        const current = recipeRef.current;
        edit({ ...current, foregrounds: [...current.foregrounds.filter(item => item.slotId !== slotId), value.foreground] });
      }
    } catch (cause) { if (valid(scope)) setMessage(cause instanceof Error ? cause.message : '背景处理结果待确认，请查询原任务。'); }
    finally { if (valid(scope)) setBackgroundBusy(''); }
  }
  useEffect(() => {
    if (!work) return;
    let cancelled = false;
    void (async () => { for (const slot of recipeRef.current.slots) {
      if (cancelled || !valid()) return;
      try { const response = await fetch(`/api/video/multiview/works/${work.id}/slots/${slot.id}/cutout`, { headers: headers(), cache:'no-store' }); const value = await response.json();
        if (response.ok && !cancelled && valid()) setBackgrounds(current => ({...current,[slot.id]:value}));
      } catch { /* Current source and original processing IDs remain intact. */ }
    } })();
    return () => { cancelled = true; };
  }, [work?.id]);
  useEffect(()=>{const waiting=Object.entries(backgrounds).find(([,value])=>value.stage==='accepted');if(!waiting||backgroundBusy)return;const timer=setTimeout(()=>void background(waiting[0]),4000);return()=>clearTimeout(timer);});
  const placement = recipe.placements.find(item => item.slotId === selected);
  const layoutOptions: Array<[ReferenceLayout, string]> = recipe.slots.length === 2 ? [['horizontal', '左右分屏'], ['vertical', '上下分屏']] : recipe.slots.length === 3 ? [['large-left', '左一右二'], ['large-top', '上一下二'], ['equal', '均分']] : [['grid', '四宫格']];
  return <section className={styles.referenceWorkspace} aria-label="动作视频工作区">
    {productDialog}<header className={styles.topbar}><button type="button" onClick={props.onBack}><ArrowLeft size={15} />返回选帧</button><div role="group" aria-label="当前画面"><button aria-pressed={activeView === 'reference'} onClick={() => setActiveView('reference')}>参考拼图</button><button aria-pressed={activeView === 'video'} onClick={() => setActiveView('video')}>视频</button></div></header>
    <div className={styles.continuous}>
      <div className={styles.visual} hidden={activeView === 'video'}>
        <div className={styles.compact}><span>{recipe.slots.length} 个镜头</span><label>画幅<select value={ratio} onChange={event => { const [width,height] = dimensions[event.target.value as keyof typeof dimensions]; edit(resizeMultiviewReference(recipe, props.info, { ...recipe.output, width, height })); }}><option>16:9</option><option>9:16</option><option>1:1</option></select></label><label>排版<select onChange={event => edit(resizeMultiviewReference(recipe, props.info, recipe.output, event.target.value as ReferenceLayout))} value={layoutOptions.find(([name])=>JSON.stringify(referencePanels(recipe.slots,name))===JSON.stringify(recipe.panels))?.[0]||layoutOptions[0][0]}>{layoutOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>背景<input type="color" value={recipe.output.background} onChange={event => edit({ ...recipe, output: { ...recipe.output, background: event.target.value } })} /></label><label><input type="checkbox" checked={recipe.divider.enabled} onChange={event => edit({ ...recipe, divider: { ...recipe.divider, enabled: event.target.checked } })} />分隔线</label>{recipe.divider.enabled && <button type="button" onClick={() => setShowStyle(value => !value)}>样式</button>}</div>
        {showStyle && recipe.divider.enabled && <div className={styles.compact}><label>线色<input type="color" value={recipe.divider.color} onChange={event => edit({ ...recipe, divider: { ...recipe.divider, color: event.target.value } })} /></label><label>线宽<input type="number" min={1} max={24} value={recipe.divider.widthPx} onChange={event => edit({ ...recipe, divider: { ...recipe.divider, widthPx: Number(event.target.value) } })} />px</label></div>}
        <div ref={canvas} className={styles.referenceCanvas} data-dragging={dragging || undefined} style={{ aspectRatio: `${geometry.width}/${geometry.height}`, background: recipe.output.background }}>
          <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="img" aria-label={`${recipe.slots.length}镜头参考拼图`}>
            {geometry.placements.map(item => { const slot = recipe.slots.find(slot => slot.id === item.slotId)!, foreground = recipe.foregrounds.find(value => value.slotId === slot.id);
              return <image key={item.slotId} href={foreground ? backgrounds[slot.id]?.resultUrl || undefined : `${props.mediaBase}?version=${props.info.sourceVersion}&frame=${slot.frame}`} x={item.x} y={item.y} width={item.width} height={item.height} preserveAspectRatio="xMidYMid meet" />; })}
            {recipe.divider.enabled && <path d={geometry.dividers.map(line => `M${line.x1},${line.y1}L${line.x2},${line.y2}`).join(' ')} stroke={recipe.divider.color} strokeWidth={recipe.divider.widthPx} fill="none" />}
          </svg>
          {recipe.placements.map(item => <div key={item.slotId} className={styles.subjectControl} data-selected={item.slotId === selected || undefined} style={{ left: `${item.x*100}%`, top: `${item.y*100}%`, width: `${item.width*100}%`, height: `${item.height*100}%` }} onClick={() => setSelected(item.slotId)} onPointerDown={event => { if (event.pointerType === 'mouse' && event.target === event.currentTarget) start(event,item.slotId,'move'); }} onPointerMove={moving} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event,true)} onLostPointerCapture={event => finish(event,true)} onKeyDown={event => { if(event.key==='Escape'&&drag.current){event.preventDefault();cancelDrag();return;} if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); setSelected(item.slotId); const step = (event.shiftKey ? 10 : 1); adjust({ x: item.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0)/geometry.width, y: item.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)/geometry.height }, true, item.slotId); } }} tabIndex={0} role="group" aria-label={`镜头${recipe.slots.findIndex(slot => slot.id === item.slotId)+1}主体`}>
            <button type="button" className={styles.moveHandle} aria-label="移动此镜头主体" onPointerDown={event => start(event,item.slotId,'move')}><Move size={16} /></button>
            {(['nw','ne','sw','se'] as const).map(corner=><button key={corner} type="button" className={styles.scaleHandle} data-corner={corner} aria-label="等比缩放此镜头主体" onPointerDown={event => start(event,item.slotId,'scale',corner)}>{corner==='nw'?'↖':corner==='ne'?'↗':corner==='sw'?'↙':'↘'}</button>)}
          </div>)}
        </div>
        <div className={styles.compact}><small>{geometry.width} × {geometry.height}</small><span className={styles.spacer} /><button type="button" disabled={dragging || !history.length} onClick={() => { const next=history[history.length-1]; setHistory(value=>value.slice(0,-1));setFuture(value=>[recipe,...value]);edit(next,false); }}><Undo2 size={14}/>撤销</button><button type="button" disabled={dragging || !future.length} onClick={() => { const next=future[0];setFuture(value=>value.slice(1));setHistory(value=>[...value,recipe]);edit(next,false); }}><Redo2 size={14}/>重做</button></div>
        <div className={styles.compact}><button type="button" className={styles.syncAdjust} aria-pressed={syncAdjust} disabled={!hydrated || dragging} title={syncAdjust ? '一起移动和缩放所有镜头主体' : '只调整当前镜头主体'} onClick={()=>setSyncAdjust(value=>!value)}>{syncAdjust ? <LockKeyhole size={14}/> : <UnlockKeyhole size={14}/>}同步调整</button><span>镜头 {recipe.slots.findIndex(slot=>slot.id===selected)+1}</span>{placement && <><button onClick={()=>adjust({x:placement.x-2/geometry.width})} aria-label="向左微移">←</button><button onClick={()=>adjust({x:placement.x+2/geometry.width})} aria-label="向右微移">→</button><button onClick={()=>adjust({y:placement.y-2/geometry.height})} aria-label="向上微移">↑</button><button onClick={()=>adjust({y:placement.y+2/geometry.height})} aria-label="向下微移">↓</button><span>大小</span><button onClick={()=>adjust({width:placement.width*.95})}>−</button><button onClick={()=>adjust({width:placement.width*1.05})}>＋</button><button onClick={()=>setPrecise(value=>!value)}>精调</button><button onClick={resetPlacement}>{syncAdjust ? '全部复位' : '复位'}</button></>}</div>
        {precise && placement && <div className={styles.compact}>{(['x','y','width'] as const).map(field=><label key={field}>{field==='width'?'宽度':field.toUpperCase()}<input type="number" value={Math.round(placement[field]*(field==='y'?geometry.height:geometry.width))} onFocus={()=>{numericGesture.current=recipeRef.current;}} onChange={event=>adjust({[field]:Number(event.target.value)/(field==='y'?geometry.height:geometry.width)},false)} onBlur={finishNumericGesture} />px</label>)}</div>}
        <div className={styles.compact}>{recipe.slots.map((slot,index)=><button type="button" key={slot.id} aria-pressed={selected===slot.id} onClick={()=>setSelected(slot.id)}>镜头 {index+1}</button>)}<button type="button" onClick={()=>{ const fresh=createMultiviewReferenceRecipe(props.info,recipe.slots,recipe.output);edit({...fresh,divider:recipe.divider,foregrounds:recipe.foregrounds}); }}>恢复推荐排版</button></div>
        <div className={styles.compact} aria-label="背景处理，可选">{recipe.foregrounds.length === recipe.slots.length ? <span>透明前景已就绪</span> : recipe.foregrounds.length ? <span>已处理背景 {recipe.foregrounds.length}/{recipe.slots.length}</span> : <span>保留原背景</span>}{selected && <button type="button" disabled={!work || Boolean(backgroundBusy)} onClick={()=>void background(selected,true)}>{backgroundBusy===selected?'正在核对…':backgrounds[selected] && ['accepted','unknown','submitting','preparing'].includes(backgrounds[selected].stage)?'查询本张处理':'处理本张背景'}</button>}{backgrounds[selected]?.message && <span className={styles.notice}>{backgrounds[selected].message}</span>}</div>
        <div className={styles.compact}><button disabled={!collage} onClick={()=>void output(true)}><Copy size={14}/>复制图片</button><button disabled={!collage} onClick={()=>void output(false)}><Download size={14}/>下载PNG</button><button disabled={!collage} onClick={async()=>{try{const response=await fetch(`/api/video/multiview/works/${work!.id}/files/collage/asset`,{headers:headers(),cache:'no-store'});const value=await response.json();if(!response.ok)throw new Error(value.error);setMessage('已保存到我的素材。');}catch(cause){setMessage(cause instanceof Error?cause.message:'素材登记尚未完成。');}}}>保存素材</button></div>
        <div role="status" className={styles.notice}>{pending ? <>保存结果待确认 <button onClick={()=>void queryOriginal()}>查询原保存</button></> : busy || work && ['queued','rendering','waiting_source'].includes(work.status) ? '正在准备拼图…' : work?.status === 'failed' ? <>{work.lastError || '拼图准备失败'}<button onClick={()=>void prepare()}>重新准备</button></> : ''}{message}{blocked && <button onClick={async()=>{try{if(work){const latest=await readWork(work.id);if(!valid())return;setWork(latest);}setBlocked(false);setMessage('已核对最新版本，当前排版保留。');}catch(cause){setMessage(cause instanceof Error?cause.message:'最新版本暂不可读取。');}}}>核对最新并保留排版</button>}</div>
      </div>
      <MultiviewActionPanel ownerId={props.ownerId} authority={props.authority} work={work} videoDefaults={props.videoDefaults} outputReady={ready} ratio={ratio} activeView={activeView} onView={setActiveView} />
    </div>
  </section>;
}
