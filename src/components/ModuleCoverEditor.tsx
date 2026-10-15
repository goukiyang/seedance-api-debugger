'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Cropper, { type Area } from 'react-easy-crop';
import { ArrowLeftRight, ImagePlus, RotateCcw, Save, X } from 'lucide-react';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import type { ModuleCoverDTO, ModuleCoverCrop, ModuleCoverEditorState, ModuleCoverLayout, ModuleCoverRecipe, ModuleCoverRequestResult, ModuleCoverSaveInput, ModuleCoverSaveResult, ModuleCoverSourceDTO } from '@/lib/image-studio/module-cover-types';
import styles from './ModuleCoverEditor.module.css';

type Slot = { source: ModuleCoverSourceDTO; crop?: ModuleCoverCrop; restore?: ModuleCoverCrop; key: number } | null;
const layouts: Array<[ModuleCoverLayout, string]> = [['single', '单图'], ['horizontal', '左右'], ['vertical', '上下']];
const output = { width: 1280, height: 960 } as const;
// Keep the v0.89 editor as a viewer on guard; only the original accepted body may be retried.
const guardReadOnly = true;

async function json<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) throw Object.assign(new Error(value?.error || '暂时无法确认，请重试'), { status: response.status });
  return value as T;
}

function CropSlot({ slot, aspect, disabled, onCrop, onInteract }: { slot: NonNullable<Slot>; aspect: number; disabled: boolean; onCrop: (crop: ModuleCoverCrop) => void; onInteract: () => void }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  return <div className={styles.cropSlot} aria-disabled={disabled || undefined}>
    <Cropper image={slot.source.previewUrl} crop={position} zoom={zoom} aspect={aspect} maxZoom={12}
      initialCroppedAreaPercentages={slot.restore} onCropChange={value => { if (!disabled) setPosition(value); }} onZoomChange={value => { if (!disabled) setZoom(value); }}
      onCropComplete={(area: Area) => onCrop(area)} onInteractionStart={onInteract}
      onWheelRequest={() => !disabled} onTouchRequest={() => !disabled}
      showGrid={!disabled} keyboardStep={5} cropperProps={{ tabIndex: disabled ? -1 : 0, 'aria-label': '拖动图片选择封面局部，可用方向键微调' }}
      mediaProps={{ onError: () => setFailed(true), onLoad: () => setFailed(false) }} />
    {failed && <span className={styles.imageError}>图片无法读取，请重新选择</span>}
    <label className={styles.zoom}>缩放<input type="range" min="1" max="12" step="0.01" value={zoom} disabled={disabled || failed}
      onChange={event => { onInteract(); setZoom(Number(event.target.value)); }} aria-label="封面图片缩放" /></label>
  </div>;
}

function CropPreview({ slot }: { slot: Slot }) {
  if (!slot?.crop) return <span className={styles.previewEmpty} />;
  const crop = slot.crop;
  return <span className={styles.previewCell}><img src={slot.source.previewUrl} alt="" draggable={false} style={{
    width: `${10000 / crop.width}%`, height: `${10000 / crop.height}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%`,
  }} /></span>;
}

type CurrentPreview = { imageUrl: string; referenceUrl?: string | null };
type PreviewModule = { id: string; fixedCover?: ModuleCoverDTO | null; sharedLive?: { intent: { presetId: string }; available: boolean } | null;
  cover?: { thumbnailUrl?: string | null; referenceUrl?: string | null } | null; banner?: { thumbnailUrl?: string | null } | null; images?: Array<{ thumbnailUrl?: string | null }> };
function CurrentCover({ cover, preview, error }: { cover: ModuleCoverDTO | null; preview: CurrentPreview | null; error: string }) {
  const [failed, setFailed] = useState(false);
  const src = cover ? cover.available ? cover.imageUrl || cover.thumbnailUrl : null : preview?.imageUrl;
  return <div className={styles.currentCover}>
    <span>{cover ? '当前已保存封面' : '当前显示封面，尚未固定'}</span>
    {src && !failed ? <div className={styles.currentPreview}>
      {!cover && preview?.referenceUrl && <img src={preview.referenceUrl} alt="当前封面中的生成前参考图" draggable={false} onError={() => setFailed(true)} />}
      <img src={src} alt={cover ? '当前已保存封面' : '当前封面代表图'} draggable={false} onError={() => setFailed(true)} />
    </div> : <p role="status">{cover ? cover.unavailableReason || '当前封面暂时无法读取，请稍后重新打开。'
      : error || (failed ? '当前封面图片暂时无法读取，请重新打开。' : '暂无合法代表图，可选图设置固定封面。')}</p>}
  </div>;
}

export function ModuleCoverEditor({ userId, moduleId, moduleName, onClose, onSaved }: { userId: string; moduleId: string; moduleName: string; onClose: () => void; onSaved: (cover: ModuleCoverDTO) => void }) {
  const { user, sessionChanged } = useAppSession();
  const scopeKey = `${userId}:${moduleId}:${user?.id || ''}:${sessionChanged}`;
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const expectedScope = scope.current;
  const sessionAllowed = user?.id === userId && !sessionChanged && !isClientSessionBlocked();
  const dialog = useRef<HTMLDialogElement>(null);
  const { confirm, productDialog } = useProductDialog();
  const [state, setState] = useState<ModuleCoverEditorState | null>(null);
  const [preview, setPreview] = useState<CurrentPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [layout, setLayout] = useState<ModuleCoverLayout>('single');
  const [slots, setSlots] = useState<Slot[]>([null, null]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [pending, setPending] = useState<ModuleCoverSaveInput | null>(null);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [reading, setReading] = useState(false);
  const busyRef = useRef(false), alive = useRef(true), sequence = useRef(0);
  const endpoint = `/api/image-studio/modules/${encodeURIComponent(moduleId)}/cover`;
  const count = layout === 'single' ? 1 : 2;
  const disabled = guardReadOnly || !sessionAllowed || busy || reading || Boolean(pending);
  const current = useCallback(() => alive.current && scope.current === expectedScope && sessionAllowed && !isClientSessionBlocked(), [expectedScope, sessionAllowed]);
  const modified = () => { if (!disabled) setDirty(true); };
  useUnsavedNavigation(dirty || busy || Boolean(pending), confirm, { unsaved: dirty ? ['模块封面'] : [], busy: busy || pending ? ['封面保存结果待确认'] : [] });

  const initialize = useCallback(async () => {
    if (!current()) return;
    setLoading(true); setError(''); setState(null); setPreview(null); setPreviewError('');
    try {
      const value = await json<ModuleCoverEditorState>(await fetch(endpoint, { cache: 'no-store' }));
      if (!current()) return;
      setState(value); setLayout(value.recipe?.layout || 'single');
      const restored = value.recipe?.sources.map(item => {
        const source = value.sources.find(source => source.assetId === item.assetId && source.version === item.version);
        return source ? { source, crop: item.crop, restore: item.crop, key: ++sequence.current } : null;
      }) || [];
      setSlots([restored[0] || null, restored[1] || null]);
      setDirty(false); setError(value.sourceError || '');
      if (!value.fixedCover) {
        try {
          const data = await json<{ modules: PreviewModule[] }>(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(moduleId)}`, { cache: 'no-store' }));
          if (!current()) return;
          const previewModule = data.modules?.find(item => item.id === moduleId);
          if (!previewModule || (value.target.kind === 'preset' ? previewModule.sharedLive?.intent.presetId !== value.target.id || previewModule.sharedLive.available === false
            : value.target.id !== moduleId || Boolean(previewModule.sharedLive))) throw new Error('当前封面归属或权限未能确认，请重新读取。');
          if (previewModule.fixedCover) throw new Error('固定封面刚有变化，请重新读取当前封面。');
          const imageUrl = previewModule.cover?.thumbnailUrl || previewModule.banner?.thumbnailUrl || previewModule.images?.[0]?.thumbnailUrl;
          setPreview(imageUrl ? { imageUrl, referenceUrl: previewModule.cover?.referenceUrl } : null);
        } catch (cause) { if (current()) setPreviewError(cause instanceof Error ? cause.message : '当前显示封面未能读取，请重新打开。'); }
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '封面读取失败'); }
    finally { if (current()) setLoading(false); }
  }, [endpoint, moduleId, current]);
  useEffect(() => {
    alive.current = true; dialog.current?.showModal(); void initialize();
    return () => { alive.current = false; };
  }, [initialize]);
  const dismiss = () => {
    if (busyRef.current || pending || pickerSlot !== null) return;
    void (async () => {
      if (dirty && !await confirm('封面裁剪还未保存，放弃这次调整吗？', { title: '放弃调整', confirmLabel: '放弃调整' })) return;
      if (!current()) return;
      onClose();
    })();
  };
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: dismiss });

  function complete(result: ModuleCoverSaveResult) {
    if (!current()) return;
    setPending(null); setDirty(false); onSaved(result.fixedCover); onClose();
  }
  async function check(input: ModuleCoverSaveInput) {
    const result = await json<ModuleCoverRequestResult>(await fetch(`${endpoint}?requestId=${encodeURIComponent(input.requestId)}`, { cache: 'no-store' }));
    if (!current()) return;
    if (result.status === 'saved') { complete(result); return; }
    if (result.status === 'failed') {
      setPending(null); setRetryAllowed(false); setError(result.error || '封面保存失败，原封面保留，请重试'); return;
    }
    setPending(input); setRetryAllowed(result.status === 'not-found');
    setError(result.status === 'pending' ? '正在确认这次保存，原封面保留。请稍后检查结果。' : '暂未查到这次保存，可用同一次请求重试，避免重复保存。');
  }
  async function save(retry?: ModuleCoverSaveInput) {
    if (!current() || busyRef.current || !state?.canManage) return;
    let input = retry;
    if (!input) {
      const selected = slots.slice(0, count);
      if (selected.some(slot => !slot?.crop)) return;
      const recipe: ModuleCoverRecipe = { version: 1, layout, sources: selected.map(slot => ({ assetId: slot!.source.assetId, version: slot!.source.version, crop: slot!.crop! })), output };
      input = { requestId: crypto.randomUUID(), expectedRevision: state.revision, target: state.target, recipe };
    }
    busyRef.current = true; setBusy(true); setError(''); setPending(input); setRetryAllowed(false);
    try {
      const result = await json<ModuleCoverRequestResult>(await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(90000) }));
      if (!current()) return;
      if (result.status === 'saved') complete(result);
      else await check(input);
    } catch (cause) {
      if (!current()) return;
      const status = (cause as { status?: number }).status;
      if (status && status < 500) { setPending(null); setError(cause instanceof Error ? cause.message : '封面保存未完成'); }
      else {
        try { await check(input); }
        catch { setError('保存结果暂时无法确认，输入与原封面都已保留。请检查这次保存结果。'); }
      }
    } finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function checkPending() {
    if (!current() || !pending || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await check(pending); }
    catch { if (current()) setError('仍无法确认保存结果，请稍后再次检查；不要重复创建新封面。'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function choose(assetId: string, index: number) {
    if (!current()) return;
    setReading(true);
    try {
      const value = await json<ModuleCoverEditorState>(await fetch(`${endpoint}?sourceAssetIds=${encodeURIComponent(assetId)}`, { cache: 'no-store' }));
      if (!current()) return;
      const source = value.sources.find(item => item.assetId === assetId);
      if (!source) throw new Error('这张图片不能用于当前模块封面，请选择本人有展示权的图片');
      setSlots(current => current.map((item, i) => i === index ? { source, key: ++sequence.current } : item));
      setDirty(true); setError('');
      return true;
    } finally { if (current()) setReading(false); }
  }
  function changeLayout(value: ModuleCoverLayout) {
    if (disabled || value === layout) return;
    setLayout(value); setDirty(true);
    // 外框比例改变时重新计算合法裁剪，保留人选的两张素材。
    setSlots(current => current.map(slot => slot ? { source: slot.source, key: ++sequence.current } : null));
  }
  return createPortal(<>{productDialog}<dialog ref={dialog} className={styles.dialog} aria-label={`设置封面：${moduleName}`} aria-busy={busy || undefined}>
    <header className={styles.header}><div><h2>设置封面</h2><p>{moduleName}</p></div><button type="button" onClick={dismiss} disabled={busy || Boolean(pending)} aria-label="关闭封面编辑"><X size={20} /></button></header>
    {!sessionAllowed ? <p role="status">账号状态已变化，当前封面操作已暂停。</p> : loading ? <p role="status">正在读取当前封面…</p> : !state ? <div role="alert"><p>{error}</p><button type="button" onClick={() => void initialize()}>重新读取</button></div> : <>
      {!state.canManage && <p role="status">封面由模块创建者维护。</p>}
      <CurrentCover key={`${state.target.kind}:${state.target.id}:${state.revision}:${state.fixedCover?.imageUrl || state.fixedCover?.thumbnailUrl || preview?.imageUrl || ''}`} cover={state.fixedCover} preview={preview} error={previewError} />
      <p role="status">当前回退版本保留封面查看；请恢复新版后编辑。原保存请求仍可核对。</p>
      {!guardReadOnly && <>
      <div className={styles.toolbar}><div className={styles.layouts} role="group" aria-label="封面排版">{layouts.map(([value, label]) => <button key={value} type="button" aria-pressed={layout === value} disabled={disabled || !state.canManage} onClick={() => changeLayout(value)}>{label}</button>)}</div>
        {count === 2 && <button type="button" disabled={disabled || !state.canManage || !slots[0] || !slots[1]} onClick={() => { setSlots(([left, right]) => [right, left].map(slot => slot ? { ...slot, restore: slot.crop, key: ++sequence.current } : null)); setDirty(true); }}><ArrowLeftRight size={16} />交换位置</button>}
      </div>
      <p className={styles.hint}>分别选图，拖动或缩放选择局部。保存后，所有有权查看模块的人会看到同一封面。</p>
      <div className={`${styles.editFrame} ${styles[layout]}`}>{slots.slice(0, count).map((slot, index) => <div key={index} className={styles.cell}>
        {slot ? <CropSlot key={`${index}:${slot.key}`} slot={slot} aspect={layout === 'horizontal' ? 2 / 3 : layout === 'vertical' ? 8 / 3 : 4 / 3} disabled={disabled || !state.canManage}
          onInteract={modified} onCrop={crop => setSlots(current => current.map((item, i) => i === index && item?.key === slot.key ? { ...item, crop } : item))} /> : <span className={styles.empty}>选择图片</span>}
        <div className={styles.cellActions}><button type="button" disabled={disabled || !state.canManage} onClick={() => setPickerSlot(index)}><ImagePlus size={16} />{slot ? '换图' : '选择图片'}</button>
          {slot && <button type="button" title="重置这张图的裁剪" aria-label="重置这张图的裁剪" disabled={disabled || !state.canManage} onClick={() => { setSlots(current => current.map((item, i) => i === index && item ? { source: item.source, key: ++sequence.current } : item)); setDirty(true); }}><RotateCcw size={16} /></button>}</div>
      </div>)}</div>
      <div className={styles.previewRow}><span>草稿预览{dirty ? '（未保存）' : ''}</span><div className={`${styles.preview} ${styles[layout]}`}>{slots.slice(0, count).map((slot, index) => <CropPreview key={index} slot={slot} />)}</div></div>
      </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <footer className={styles.footer}><button type="button" onClick={dismiss} disabled={busy || Boolean(pending)}>取消</button>
        {pending ? <><button type="button" disabled={busy} onClick={() => void checkPending()}>{busy ? '确认中…' : '检查保存结果'}</button>{retryAllowed && <button type="button" disabled={busy} onClick={() => void save(pending)}>重试本次保存</button>}</>
          : <button type="button" className={styles.primary} disabled={disabled || !state.canManage || !dirty || slots.slice(0, count).some(slot => !slot?.crop)} onClick={() => void save()}><Save size={16} />{busy ? '正在保存…' : '保存封面'}</button>}
      </footer>
    </>}
    {pickerSlot !== null && <UploadedImagePicker open imageOnly target="image-studio" title="选择封面图片" confirmLabel="使用这张图片" purpose="module-cover" maxSelection={1} currentCount={0} currentAssetIds={[]} portalContainer={dialog.current}
      onClose={() => setPickerSlot(null)} onUploadFile={(file, onProgress) => uploadFileAsAsset(file, { onProgress })}
      onConfirm={async ids => { if (!ids[0] || !await choose(ids[0], pickerSlot) || !current()) return false; setPickerSlot(null); return true; }} />}
  </dialog></>, document.body);
}
