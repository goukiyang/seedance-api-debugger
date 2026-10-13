'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { CropMeta } from '@/lib/cutout/types';
import { Minus, Plus, Maximize } from 'lucide-react';
import styles from '@/app/cutout/cutout.module.css';

type Size = { width: number; height: number };
type Props = {
  scope: string;
  originalUrl: string;
  resultUrl: string;
  matchingOriginal: boolean;
  crop: CropMeta | null;
  view: 'original' | 'result' | 'compare';
  background: 'checker' | 'light' | 'dark';
  onOriginalSize: (size: Size) => void;
  onZoom: (url: string) => void;
};

export default function CutoutWorkspacePreview({ scope, originalUrl, resultUrl, matchingOriginal, crop, view, background, onOriginalSize, onZoom }: Props) {
  const clipId = useId().replace(/:/g, '');
  const [originalSize, setOriginalSize] = useState<Size | null>(null);
  const [resultSize, setResultSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState('');
  const [split, setSplit] = useState(50);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [restoredScope, setRestoredScope] = useState('');
  const [storageIssue, setStorageIssue] = useState('');
  const drag = useRef<{ x: number; y: number; offset: typeof offset } | null>(null);
  useEffect(() => { setOriginalSize(null); setFailed(''); }, [originalUrl]);
  useEffect(() => {
    const safe = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    try {
      const saved = JSON.parse(localStorage.getItem(`sd2:cutout:viewport:v1:${scope}`) || 'null');
      setScale(safe(saved?.scale, 1, 4, 1)); setOffset({ x: safe(saved?.x, -2000, 2000, 0), y: safe(saved?.y, -2000, 2000, 0) }); setSplit(safe(saved?.split, 0, 100, 50));
    } catch { setScale(1); setOffset({ x: 0, y: 0 }); setStorageIssue('本次缩放位置无法恢复。'); }
    setRestoredScope(scope);
  }, [scope]);
  useEffect(() => {
    if (restoredScope !== scope) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(`sd2:cutout:viewport:v1:${scope}`, JSON.stringify({ scale, x: offset.x, y: offset.y, split })); }
      catch { setStorageIssue('本次缩放位置无法记住。'); }
    }, 200);
    return () => clearTimeout(timer);
  }, [offset, restoredScope, scale, scope, split]);
  useEffect(() => { setResultSize(null); setFailed(''); }, [resultUrl]);
  const cropMatches = crop && originalSize && resultSize && crop.width === resultSize.width && crop.height === resultSize.height
    && crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= originalSize.width && crop.y + crop.height <= originalSize.height
    && (crop.source_width == null || crop.source_width === originalSize.width)
    && (crop.source_height == null || crop.source_height === originalSize.height);
  const sameSize = originalSize && resultSize && originalSize.width === resultSize.width && originalSize.height === resultSize.height;
  const canCompare = matchingOriginal && Boolean(crop ? cropMatches : sameSize);
  const comparing = view === 'compare' && canCompare;
  const showOriginal = view === 'original' || !resultUrl || view === 'compare' && !canCompare;
  const displayedUrl = showOriginal ? originalUrl : resultUrl;
  const size = comparing || showOriginal ? originalSize : resultSize;

  return <>
    <div className={`${styles.workspaceStage} ${background === 'light' ? styles.previewLight : background === 'dark' ? styles.previewDark : ''}`} style={{ touchAction: scale > 1 ? 'none' : 'pan-y' }} tabIndex={0} aria-label="图片预览，放大后可用方向键移动"
      onKeyDown={event => { if (scale <= 1 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const delta = 30; setOffset(value => ({ x: value.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0), y: value.y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0) })); }}
      onPointerDown={event => {
        if (event.button !== 0 || scale <= 1 || (event.target as Element).closest('button,input')) return;
        drag.current = { x: event.clientX, y: event.clientY, offset };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { if (drag.current) setOffset({ x: drag.current.offset.x + event.clientX - drag.current.x, y: drag.current.offset.y + event.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}>
      {/* These images read natural dimensions; the SVG never stretches a cropped result. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {originalUrl && <img className={styles.dimensionProbe} src={originalUrl} alt="" onLoad={event => { const value = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setOriginalSize(value); onOriginalSize(value); }} onError={() => setFailed('原图无法读取，请重新选择图片。')} />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {resultUrl && <img className={styles.dimensionProbe} src={resultUrl} alt="" onLoad={event => setResultSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed('结果预览无法读取，原图和可用文件保留；可重新查询或重试下载。')} />}
      {size && displayedUrl && <svg className={styles.workspaceImage} viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={comparing ? '原图与结果对照' : showOriginal ? '当前原图' : '透明结果'} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} onDoubleClick={() => onZoom(displayedUrl)}>
        {comparing ? <>
          <defs><clipPath id={clipId}><rect x={size.width * split / 100} y={0} width={size.width} height={size.height} /></clipPath><pattern id={`${clipId}grid`} width={Math.max(8, size.width / 40)} height={Math.max(8, size.width / 40)} patternUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="var(--bg-input)" /><rect width="50%" height="50%" fill="var(--bg-hover)" /><rect x="50%" y="50%" width="50%" height="50%" fill="var(--bg-hover)" /></pattern></defs>
          <image href={originalUrl} width={size.width} height={size.height} />
          <g clipPath={`url(#${clipId})`}>
            <rect width={size.width} height={size.height} fill={background === 'checker' ? `url(#${clipId}grid)` : background === 'dark' ? 'oklch(0.18 0.005 160)' : 'oklch(0.96 0.005 160)'} />
            <image href={resultUrl} x={crop?.x || 0} y={crop?.y || 0} width={resultSize!.width} height={resultSize!.height} />
          </g>
          <line x1={size.width * split / 100} x2={size.width * split / 100} y1={0} y2={size.height} stroke="var(--tone-info-text)" vectorEffect="non-scaling-stroke" />
        </> : <image href={displayedUrl} width={size.width} height={size.height} />}
      </svg>}
      {!size && displayedUrl && !failed && <span className={styles.emptyHint}>正在读取图片…</span>}
      {failed && <span className={`${styles.statusNotice} ${styles.statusWarning}`} role="status">{failed}</span>}
    </div>
    {view === 'compare' && !canCompare && <p className={styles.strategyCopy}>对照需要本次原图及一致的尺寸或裁剪信息；当前显示原图，不拉伸结果。</p>}
    {comparing && <label className={styles.compareSlider}>原图 · 结果<input type="range" min={0} max={100} value={split} onChange={event => setSplit(Number(event.target.value))} aria-label="移动原图结果对照分界" /></label>}
    <div className={styles.previewTools}>
      <div className={styles.buttonRow}><button className={styles.iconButton} type="button" aria-label="缩小" onClick={() => setScale(value => Math.max(1, value - .25))} disabled={scale <= 1}><Minus size={15} /></button><span>{Math.round(scale * 100)}%</span><button className={styles.iconButton} type="button" aria-label="放大" onClick={() => setScale(value => Math.min(4, value + .25))} disabled={scale >= 4}><Plus size={15} /></button><button className={styles.quietButton} type="button" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}><Maximize size={15} />适应画面</button></div>
      <span>放大后可拖动画面；双击查看大图</span>
    </div>
    {storageIssue && <p className={styles.strategyCopy} role="status">{storageIssue}</p>}
  </>;
}
