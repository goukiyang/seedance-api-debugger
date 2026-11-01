'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { X } from 'lucide-react';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './AvatarEditor.module.css';

export const BANNER_ASPECT = 6;
const MAX_WIDTH = 2400;

/** Crops a banner from the original image (never a thumbnail) and returns a webp file at up to 2400px wide. */
export function BannerCropDialog({ source, onCancel, onCropped }: { source: string; onCancel: () => void; onCropped: (file: File) => void }) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const alive = useRef(true);
  const sourceRevision = useRef(0);
  const activeSource = useRef(source);
  if (activeSource.current !== source) {
    activeSource.current = source;
    sourceRevision.current += 1;
  }
  const close = () => { alive.current = false; sourceRevision.current += 1; onCancel(); };
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: close });
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setBusy(false);
    setError('');
    setArea(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  }, [source]);

  async function confirm() {
    if (!area || busy) return;
    const revision = sourceRevision.current;
    const pendingSource = source;
    setBusy(true); setError('');
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('原图读不出来，请换一张')); image.src = pendingSource; });
      const scale = Math.min(1, MAX_WIDTH / area.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(area.width * scale); canvas.height = Math.round(area.height * scale);
      canvas.getContext('2d')!.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
      if (!blob) throw new Error('横幅生成失败，请重试');
      if (alive.current && revision === sourceRevision.current) onCropped(new File([blob], `banner-${Date.now()}.webp`, { type: 'image/webp' }));
    } catch (cause) {
      if (alive.current && revision === sourceRevision.current) setError(cause instanceof Error ? cause.message : '横幅生成失败，请重试');
    } finally {
      if (alive.current && revision === sourceRevision.current) setBusy(false);
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-busy={busy}>
    <header className={styles.header}><h2 id={titleId}>裁切横幅</h2><button type="button" aria-label="关闭" onClick={close}><X size={18} /></button></header>
    <div className={styles.stage} style={{ margin: '0 18px', height: 300 }}>
      <Cropper image={source} crop={crop} zoom={zoom} aspect={BANNER_ASPECT} showGrid={false} maxZoom={8}
        onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={(_, pixels) => setArea(pixels)} />
    </div>
    <label className={styles.zoom} style={{ margin: '12px 18px 0' }}>缩放（拖动图片调整位置）<input type="range" min={1} max={8} step={0.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer className={styles.footer}><button type="button" onClick={close}>取消</button>
      <button type="button" className={styles.primary} disabled={busy || !area} onClick={() => void confirm()}>{busy ? '正在生成…' : '使用这个横幅'}</button></footer>
  </dialog>;
}
