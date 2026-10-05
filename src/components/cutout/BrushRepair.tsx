'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Brush, Eraser, Image as ImageIcon, Redo2, RotateCcw, Undo2 } from 'lucide-react';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useProductDialog } from '@/components/useProductDialog';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import type { CropMeta } from '@/lib/cutout/types';
import styles from './editors.module.css';

type Props = {
  resultUrl: string;
  originalUrl?: string;
  cropMeta?: CropMeta | null;
  filename?: string;
  disabled?: boolean;
  onDraftDirtyChange?: (dirty: boolean) => void;
  onApply: (resultBlob: Blob, maskBlob: Blob) => Promise<void>;
};

type BrushMode = 'restore' | 'erase' | 'leak' | 'recover';
type Point = { x: number; y: number };
const HISTORY_LIMIT = 20;
const HISTORY_BYTES = 64 * 1024 * 1024;

function cloneImageData(imageData: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片无法读取'));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 导出失败，请重试'));
    }, 'image/png');
  });
}

function colorDistance(data: Uint8ClampedArray, index: number, seed: [number, number, number]) {
  const dr = data[index] - seed[0];
  const dg = data[index + 1] - seed[1];
  const db = data[index + 2] - seed[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function samePixels(left: ImageData | null, right: ImageData | null) {
  if (!left || !right || left.width !== right.width || left.height !== right.height) return false;
  const a = left.data;
  const b = right.data;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function readColorSource(original: HTMLImageElement, cropMeta: CropMeta | null | undefined, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { data: null, reason: '无法准备原图像素，补回功能暂不可用。' };

  if (!cropMeta) {
    if (original.naturalWidth !== width || original.naturalHeight !== height) {
      return { data: null, reason: '原图尺寸与结果图不同，缺少裁剪信息，补回功能暂不可用。' };
    }
    context.drawImage(original, 0, 0, width, height);
    return { data: context.getImageData(0, 0, width, height), reason: '' };
  }

  const x = Math.round(cropMeta.x);
  const y = Math.round(cropMeta.y);
  const cropWidth = Math.round(cropMeta.width);
  const cropHeight = Math.round(cropMeta.height);
  const sourceSizeMatches = (cropMeta.source_width == null || cropMeta.source_width === original.naturalWidth)
    && (cropMeta.source_height == null || cropMeta.source_height === original.naturalHeight);
  if (!sourceSizeMatches || cropWidth !== width || cropHeight !== height
    || x < 0 || y < 0 || cropWidth <= 0 || cropHeight <= 0
    || x + cropWidth > original.naturalWidth || y + cropHeight > original.naturalHeight) {
    return { data: null, reason: '裁剪信息与原图或结果尺寸不一致，补回功能暂不可用。' };
  }
  context.drawImage(original, x, y, cropWidth, cropHeight, 0, 0, width, height);
  return { data: context.getImageData(0, 0, width, height), reason: '' };
}

export default function BrushRepair({
  resultUrl,
  originalUrl,
  cropMeta,
  filename,
  disabled = false,
  onDraftDirtyChange,
  onApply,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const baseImageDataRef = useRef<ImageData | null>(null);
  const colorSourceRef = useRef<ImageData | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const paintingRef = useRef(false);
  const strokeHasSnapshot = useRef(false);
  const strokeStartData = useRef<ImageData | null>(null);
  const lastPoint = useRef<Point | null>(null);
  const generation = useRef(0);
  const cropMetaRef = useRef(cropMeta);
  const onDraftDirtyChangeRef = useRef(onDraftDirtyChange);
  const [mode, setMode] = useState<BrushMode>('restore');
  const [brushSize, setBrushSize] = useState(28);
  const [hardness, setHardness] = useState(100);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [restoreReason, setRestoreReason] = useState('');
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const { confirm, productDialog } = useProductDialog();

  cropMetaRef.current = cropMeta;
  onDraftDirtyChangeRef.current = onDraftDirtyChange;
  const cropSignature = cropMeta
    ? `${cropMeta.x}:${cropMeta.y}:${cropMeta.width}:${cropMeta.height}:${cropMeta.source_width ?? ''}:${cropMeta.source_height ?? ''}`
    : '';

  usePageExitRisk({
    unsaved: dirty ? ['画笔修改尚未应用'] : [],
    busy: applying ? ['正在应用画笔修改'] : [],
  });

  useEffect(() => {
    onDraftDirtyChange?.(dirty);
  }, [dirty, onDraftDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    const currentGeneration = ++generation.current;
    setReady(false);
    setDirty(false);
    setError('');
    setRestoreReason('');
    setDimensions(null);
    imageDataRef.current = null;
    baseImageDataRef.current = null;
    colorSourceRef.current = null;
    undoRef.current = [];
    redoRef.current = [];
    paintingRef.current = false;
    strokeHasSnapshot.current = false;
    strokeStartData.current = null;
    lastPoint.current = null;
    setCanUndo(false);
    setCanRedo(false);
    onDraftDirtyChangeRef.current?.(false);

    const initialize = async () => {
      if (!resultUrl) {
        setError('没有可编辑的结果图。');
        return;
      }
      try {
        const resultImage = await loadImage(resultUrl);
        if (cancelled || generation.current !== currentGeneration) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const width = resultImage.naturalWidth;
        const height = resultImage.naturalHeight;
        if (!width || !height) throw new Error('结果图尺寸无效。');

        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('无法准备画布。');
        context.clearRect(0, 0, width, height);
        context.drawImage(resultImage, 0, 0);
        const resultData = context.getImageData(0, 0, width, height);
        imageDataRef.current = resultData;
        baseImageDataRef.current = cloneImageData(resultData);

        let colorData: ImageData | null = null;
        let reason = '';
        if (!originalUrl) {
          reason = '原图不可用，补回和误删修复已停用，不会用结果图伪造缺失像素。';
        } else {
          try {
            const originalImage = await loadImage(originalUrl);
            if (cancelled || generation.current !== currentGeneration) return;
            const source = readColorSource(originalImage, cropMetaRef.current, width, height);
            colorData = source.data;
            reason = source.reason;
          } catch {
            reason = '原图无法读取，补回和误删修复已停用。';
          }
        }
        if (cancelled || generation.current !== currentGeneration) return;
        colorSourceRef.current = colorData;
        setRestoreReason(reason);
        if (!colorData) setMode((current) => current === 'restore' || current === 'recover' ? 'erase' : current);
        setDimensions({ width, height });
        setReady(true);
      } catch (cause) {
        if (!cancelled && generation.current === currentGeneration) {
          setError(cause instanceof Error ? cause.message : '结果图初始化失败。');
        }
      }
    };

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [cropSignature, originalUrl, resultUrl]);

  const drawCurrent = useCallback(() => {
    const canvas = canvasRef.current;
    const imageData = imageDataRef.current;
    if (!canvas || !imageData) return;
    canvas.getContext('2d', { willReadFrequently: true })?.putImageData(imageData, 0, 0);
  }, []);

  const syncHistory = useCallback(() => {
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }, []);

  const pushUndo = useCallback((snapshot: ImageData) => {
    undoRef.current.push(snapshot);
    const limit = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(HISTORY_BYTES / snapshot.data.byteLength)));
    while (undoRef.current.length > limit) undoRef.current.shift();
    redoRef.current = [];
    syncHistory();
  }, [syncHistory]);

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(canvas.width - 1, Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height))),
    };
  }, []);

  const paintAt = useCallback((x: number, y: number) => {
    const imageData = imageDataRef.current;
    if (!imageData || (mode === 'restore' && !colorSourceRef.current)) return false;
    const { width, height, data } = imageData;
    const source = colorSourceRef.current?.data;
    const radius = Math.max(1, brushSize / 2);
    const radiusSquared = radius * radius;
    const hardRadius = radius * Math.max(0, Math.min(100, hardness)) / 100;
    const feather = Math.max(0.0001, radius - hardRadius);
    const minX = Math.max(0, Math.floor(x - radius));
    const maxX = Math.min(width - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius));
    const maxY = Math.min(height - 1, Math.ceil(y + radius));
    let changed = false;
    lastPoint.current = { x, y };

    for (let py = minY; py <= maxY; py += 1) {
      const dy = py - y;
      for (let px = minX; px <= maxX; px += 1) {
        const dx = px - x;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > radiusSquared) continue;
        const distance = Math.sqrt(distanceSquared);
        const strength = distance <= hardRadius ? 1 : Math.max(0, 1 - (distance - hardRadius) / feather);
        const index = (py * width + px) * 4;
        const currentAlpha = data[index + 3];
        const nextAlpha = mode === 'restore'
          ? Math.max(currentAlpha, Math.round(255 * strength))
          : Math.round(currentAlpha * (1 - strength));
        if (nextAlpha === currentAlpha) continue;
        if (mode === 'restore' && source) {
          data[index] = source[index];
          data[index + 1] = source[index + 1];
          data[index + 2] = source[index + 2];
        }
        data[index + 3] = nextAlpha;
        changed = true;
      }
    }
    if (changed) {
      if (!strokeHasSnapshot.current) {
        const snapshot = strokeStartData.current;
        if (snapshot) pushUndo(snapshot);
        strokeHasSnapshot.current = true;
      }
      drawCurrent();
      setDirty(true);
    }
    return changed;
  }, [brushSize, drawCurrent, hardness, mode, pushUndo]);

  const applyPrecise = useCallback((x: number, y: number, preciseMode: 'leak' | 'recover') => {
    const imageData = imageDataRef.current;
    if (!imageData || (preciseMode === 'recover' && !colorSourceRef.current)) return false;
    const { width, height, data } = imageData;
    const seedIndex = (y * width + x) * 4;
    const seedAlpha = data[seedIndex + 3];
    const seedColor: [number, number, number] = [data[seedIndex], data[seedIndex + 1], data[seedIndex + 2]];
    const radius = Math.max(8, brushSize);
    const minX = Math.max(0, Math.floor(x - radius));
    const maxX = Math.min(width - 1, Math.ceil(x + radius));
    const minY = Math.max(0, Math.floor(y - radius));
    const maxY = Math.min(height - 1, Math.ceil(y + radius));
    const regionWidth = maxX - minX + 1;
    const regionHeight = maxY - minY + 1;
    const visited = new Uint8Array(regionWidth * regionHeight);
    const stack: number[] = [(y - minY) * regionWidth + (x - minX)];
    const radiusSquared = radius * radius;
    const colorTolerance = preciseMode === 'leak' ? 44 : 58;
    const alphaTolerance = preciseMode === 'leak' ? 140 : 190;
    const maxRecoverAlpha = Math.max(120, Math.min(220, seedAlpha + 130));
    const source = colorSourceRef.current?.data;
    let changed = false;

    while (stack.length) {
      const local = stack.pop() as number;
      if (visited[local]) continue;
      visited[local] = 1;
      const px = minX + local % regionWidth;
      const py = minY + Math.floor(local / regionWidth);
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > radiusSquared) continue;
      const index = (py * width + px) * 4;
      const alpha = data[index + 3];
      const alphaClose = Math.abs(alpha - seedAlpha) <= alphaTolerance;
      const rgbClose = colorDistance(data, index, seedColor) <= colorTolerance;
      const selectable = preciseMode === 'leak'
        ? alphaClose && (rgbClose || alpha < 80 || seedAlpha < 80)
        : alpha <= maxRecoverAlpha && (rgbClose || alpha < 16 || seedAlpha < 16);
      if (!selectable) continue;

      if (preciseMode === 'leak') {
        if (alpha !== 0) {
          data[index + 3] = 0;
          changed = true;
        }
      } else if (alpha !== 255 && source) {
        data[index] = source[index];
        data[index + 1] = source[index + 1];
        data[index + 2] = source[index + 2];
        data[index + 3] = 255;
        changed = true;
      }

      if (px < maxX) stack.push(local + 1);
      if (px > minX) stack.push(local - 1);
      if (py < maxY) stack.push(local + regionWidth);
      if (py > minY) stack.push(local - regionWidth);
    }

    if (changed) {
      drawCurrent();
      setDirty(true);
    }
    return changed;
  }, [brushSize, drawCurrent]);

  const startPainting = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || disabled || applying || event.button !== 0) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    lastPoint.current = point;
    if (mode === 'leak' || mode === 'recover') {
      const before = imageDataRef.current;
      if (!before) return;
      const snapshot = cloneImageData(before);
      if (applyPrecise(point.x, point.y, mode)) pushUndo(snapshot);
      return;
    }
    paintingRef.current = true;
    strokeHasSnapshot.current = false;
    strokeStartData.current = imageDataRef.current ? cloneImageData(imageDataRef.current) : null;
    event.currentTarget.setPointerCapture(event.pointerId);
    paintAt(point.x, point.y);
  };

  const continuePainting = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!paintingRef.current || !ready || disabled || applying) return;
    const point = pointFromEvent(event);
    if (point) {
      const previous = lastPoint.current || point;
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(1, brushSize / 4)));
      for (let i = 1; i <= steps; i++) paintAt(Math.round(previous.x + (point.x - previous.x) * i / steps), Math.round(previous.y + (point.y - previous.y) * i / steps));
    }
  };

  const stopPainting = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    paintingRef.current = false;
    strokeHasSnapshot.current = false;
    strokeStartData.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
  };

  const undo = () => {
    const current = imageDataRef.current;
    const previous = undoRef.current.pop();
    if (!current || !previous) return;
    redoRef.current.push(cloneImageData(current));
    imageDataRef.current = previous;
    drawCurrent();
    setDirty(!samePixels(previous, baseImageDataRef.current));
    syncHistory();
    setAnnouncement('已撤销');
  };

  const redo = () => {
    const current = imageDataRef.current;
    const next = redoRef.current.pop();
    if (!current || !next) return;
    undoRef.current.push(cloneImageData(current));
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    imageDataRef.current = next;
    drawCurrent();
    setDirty(!samePixels(next, baseImageDataRef.current));
    syncHistory();
    setAnnouncement('已重做');
  };

  const resetDraft = async () => {
    if (!dirty) return;
    const accepted = await confirm('放弃尚未应用的画笔修改，并恢复到当前结果图。原图和服务端文件不会被删除。', {
      title: '清除画笔修改',
      confirmLabel: '放弃修改',
      danger: true,
    });
    if (!accepted) return;
    imageDataRef.current = baseImageDataRef.current ? cloneImageData(baseImageDataRef.current) : null;
    undoRef.current = [];
    redoRef.current = [];
    syncHistory();
    drawCurrent();
    setDirty(false);
    setError('');
    setAnnouncement('已恢复当前结果图');
  };

  const apply = async () => {
    const currentGeneration = generation.current;
    const current = imageDataRef.current;
    if (!current || !dirty || applying || disabled) return;
    setApplying(true);
    setError('');
    try {
      const resultCanvas = document.createElement('canvas');
      resultCanvas.width = current.width;
      resultCanvas.height = current.height;
      const resultContext = resultCanvas.getContext('2d');
      if (!resultContext) throw new Error('无法导出修复结果。');
      resultContext.putImageData(cloneImageData(current), 0, 0);
      const resultBlob = await canvasToBlob(resultCanvas);

      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = current.width;
      maskCanvas.height = current.height;
      const maskContext = maskCanvas.getContext('2d');
      if (!maskContext) throw new Error('无法导出遮罩。');
      const mask = maskContext.createImageData(current.width, current.height);
      for (let i = 0; i < current.data.length; i += 4) {
        const alpha = current.data[i + 3];
        mask.data[i] = alpha;
        mask.data[i + 1] = alpha;
        mask.data[i + 2] = alpha;
        mask.data[i + 3] = 255;
      }
      maskContext.putImageData(mask, 0, 0);
      const maskBlob = await canvasToBlob(maskCanvas);
      if (currentGeneration !== generation.current) return;
      await onApply(resultBlob, maskBlob);
      if (currentGeneration !== generation.current) return;
      const updatedBase = imageDataRef.current;
      baseImageDataRef.current = updatedBase ? cloneImageData(updatedBase) : null;
      undoRef.current = [];
      redoRef.current = [];
      syncHistory();
      setDirty(false);
      setAnnouncement('修复结果已应用');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '应用修复失败，修改仍保留在画布中。');
    } finally {
      setApplying(false);
    }
  };

  const preview = previewOpen && resultUrl
    ? <ZoomableImagePreview src={resultUrl} alt={filename ? `${filename} 修复结果预览` : '修复结果预览'} fileName={filename} onClose={() => setPreviewOpen(false)} />
    : null;

  return (
    <>
      <section className={styles.editor} aria-label="画笔修复编辑器" aria-busy={applying}>
        <header className={styles.editorHeader}>
          <div>
            <h3>画笔细修</h3>
            <p>{dimensions ? `${dimensions.width} × ${dimensions.height} px` : '载入结果图中…'}{dirty ? ' · 有未应用修改' : ''}</p>
          </div>
          <div className={styles.toolbar}>
            <button type="button" className={styles.iconButton} title="撤销" aria-label="撤销" onClick={undo} disabled={disabled || applying || !canUndo}><Undo2 size={16} /></button>
            <button type="button" className={styles.iconButton} title="重做" aria-label="重做" onClick={redo} disabled={disabled || applying || !canRedo}><Redo2 size={16} /></button>
            <button type="button" className={styles.iconButton} title="恢复当前结果图" aria-label="恢复当前结果图" onClick={() => void resetDraft()} disabled={disabled || applying || !dirty}><RotateCcw size={16} /></button>
            <button type="button" className={styles.iconButton} title="放大预览" aria-label="放大预览" onClick={() => setPreviewOpen(true)} disabled={!ready}><ImageIcon size={16} /></button>
          </div>
        </header>

        <div className={styles.brushToolbar} aria-label="画笔设置">
          <div className={styles.segmented} role="group" aria-label="修复模式">
            <button type="button" className={mode === 'restore' ? styles.segmentActive : styles.segment} aria-pressed={mode === 'restore'} title={restoreReason || '使用匹配的原图像素补回透明区域'} onClick={() => setMode('restore')} disabled={disabled || applying || !colorSourceRef.current}><Brush size={15} />补回</button>
            <button type="button" className={mode === 'erase' ? styles.segmentActive : styles.segment} aria-pressed={mode === 'erase'} onClick={() => setMode('erase')} disabled={disabled || applying}><Eraser size={15} />擦除</button>
            <button type="button" className={mode === 'leak' ? styles.segmentActive : styles.segment} aria-pressed={mode === 'leak'} title="点击需要清除的漏底或夹缝区域" onClick={() => setMode('leak')} disabled={disabled || applying}>清漏底</button>
            <button type="button" className={mode === 'recover' ? styles.segmentActive : styles.segment} aria-pressed={mode === 'recover'} title={restoreReason || '按连通区域恢复误删像素'} onClick={() => setMode('recover')} disabled={disabled || applying || !colorSourceRef.current}>修复误删</button>
          </div>
          <label className={styles.rangeField}>
            <span>笔刷 {brushSize} px</span>
            <input type="range" min="4" max="120" step="2" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} disabled={disabled || applying} />
          </label>
          <label className={styles.rangeField}>
            <span>硬度 {hardness}%</span>
            <input type="range" min="0" max="100" step="5" value={hardness} onChange={(event) => setHardness(Number(event.target.value))} disabled={disabled || applying} />
          </label>
          <button type="button" className={styles.applyButton} onClick={() => void apply()} disabled={disabled || applying || !ready || !dirty}>
            {applying ? '应用中…' : '应用修复'}
          </button>
        </div>

        {restoreReason && <p className={styles.inlineNotice} role="status">{restoreReason}</p>}
        <div className={styles.brushStage}>
          <canvas
            ref={canvasRef}
            className={styles.paintCanvas}
            aria-label={`${filename || '当前结果图'}画笔修复画布`}
            tabIndex={0}
            onPointerDown={startPainting}
            onPointerMove={continuePainting}
            onPointerUp={stopPainting}
            onPointerCancel={stopPainting}
            onLostPointerCapture={() => { paintingRef.current = false; strokeHasSnapshot.current = false; strokeStartData.current = null; }}
          />
          {!ready && <div className={styles.loadingOverlay} role={error ? 'alert' : 'status'}>{error || '载入结果图…'}</div>}
        </div>
        <div className={styles.brushFooter}>
          <div className={styles.sourceStrip}>
            <button type="button" className={styles.sourceThumb} onClick={() => setPreviewOpen(true)} onDoubleClick={() => setPreviewOpen(true)} disabled={!ready} aria-label="放大查看修复结果">
              {resultUrl && <img src={resultUrl} alt="修复结果缩略图" draggable={false} />}
              <span>结果</span>
            </button>
            {originalUrl
              ? <div className={styles.sourceThumb} aria-label="原图">
                  <img src={originalUrl} alt="原图缩略图" draggable={false} />
                  <span>原图</span>
                </div>
              : <div className={styles.sourceThumbUnavailable}>原图不可用</div>}
          </div>
          <span>{mode === 'restore' ? '补回主体' : mode === 'erase' ? '擦除背景' : mode === 'leak' ? '精准清漏底' : '精准修复误删'}{lastPoint.current ? ` · 最近位置 ${lastPoint.current.x}, ${lastPoint.current.y}` : ''}</span>
        </div>
        {error && ready && <p className={styles.errorNotice} role="alert">{error}</p>}
      </section>
      {productDialog}
      {preview}
      <span className={styles.srOnly} aria-live="polite">{announcement}</span>
    </>
  );
}
