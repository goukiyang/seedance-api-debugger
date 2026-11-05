'use client';

import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useHdImageSource } from '@/lib/hooks/use-hd-image-source';
import { acquireImageRead, type ImageReadResult } from '@/lib/media/image-read-session';
import { imageDisplaySource } from '@/lib/media/image-comparison';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import type { CharacterLabPlan, CharacterLabTask } from '@/lib/character-lab/types';
import styles from './studio.module.css';

type Rectangle = { x: number; y: number; width: number; height: number };
type ImageSource = { src: string; crop?: Rectangle; aspectRatio?: number };
const mediaContext = createContext<{ plans: CharacterLabPlan[]; tasks: Record<string, CharacterLabTask | null> }>({ plans: [], tasks: {} });
export const CharacterLabMediaProvider = mediaContext.Provider;

function resolveImage(source: string, plans: CharacterLabPlan[], tasks: Record<string, CharacterLabTask | null>): ImageSource {
  const url = new URL(source, 'https://sd2.youdooart.com');
  if (url.pathname === '/api/character-lab/media') {
    const plan = plans.find(item => item.id === url.searchParams.get('plan'));
    const asset = plan && tasks[plan.id]?.asset;
    if (!plan || !asset) return { src: '' };
    const value = url.searchParams.get('cell');
    if (value === null) return { src: asset.url };
    const cell = Number(value), count = plan.kind === 'faces' ? plan.count : 4;
    if (!Number.isInteger(cell) || cell < 0 || cell >= count) return { src: '' };
    const columns = count === 9 ? 3 : 2, row = Math.floor(cell / columns);
    const crop = { x: cell % columns / columns, y: plan.kind === 'result' ? row === 0 ? 0 : 0.42 : row / columns,
      width: 1 / columns, height: plan.kind === 'result' ? row === 0 ? 0.42 : 0.58 : 1 / columns };
    return { src: asset.url, crop, aspectRatio: asset.width && asset.height ? asset.width * crop.width / (asset.height * crop.height) : 1 };
  }
  if (url.pathname === '/api/character-lab/compose') {
    url.searchParams.set('hd', '1');
    return { src: url.pathname + url.search };
  }
  return /^\/api\/image-studio\/(?:assets|template-assets)\//.test(url.pathname) ? { src: source } : { src: '' };
}

function useCharacterLabImage(source: string) {
  const { plans, tasks } = useContext(mediaContext), session = useAppSession();
  const resolved = resolveImage(source, plans, tasks);
  const hd = useHdImageSource(resolved.src, false, 0, '');
  const account = session.hasLoadedUser && !session.userLoadError && !session.sessionChanged && session.user
    ? `${session.user.id}:${session.user.role || ''}:${session.user.account_type || ''}` : '';
  const composition = resolved.src.startsWith('/api/character-lab/compose?');
  const readSource = hd.denied ? '' : composition ? resolved.src : hd.displayKind === 'original' ? imageDisplaySource(resolved.src, 'detail') : hd.readSource;
  const version = hd.displayKind === 'hd' ? hd.version : '';
  const key = JSON.stringify([account, readSource, version]);
  const [read, setRead] = useState<{ key: string; result: ImageReadResult } | null>(null);
  useEffect(() => {
    if (!account || !readSource) return;
    return acquireImageRead(account, readSource, version, 0, result => setRead({ key, result }));
  }, [account, readSource, version, key]);
  const result = read?.key === key ? read.result : null;
  return { ...resolved, imageSrc: result?.imageSrc || '', failed: hd.denied || result?.progress.phase === 'unavailable' || !resolved.src };
}

export function CharacterLabImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const image = useCharacterLabImage(src), clipId = useId();
  if (!image.imageSrc) return <span className={styles.imageUnavailable}>{image.failed ? '图片暂不可读取' : '正在读取高清图'}</span>;
  if (!image.crop) return <img src={image.imageSrc} alt={alt} className={className} />;
  const { x, y, width, height } = image.crop;
  const parentRatio = (image.aspectRatio || 1) * height / width;
  return <svg className={`${styles.imageCrop} ${className || ''}`} style={{ aspectRatio: image.aspectRatio }}
    viewBox={`${x * parentRatio} ${y} ${width * parentRatio} ${height}`} role="img" aria-label={alt}>
    <defs><clipPath id={clipId}><rect x={x * parentRatio} y={y} width={width * parentRatio} height={height} /></clipPath></defs>
    <image href={image.imageSrc} width={parentRatio} height={1} preserveAspectRatio="none" clipPath={`url(#${clipId})`} />
  </svg>;
}

export function CharacterLabPreview({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const image = useCharacterLabImage(src), crop = image.crop;
  const key = JSON.stringify([image.imageSrc, crop]);
  const [cropped, setCropped] = useState<{ key: string; src: string } | null>(null);
  const [failed, setFailed] = useState('');
  const loadingRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const ready = crop ? cropped?.key === key ? cropped.src : '' : image.imageSrc;
  useDialogDismiss({ open: !ready, dialogRef: loadingRef, dismissSurfaceRef: backdropRef, modal: true, onDismiss: onClose });
  useEffect(() => {
    if (!image.imageSrc || !crop) return;
    let active = true, objectUrl = '';
    const original = new Image();
    original.onload = () => {
      const left = Math.floor(original.naturalWidth * crop.x), top = Math.floor(original.naturalHeight * crop.y);
      const width = Math.floor(original.naturalWidth * (crop.x + crop.width)) - left;
      const height = Math.floor(original.naturalHeight * (crop.y + crop.height)) - top;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) { if (active) setFailed(key); return; }
      context.drawImage(original, left, top, width, height, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (!active) return;
        if (!blob) { setFailed(key); return; }
        objectUrl = URL.createObjectURL(blob); setCropped({ key, src: objectUrl });
      }, 'image/webp', 0.92);
    };
    original.onerror = () => { if (active) setFailed(key); };
    original.src = image.imageSrc;
    return () => { active = false; original.onload = null; original.onerror = null; original.removeAttribute('src'); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image.imageSrc, crop?.x, crop?.y, crop?.width, crop?.height, key]);
  if (ready) return <ZoomableImagePreview src={ready} alt={alt} fileName="character-reference.webp" previewOnly imageSharing={false} onClose={onClose} />;
  return <div ref={backdropRef} className={styles.imagePreviewBackdrop}><div ref={loadingRef} className={styles.imagePreviewLoading} role="dialog" aria-modal="true" aria-label="高清图片预览">
    <p role="status">{image.failed || failed === key ? '图片暂不可读取，请关闭后重试' : '正在读取高清图…'}</p>
    <button type="button" onClick={onClose}>关闭</button>
  </div></div>;
}
