'use client';

import { useEffect, useRef, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { X } from 'lucide-react';
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
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function confirm() {
    if (!area || busy) return;
    setBusy(true); setError('');
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('原图读不出来，请换一张')); image.src = source; });
      const scale = Math.min(1, MAX_WIDTH / area.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(area.width * scale); canvas.height = Math.round(area.height * scale);
      canvas.getContext('2d')!.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
      if (!blob) throw new Error('横幅生成失败，请重试');
      onCropped(new File([blob], `banner-${Date.now()}.webp`, { type: 'image/webp' }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '横幅生成失败，请重试'); setBusy(false); }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="banner-crop-title" onClose={onCancel}>
    <header className={styles.header}><h2 id="banner-crop-title">裁切横幅</h2><button type="button" aria-label="关闭" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
    <div className={styles.stage} style={{ margin: '0 18px', height: 300 }}>
      <Cropper image={source} crop={crop} zoom={zoom} aspect={BANNER_ASPECT} showGrid={false} maxZoom={8}
        onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={(_, pixels) => setArea(pixels)} />
    </div>
    <label className={styles.zoom} style={{ margin: '12px 18px 0' }}>缩放（拖动图片调整位置）<input type="range" min={1} max={8} step={0.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer className={styles.footer}><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
      <button type="button" className={styles.primary} disabled={busy || !area} onClick={() => void confirm()}>{busy ? '正在生成…' : '使用这个横幅'}</button></footer>
  </dialog>;
}
