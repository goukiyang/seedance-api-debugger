'use client';

import { useEffect, useRef, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { ImagePlus, X } from 'lucide-react';
import { uploadFileToHistory } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import type { PickerItem } from '@/lib/assets/picker-types';
import styles from './AvatarEditor.module.css';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

/** 更换头像: pick (upload / drag / paste) → round crop + zoom → server renders from the original. */
export function AvatarEditor({ userId, hasFeishu, onClose, onChanged }: {
  userId: string; hasFeishu: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  // Picking goes through the shared file finder/uploader (project rule, 2026-10-25); drag/paste stay as shortcuts.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [libraryAssetId, setLibraryAssetId] = useState('');
  const [source, setSource] = useState('');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const large = useRef<HTMLCanvasElement>(null), small = useRef<HTMLCanvasElement>(null), image = useRef<HTMLImageElement | null>(null);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => () => { if (source.startsWith('blob:')) URL.revokeObjectURL(source); }, [source]);
  useEffect(() => {
    // Live previews at the two sizes the site shows.
    const img = image.current;
    if (!img || !area) return;
    for (const canvas of [large.current, small.current]) {
      const context = canvas?.getContext('2d');
      if (!canvas || !context) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
    }
  }, [area]);

  function choose(next: File | undefined) {
    if (!next) return;
    if (!TYPES.includes(next.type)) { setError('请选择 JPG、PNG 或 WebP 图片'); return; }
    if (next.size > MAX_BYTES) { setError('图片不能超过 10MB'); return; }
    const url = URL.createObjectURL(next), probe = new Image();
    probe.onload = () => {
      if (Math.min(probe.naturalWidth, probe.naturalHeight) < 128) { URL.revokeObjectURL(url); setError('图片太小，短边至少需要 128 像素'); return; }
      image.current = probe; setError(''); setFile(next); setLibraryAssetId(''); setSource(url); setZoom(1); setCrop({ x: 0, y: 0 });
    };
    probe.onerror = () => { URL.revokeObjectURL(url); setError('这张图片读不出来，请换一张'); };
    probe.src = url;
  }
  async function pick(items: PickerItem[]) {
    const item = items[0];
    if (items.length !== 1 || item.type !== 'image' || !item.assetId || !item.originalUrl) return { success: false, message: '请选择一张图片' };
    const probe = new Image();
    try { await new Promise<void>((resolve, reject) => { probe.onload = () => resolve(); probe.onerror = () => reject(); probe.src = item.originalUrl; }); }
    catch { return { success: false, message: '这张图片的原图读不出来，请换一张' }; }
    if (Math.min(probe.naturalWidth, probe.naturalHeight) < 128) return { success: false, message: '图片太小，短边至少需要 128 像素' };
    image.current = probe; setError(''); setFile(null); setLibraryAssetId(item.assetId); setSource(item.originalUrl); setZoom(1); setCrop({ x: 0, y: 0 });
    setPickerOpen(false);
    return { success: true };
  }
  async function send(body: Record<string, unknown>) {
    const response = await fetch('/api/me/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const result = await readJsonResponse<{ error?: string }>(response);
    if (!response.ok) throw new Error(result.error || '头像暂未保存，请重试');
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); onChanged(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '头像暂未保存，请重试'); }
    finally { setBusy(false); }
  }
  const save = () => run(async () => {
    if (!area || !file && !libraryAssetId) throw new Error('请先选择并调整图片');
    let assetId = libraryAssetId;
    if (!assetId) {
      const asset = await uploadFileToHistory(file!, { ownerId: userId });
      if (!asset.id) throw new Error('图片已上传，但编号未确认，请重试');
      assetId = asset.id;
    }
    await send({ action: 'custom', assetId, crop: { x: area.x, y: area.y, width: area.width, height: area.height } });
  });

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="avatar-editor-title" onClose={onClose}
    onPaste={event => { const pasted = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/')); if (pasted) { event.preventDefault(); choose(pasted); } }}>
    <header className={styles.header}><h2 id="avatar-editor-title">更换头像</h2>
      <button type="button" aria-label="关闭" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button></header>
    <div className={styles.body}>
      <div className={styles.stage} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
        {source ? <Cropper image={source} crop={crop} zoom={zoom} aspect={1} cropShape="round" showGrid={false} maxZoom={8}
          onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={(_, pixels) => setArea(pixels)} />
          : <button type="button" className={styles.pick} onClick={() => setPickerOpen(true)}><ImagePlus size={28} /><strong>选择图片</strong><small>从素材库选或上传，也可拖到这里、Ctrl+V 粘贴</small></button>}
      </div>
      <aside className={styles.side}>
        <span className={styles.previewLabel}>预览</span>
        <div className={styles.previews}><canvas ref={large} width={96} height={96} /><canvas ref={small} width={32} height={32} /></div>
        {source && <label className={styles.zoom}>缩放<input type="range" min={1} max={8} step={0.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label>}
        {source && <button type="button" onClick={() => setPickerOpen(true)} disabled={busy}>换一张</button>}
        <p className={styles.hint}>JPG / PNG / WebP，10MB 以内</p>
        <span className={styles.previewLabel}>恢复为</span>
        <div className={styles.restore}>
          {hasFeishu && <button type="button" disabled={busy} onClick={() => void run(() => send({ action: 'feishu' }))}>飞书头像</button>}
          <button type="button" disabled={busy} onClick={() => void run(() => send({ action: 'initials' }))}>默认首字母</button>
        </div>
      </aside>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer className={styles.footer}><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
      <button type="button" className={styles.primary} disabled={busy || !file && !libraryAssetId || !area} onClick={() => void save()}>{busy ? '正在保存…' : '保存头像'}</button></footer>
    {pickerOpen && <UploadedImagePicker open imageOnly target="image-studio" purpose="avatar" title="选择头像图片" confirmLabel="用这张做头像"
      contextKey={`${userId}:avatar`} maxSelection={1} currentCount={0} currentAssetIds={[]} currentReferenceImageIds={[]} portalContainer={dialog.current || undefined}
      onClose={() => setPickerOpen(false)} onUploadFile={(next, onProgress) => uploadFileToHistory(next, { ownerId: userId, onProgress })}
      onConfirm={async () => ({ success: false, message: '请选择一张图片' })} onConfirmSelection={pick} />}
  </dialog>;
}
