'use client';

import { useEffect, useRef, useState } from 'react';
import { avatarCellLabel, avatarSheetSize } from '@/lib/avatar-random/layout';
import type { AvatarLayout } from '@/lib/avatar-random/types';
import { avatarCellRect, containImageSize } from '@/lib/avatar-random/sheet-geometry';
import styles from './studio.module.css';

export function AvatarSheetPreview({ src, layout, index, onSelect, onPreview, overlay = false }: { src: string; layout: AvatarLayout; index: number; onSelect: (index: number) => void; onPreview: () => void; overlay?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState('');
  const size = avatarSheetSize(layout);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const loaded = natural?.src === src;
  // The selectable plane is the actual contain image, excluding letterbox space.
  const { width, height } = containImageSize(viewport.width, viewport.height, loaded && natural ? natural.width : 1, loaded && natural ? natural.height : 1);
  return <div className={styles.sheetViewport} ref={container} style={overlay ? { position: 'absolute', inset: 0, height: '100%', background: 'transparent', pointerEvents: 'none' } : undefined}>
    <div className={styles.sheetPlane} style={{ width, height }}>
      <img key={src} src={src} alt={overlay ? '' : `${size}×${size}人物整图`} style={overlay ? { visibility: 'hidden' } : undefined} onLoad={event => { setNatural({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setFailed(''); }} onError={() => { setNatural(null); setFailed(src); }} />
      {loaded && <div className={styles.sheetGrid} style={{ gridTemplateColumns: `repeat(${size}, 1fr)`, gridTemplateRows: `repeat(${size}, 1fr)` }}>
        {Array.from({ length: size * size }, (_, i) => <button type="button" key={i} style={overlay ? { pointerEvents: 'auto' } : undefined} ref={element => { cells.current[i] = element; }} aria-label={`选择${avatarCellLabel(layout, i)}格人物`} aria-pressed={i === index} tabIndex={i === index ? 0 : -1}
          onClick={event => { event.stopPropagation(); if (event.detail > 1) return; onSelect(i); onPreview(); }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
            const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -size, ArrowDown: size }[event.key];
            if (offset === undefined) return;
            event.preventDefault();
            const next = Math.max(0, Math.min(size * size - 1, i + offset));
            onSelect(next); cells.current[next]?.focus();
          }} />)}
      </div>}
    </div>
    {failed === src && <p role="alert" className={styles.placeholder}>整图暂不可读取，请查询结果或重试预览。</p>}
  </div>;
}

export async function downloadAvatarCell(src: string, layout: AvatarLayout, index: number) {
  const size = avatarSheetSize(layout);
  if (!size || !Number.isInteger(index) || index < 0 || index >= size * size) throw new Error('格子选择无效');
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error('原图无法读取，未裁切。请使用现有整图下载后本地处理。'));
    image.src = src;
  });
  const { x, y, width, height } = avatarCellRect(image.naturalWidth, image.naturalHeight, size, index);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法本地裁切，请下载整图');
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob(value => value ? resolve(value) : reject(new Error('裁切导出失败，请下载整图')), 'image/png'); }
    catch { reject(new Error('原图不允许本地裁切导出，请下载整图；没有启动生成或上传')); }
  });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `avatar-${size}x${size}-${index + 1}.png`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
