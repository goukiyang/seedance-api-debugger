'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useHdImageSource } from '@/lib/hooks/use-hd-image-source';
import { acquireImageRead, type ImageReadResult } from '@/lib/media/image-read-session';
import { imageDisplaySource } from '@/lib/media/image-comparison';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { characterLabIsGrid, characterLabCellCount, type CharacterLabPlan, type CharacterLabTask } from '@/lib/character-lab/types';
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
    const pair = plan.operation === 'body-pair';
    const grid = characterLabIsGrid(plan);
    const cell = Number(value), count = characterLabCellCount(plan);
    if (!Number.isInteger(cell) || cell < 0 || cell >= count) return { src: '' };
    const columns = count === 9 ? 3 : 2, row = Math.floor(cell / columns);
    const crop = { x: cell % columns / columns, y: pair ? 0 : !grid ? row === 0 ? 0 : 0.42 : row / columns,
      width: 1 / columns, height: pair ? 1 : !grid ? row === 0 ? 0.42 : 0.58 : 1 / columns };
    return { src: asset.url, crop, aspectRatio: asset.width && asset.height ? asset.width * crop.width / (asset.height * crop.height) : 1 };
  }
  if (url.pathname === '/api/character-lab/compose') {
    url.searchParams.set('hd', '1');
    return { src: url.pathname + url.search };
  }
  return imageDisplaySource(source, 'hd-description') !== source ? { src: source } : { src: '' };
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
  const imageSrc = result?.imageSrc || '', isCropped = Boolean(resolved.crop);
  const { x, y, width: cropWidth, height: cropHeight } = resolved.crop || { x: 0, y: 0, width: 1, height: 1 };
  const cropKey = JSON.stringify([imageSrc, isCropped, x, y, cropWidth, cropHeight]);
  const [cropped, setCropped] = useState<{ key: string; src: string } | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (!imageSrc || !isCropped) return;
    let active = true, objectUrl = '';
    const original = new Image();
    original.onload = () => {
      const left = Math.floor(original.naturalWidth * x), top = Math.floor(original.naturalHeight * y);
      const width = Math.floor(original.naturalWidth * (x + cropWidth)) - left;
      const height = Math.floor(original.naturalHeight * (y + cropHeight)) - top;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) { if (active) setFailed(cropKey); return; }
      context.drawImage(original, left, top, width, height, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (!active) return;
        if (!blob) { setFailed(cropKey); return; }
        objectUrl = URL.createObjectURL(blob); setCropped({ key: cropKey, src: objectUrl });
      }, 'image/png');
    };
    original.onerror = () => { if (active) setFailed(cropKey); };
    original.src = imageSrc;
    return () => { active = false; original.onload = null; original.onerror = null; original.removeAttribute('src'); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [imageSrc, isCropped, x, y, cropWidth, cropHeight, cropKey]);
  return { ...resolved, imageSrc: isCropped ? cropped?.key === cropKey ? cropped.src : '' : imageSrc,
    failed: hd.denied || result?.progress.phase === 'unavailable' || !resolved.src || failed === cropKey };
}

export function CharacterLabImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const image = useCharacterLabImage(src);
  if (!image.imageSrc) return <span className={styles.imageUnavailable}>{image.failed ? '图片暂不可读取' : '正在读取高清图'}</span>;
  // Native image commands must target the cell PNG rather than a visual clip of the sheet.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={image.imageSrc} alt={alt} className={image.crop ? `${styles.imageCrop} ${className || ''}` : className}
    style={image.crop ? { aspectRatio: image.aspectRatio, objectFit: 'contain' } : undefined} />;
}

export function CharacterLabPreview({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const image = useCharacterLabImage(src);
  const loadingRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open: !image.imageSrc, dialogRef: loadingRef, dismissSurfaceRef: backdropRef, modal: true, onDismiss: onClose });
  if (image.imageSrc) return <ZoomableImagePreview src={image.imageSrc} alt={alt} fileName={image.crop ? 'character-reference.png' : 'character-reference.webp'} previewOnly imageSharing={false} onClose={onClose} />;
  return <div ref={backdropRef} className={`${styles.root} ${styles.imagePreviewBackdrop}`}><div ref={loadingRef} className={styles.imagePreviewLoading} role="dialog" aria-modal="true" aria-label="高清图片预览">
    <p role="status">{image.failed ? '图片暂不可读取，请关闭后重试' : '正在读取高清图…'}</p>
    <button type="button" onClick={onClose}>关闭</button>
  </div></div>;
}
