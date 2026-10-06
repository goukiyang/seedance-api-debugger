'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, Check, Copy, Plus, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { copyImage } from '@/lib/media/copy-image';
import styles from './ZoomableImagePreview.module.css';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import type { ContentKey } from '@/lib/content-reactions/types';
import { isSafeIdentifier, useMediaPreviewState, type MediaPreviewZoomMode } from '@/lib/hooks/use-media-preview-state';
import { useImageReadProgress } from '@/lib/hooks/use-image-read-progress';
import { isTopmostDialogLayer, useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useImagePreviewHistoryDismiss } from './useImagePreviewHistoryDismiss';
import { ImageComparisonPicker } from './ImageComparisonPicker';
import {
  fittedImageView, imageSourceIdentity, sourcePickerKey, resolveComparisonImage,
  readComparisonPreferences, saveComparisonPreferences, readImageView, saveImageView,
  readComparisonSelection, saveComparisonSelection,
  type ImageComparisonSource, type ImageView,
} from '@/lib/media/image-comparison';

export type { ImageComparisonSource } from '@/lib/media/image-comparison';

export type ImagePreviewMetadata = {
  /** Legacy input only. Never rendered by the preview. */
  context?: string;
  model?: string;
  quality?: string;
  ratio?: string;
  resolution?: string;
  time?: string;
};

export type SafeImagePreviewDetails = Omit<ImagePreviewMetadata, 'context'> & { width?: number; height?: number };

type ZoomableImagePreviewProps = {
  src: string;
  alt: string;
  fileName?: string;
  title?: string;
  previewKey?: string;
  contentKey?: ContentKey;
  imageSharing?: boolean;
  metadata?: ImagePreviewMetadata;
  safeDetails?: SafeImagePreviewDetails;
  comparison?: ImageComparisonSource;
  comparisonCandidates?: ImageComparisonSource[];
  sourceVersion?: string;
  /** Caller-provided status/reactions/file metadata only; remove prompts before passing. */
  details?: ReactNode;
  notice?: ReactNode;
  hasNavigation?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onImageLoaded?: (src: string) => void;
  onClose: () => void;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 24;
const SCALE_STEP = 1.2;

type IntrinsicSize = { width: number; height: number };

function safeImageLabel(title?: string, fileName?: string) {
  const trimmedTitle = title?.trim();
  if (trimmedTitle && /^(?:生成结果|图片预览)\s+\d{1,5}$/.test(trimmedTitle)) return trimmedTitle;
  const trimmedFileName = fileName?.trim();
  if (trimmedFileName && /^(?:IMG[_-]\d{3,10}|(?:image|output|result)[_-]\d{1,8})\.(?:png|jpe?g|webp|avif|gif)$/i.test(trimmedFileName)) return trimmedFileName;
  return '图片预览';
}

function safeMetadataValue(value?: string) {
  const text = value?.trim();
  if (!text || text.length > 32 || /[<>\r\n,;!?]/.test(text) || text.split(/\s+/).length > 3) return undefined;
  return text;
}

function safeMetadataTime(value?: string) {
  const text = value?.trim();
  if (!text || text.length > 32 || !/^[\d年月日时分秒TtZz:./+\- ]+$/.test(text)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : undefined;
  }
  return text;
}

function clampScale(value: number, maximum = MAX_SCALE) {
  return Math.min(maximum, Math.max(MIN_SCALE, value));
}


function displaySource(src: string, mode: 'preview' | 'thumbnail' | 'original') {
  if (!/^\/api\/image-studio\/(?:assets|template-assets)\//.test(src)) return src;
  const url = new URL(src, 'https://sd2.youdooart.com');
  url.searchParams.delete('thumbnail');
  url.searchParams.delete('preview');
  if (mode !== 'original') url.searchParams.set(mode, '1');
  return `${url.pathname}${url.search}`;
}

function formatImageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function PreviewImage({ src, alt, original, className, style, onReady, hidden = false, onFailure }: { src: string; alt: string; original: boolean; className: string; style: CSSProperties; onReady?: (size: IntrinsicSize) => void; hidden?: boolean; onFailure?: () => void }) {
  const image = useRef<HTMLImageElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [failedKey, setFailedKey] = useState('');
  const displaySrc = displaySource(src, original ? 'original' : 'preview');
  const thumbnail = displaySource(src, 'thumbnail');
  const key = `${displaySrc}:${attempt}`;
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;
  const readResult = useImageReadProgress(displaySrc, attempt);
  const readProgress = readResult.progress;
  const imageSrc = readResult.imageSrc || undefined;
  const loaded = loadedKey === key;
  const unsupported = readProgress.phase === 'unsupported';
  const failed = failedKey === key || unsupported;
  const failureCallbackRef = useRef(onFailure); failureCallbackRef.current = onFailure;
  useEffect(() => { if (failed) failureCallbackRef.current?.(); }, [failed]);
  useEffect(() => {
    if (loaded || unsupported) return;
    if (image.current?.complete && image.current.naturalWidth > 0) {
      setLoadedKey(key);
      onReadyRef.current?.({ width: image.current.naturalWidth, height: image.current.naturalHeight });
      return;
    }
    if (readProgress.phase === 'reading') return;
    const timer = window.setTimeout(() => setFailedKey(key), 30000);
    return () => window.clearTimeout(timer);
  }, [key, loaded, readProgress.phase, unsupported]);
  const progressLabel = readProgress.phase === 'unsupported'
    ? readProgress.message || '该来源不是图片，未读取文件内容'
    : readProgress.phase === 'unavailable'
      ? readProgress.message || '当前来源无法提供读取进度'
      : readProgress.phase === 'decoding' ? '正在解码' : '正在读取';
  return <>
    {!hidden && thumbnail !== src && !loaded && <img src={thumbnail} alt="" aria-hidden="true" className={className} style={style} draggable={false} />}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {imageSrc && <img ref={image} key={key} src={imageSrc} alt={alt} className={className} style={{ ...style, opacity: loaded && !hidden ? 1 : 0 }} draggable={false} data-image-preview-image
      onLoad={event => { if (currentKeyRef.current !== key) return; setLoadedKey(key); setFailedKey(''); onReadyRef.current?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }} onError={() => { if (currentKeyRef.current === key) setFailedKey(key); }} />}
    {!loaded && !hidden && <div className={styles.imageStatus} role="status">
      <span>{failed ? (unsupported ? progressLabel : '图片未能加载') : `${alt} · ${original ? '完整原图' : '高清预览'} · ${progressLabel}`}</span>
      {failed && !unsupported && readProgress.phase === 'unavailable' && <span>{readProgress.message || '当前来源无法提供读取进度'}</span>}
      {!failed && readProgress.phase === 'reading' && readProgress.percent != null && <>
        <progress className={styles.imageProgress} max={100} value={readProgress.percent} aria-label={`${alt}读取进度 ${readProgress.percent}%`} />
        {readProgress.totalBytes != null && <span>{readProgress.percent}% · {formatImageBytes(readProgress.loadedBytes)} / {formatImageBytes(readProgress.totalBytes)}</span>}
      </>}
      {!failed && readProgress.phase === 'reading' && readProgress.percent == null && <span>已读取 {formatImageBytes(readProgress.loadedBytes)}</span>}
      {!failed && readProgress.phase === 'decoding' && <span>已读取 {formatImageBytes(readProgress.loadedBytes)}</span>}
      {failed && !unsupported && <button type="button" title="重新加载" aria-label="重新加载图片" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}><RotateCcw size={16} /></button>}
    </div>}
  </>;
}


type Side = 'current' | 'comparison';
type Point = { x: number; y: number };
type Frames = Record<Side, IntrinsicSize>;
type PendingImage = { source: ImageComparisonSource; token: number };
type ImageRequest = { token: number; controller: AbortController; resolve: (applied: boolean) => void; reject: (error: Error) => void };
const sides: Side[] = ['current', 'comparison'];
const viewIdentity = (side: Side, image: ImageComparisonSource) => imageSourceIdentity(image) + ':' + side;

export function ZoomableImagePreview({ src, alt, fileName, title, previewKey, sourceVersion, contentKey, imageSharing = true, metadata, safeDetails, comparison, comparisonCandidates = [], details, notice, hasNavigation, onPrevious, onNext, onImageLoaded, onClose }: ZoomableImagePreviewProps) {
  const { user, hasLoadedUser } = useAppSession();
  const owner = user?.id || '';
  const backdropRef = useRef<HTMLDivElement>(null), toolbarRef = useRef<HTMLDivElement>(null), stageRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<Partial<Record<Side, HTMLDivElement>>>({});
  const portalAnchorRef = useRef<HTMLSpanElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const incoming: ImageComparisonSource = { src, alt, fileName, id: previewKey, version: sourceVersion, contentKey };
  const [currentImage, setCurrentImage] = useState<ImageComparisonSource>(incoming);
  const [comparisonImage, setComparisonImage] = useState<ImageComparisonSource | null>(comparison || null);
  const sources = { current: currentImage, comparison: comparisonImage };
  const sourcesRef = useRef(sources); sourcesRef.current = sources;
  const [comparisonMode, setComparisonMode] = useState(false), [linked, setLinked] = useState(false);
  const [axis, setAxis] = useState<'horizontal' | 'vertical'>('horizontal'), [activeSide, setActiveSide] = useState<Side>('current');
  const [pickerSide, setPickerSide] = useState<Side | null>(null);
  const [pending, setPending] = useState<Partial<Record<Side, PendingImage>>>({});
  const requests = useRef<Partial<Record<Side, ImageRequest>>>({}), sequence = useRef(0);
  const [views, setViews] = useState<Record<string, ImageView>>({});
  const viewsRef = useRef(views); viewsRef.current = views;
  const [sizes, setSizes] = useState<Record<string, IntrinsicSize>>({});
  const [originals, setOriginals] = useState<Record<string, boolean>>({});
  const [frames, setFrames] = useState<Frames>({ current: { width: 1, height: 1 }, comparison: { width: 1, height: 1 } });
  const [message, setMessage] = useState(''), [copyState, setCopyState] = useState<{ src: string; busy?: boolean; success?: boolean; message?: string } | null>(null);
  const points = useRef<Record<Side, Map<number, Point>>>({ current: new Map(), comparison: new Map() });
  const zoomPoints = useRef<Partial<Record<Side, Point>>>({});
  const localUrls = useRef(new Set<string>());
  const alive = useRef(true), userAction = useRef(0);
  const [initializedOwner, setInitializedOwner] = useState<string | null>(null);
  const dismissPreview = useImagePreviewHistoryDismiss(Boolean(portalRoot), backdropRef, onClose);
  const dimensionsTooltipId = useId();
  const safeSide = comparisonMode && comparisonImage ? activeSide : 'current';
  const safeSideRef = useRef(safeSide); safeSideRef.current = safeSide;
  const selectedImage = sources[safeSide] || currentImage;
  const identity = (image: ImageComparisonSource) => imageSourceIdentity(image);
  const selectedId = identity(selectedImage);
  const selectedView = views[viewIdentity(safeSide, selectedImage)] || fittedImageView;
  const imageTitle = safeImageLabel(title, fileName);
  const isOriginalSubject = selectedImage.src === src && selectedImage.contentKey === contentKey;
  const anchor = isSafeIdentifier(previewKey) ? previewKey : contentKey || sourcePickerKey(incoming);
  const selectionAnchor = anchor ? anchor + '@' + imageSourceIdentity(incoming) : null;
  const pair = [identity(currentImage), comparisonImage ? identity(comparisonImage) : 'single'].sort().join('|');
  const legacyState = useMediaPreviewState(previewKey, contentKey, src);
  const configRef = useRef({ linked, comparisonMode, axis, owner, pair, selectionAnchor });
  configRef.current = { linked, comparisonMode, axis, owner, pair, selectionAnchor };

  const stopGestures = useCallback(() => {
    for (const side of sides) {
      const pane = paneRefs.current[side];
      for (const id of points.current[side].keys()) { if (pane?.hasPointerCapture(id)) pane.releasePointerCapture(id); }
      points.current[side].clear();
    }
  }, []);
  const cancelRequests = useCallback(() => {
    for (const request of Object.values(requests.current)) { request?.controller.abort(); request?.resolve(false); }
    requests.current = {}; setPending({});
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stopGestures(); for (const request of Object.values(requests.current)) { request?.controller.abort(); request?.resolve(false); }
      for (const url of localUrls.current) URL.revokeObjectURL(url); localUrls.current.clear(); };
  }, [stopGestures]);

  const requestImage = useCallback((side: Side, image: ImageComparisonSource, verify = true): Promise<boolean> => {
    stopGestures();
    const previous = requests.current[side]; previous?.controller.abort(); previous?.resolve(false);
    const token = ++sequence.current, controller = new AbortController();
    return new Promise((resolve, reject) => {
      const request = { token, controller, resolve, reject }; requests.current[side] = request;
      void (async () => {
        const key = sourcePickerKey(image);
        const refreshed = verify && key ? await resolveComparisonImage(key, controller.signal) : image;
        if (!alive.current || requests.current[side] !== request) { resolve(false); return; }
        // Keep caller metadata for the same version, but always use the freshly authorized URL.
        const next = { ...image, ...refreshed, alt: image.alt, ...(image.version ? { version: image.version } : {}) };
        const existing = sourcesRef.current[side];
        if (existing?.src === next.src && existing.version === next.version && imageSourceIdentity(existing) === imageSourceIdentity(next)) {
          if (side === 'comparison') setComparisonMode(true);
          delete requests.current[side]; setPending(value => ({ ...value, [side]: undefined })); resolve(true); return;
        }
        setMessage('');
        setPending(value => ({ ...value, [side]: { source: next, token } }));
        if (side === 'comparison' && !sourcesRef.current.comparison) setComparisonMode(true);
      })().catch(error => {
        if (requests.current[side] !== request || !alive.current) { resolve(false); return; }
        delete requests.current[side]; setPending(value => ({ ...value, [side]: undefined }));
        const failure = error instanceof Error ? error : new Error('图片无法加载，原图保留');
        setMessage(failure.message); reject(failure);
      });
    });
  }, [stopGestures]);

  const originalOwner = useRef<string | null>(null);
  const initialSource = useRef(imageSourceIdentity(incoming));
  useEffect(() => {
    if (!hasLoadedUser || !portalRoot) return;
    if (originalOwner.current !== null && originalOwner.current !== owner) { cancelRequests(); onClose(); return; }
    originalOwner.current = owner;
    const preferences = owner ? readComparisonPreferences(owner) : {};
    setLinked(preferences.linked ?? false);
    setAxis(preferences.axis || (window.matchMedia('(max-width: 640px)').matches ? 'vertical' : 'horizontal'));
    setInitializedOwner(owner);
    if (!owner || !selectionAnchor) return;
    const saved = readComparisonSelection(owner, selectionAnchor), action = userAction.current;
    const controller = new AbortController();
    void (async () => {
      const restored = saved.comparison ? await resolveComparisonImage(saved.comparison.key, controller.signal) : null;
      if (!alive.current || controller.signal.aborted || userAction.current !== action) return;
      if (restored && imageSourceIdentity(restored) === saved.comparison?.identity) {
        await requestImage('comparison', restored, false);
        if (!alive.current || controller.signal.aborted || userAction.current !== action) return;
        setComparisonMode(saved.enabled);
      } else if (saved.comparison) setMessage('上次对比图已失效，请重新选择');
      if (saved.current && saved.current.identity !== initialSource.current) {
        const restoredCurrent = await resolveComparisonImage(saved.current.key, controller.signal);
        if (!alive.current || controller.signal.aborted || userAction.current !== action) return;
        if (imageSourceIdentity(restoredCurrent) === saved.current.identity) await requestImage('current', restoredCurrent, false);
      }
    })().catch(() => { if (alive.current && !controller.signal.aborted && userAction.current === action) setMessage('上次图片无法恢复，原图保留，请重新选择'); });
    return () => controller.abort();
  // Restore once per account/opening; explicit navigation must not replay an old selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, hasLoadedUser, portalRoot]);

  const incomingIdentity = JSON.stringify([src, previewKey, sourceVersion]);
  const lastIncoming = useRef(incomingIdentity);
  useEffect(() => {
    if (lastIncoming.current === incomingIdentity) return;
    lastIncoming.current = incomingIdentity; userAction.current++;
    void requestImage('current', incoming, false).catch(() => {});
  // The reference supplied for a new current image must not replace the chosen comparison.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingIdentity, requestImage]);

  useEffect(() => {
    const nativeDialog = portalAnchorRef.current?.closest('dialog[open]');
    try { setPortalRoot(nativeDialog?.matches(':modal') ? nativeDialog as HTMLElement : document.body); }
    catch { setPortalRoot(document.body); }
  }, []);
  useDialogDismiss({ open: Boolean(portalRoot), dialogRef: backdropRef, dismissSurfaceRef: backdropRef,
    onDismiss: dismissPreview, initialFocusRef: backdropRef,
    isDismissTarget: target => target === backdropRef.current || target === stageRef.current });
  useEffect(() => {
    const elements = [document.documentElement, document.body];
    const previous = elements.map(element => ({ overflow: element.style.overflow, overscrollBehavior: element.style.overscrollBehavior }));
    elements.forEach(element => { element.style.overflow = 'hidden'; element.style.overscrollBehavior = 'none'; });
    return () => elements.forEach((element, index) => { element.style.overflow = previous[index].overflow; element.style.overscrollBehavior = previous[index].overscrollBehavior; });
  }, []);
  useEffect(() => {
    const toolbar = toolbarRef.current, root = backdropRef.current, stage = stageRef.current;
    if (!toolbar || !root || !stage) return;
    const measure = () => {
      root.style.setProperty('--image-toolbar-height', Math.ceil(toolbar.getBoundingClientRect().height) + 'px');
      setFrames(value => {
        const next = { ...value }; let changed = false;
        for (const side of sides) { const pane = paneRefs.current[side]; if (!pane) continue;
          const size = { width: Math.max(1, pane.clientWidth), height: Math.max(1, pane.clientHeight) };
          if (size.width !== value[side].width || size.height !== value[side].height) { next[side] = size; changed = true; }
        }
        return changed ? next : value;
      });
    };
    const observer = new ResizeObserver(measure); observer.observe(toolbar); observer.observe(stage);
    for (const pane of Object.values(paneRefs.current)) if (pane) observer.observe(pane);
    measure(); return () => observer.disconnect();
  }, [portalRoot, comparisonMode, axis]);

  function baseSize(side: Side, image = sourcesRef.current[side]): IntrinsicSize {
    const frame = frames[side], size = image && sizes[imageSourceIdentity(image)];
    if (!size) return { width: Math.max(1, frame.width - 24), height: Math.max(1, frame.height - 24) };
    const fit = Math.min((frame.width - 24) / size.width, (frame.height - 24) / size.height, 1);
    return { width: Math.max(1, size.width * fit), height: Math.max(1, size.height * fit) };
  }
  const geometryRef = useRef({ frames, baseSize }); geometryRef.current = { frames, baseSize };
  useEffect(() => {
    if (initializedOwner !== owner || !owner) return;
    setViews(value => {
      const next = { ...value }; let changed = false;
      for (const side of sides) {
        const image = sourcesRef.current[side];
        if (!image) continue; const id = viewIdentity(side, image); if (next[id]) continue;
        next[id] = readImageView(owner, id, pair, axis) || readImageView(owner, imageSourceIdentity(image), pair, axis) || { ...fittedImageView }; changed = true;
      }
      return changed ? next : value;
    });
  }, [axis, comparisonImage, currentImage, initializedOwner, owner, pair]);
  const legacyRestored = useRef(false);
  useEffect(() => {
    if (legacyRestored.current || !legacyState.ready || initializedOwner !== owner || !owner) return;
    const id = imageSourceIdentity(incoming);
    if (readImageView(owner, id, pair, axis) || userAction.current) { legacyRestored.current = true; return; }
    const size = sizes[id]; if (!size) return;
    legacyRestored.current = true;
    const base = baseSize('current', incoming), saved = legacyState.value;
    setViews(value => ({ ...value, [viewIdentity('current', incoming)]: { scale: saved.scale, x: saved.offsetX / base.width, y: saved.offsetY / base.height, mode: saved.zoomMode } }));
  // The existing single-image pixel record is converted once after its image/frame is known.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyState.ready, initializedOwner, owner, sizes]);

  const sceneRef = useRef({ currentImage, comparisonImage, comparisonMode, initializedOwner }); sceneRef.current = { currentImage, comparisonImage, comparisonMode, initializedOwner };
  const flush = useCallback(() => {
    const config = configRef.current, scene = sceneRef.current;
    if (!config.owner || scene.initializedOwner !== config.owner) return;
    saveComparisonPreferences(config.owner, { linked: config.linked, axis: config.axis });
    for (const side of sides) {
      const image = side === 'current' ? scene.currentImage : scene.comparisonImage;
      if (!image) continue; const id = viewIdentity(side, image), view = viewsRef.current[id]; if (!view) continue;
      saveImageView(config.owner, id, config.pair.includes('blob:') ? 'session' : config.pair, config.axis, view);
      if (side === safeSideRef.current) saveImageView(config.owner, imageSourceIdentity(image), config.pair.includes('blob:') ? 'session' : config.pair, config.axis, view);
    }
    if (config.selectionAnchor) saveComparisonSelection(config.owner, config.selectionAnchor, scene.currentImage, scene.comparisonImage, scene.comparisonMode);
  }, []);
  useEffect(() => { const timer = window.setTimeout(flush, 250); return () => window.clearTimeout(timer); }, [views, linked, axis, currentImage, comparisonImage, comparisonMode, initializedOwner, flush]);
  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', visibility);
    return () => { flush(); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility); };
  }, [flush]);

  const transform = useCallback((side: Side, factor: number, from: Point, to: Point = from) => {
    userAction.current++; setActiveSide(side);
    setViews(current => {
      const next = { ...current }, config = configRef.current;
      const targets = config.linked && config.comparisonMode ? sides : [side];
      for (const target of targets) {
        const image = sourcesRef.current[target]; if (!image) continue;
        const id = viewIdentity(target, image), value = current[id] || fittedImageView;
        const frame = geometryRef.current.frames[target], base = geometryRef.current.baseSize(target);
        const scale = clampScale(value.scale * factor, value.mode === 'actual' || value.scale > MAX_SCALE ? 1_000_000 : MAX_SCALE);
        const ratio = scale / value.scale;
        next[id] = { scale, x: to.x * frame.width / base.width - (from.x * frame.width / base.width - value.x) * ratio,
          y: to.y * frame.height / base.height - (from.y * frame.height / base.height - value.y) * ratio, mode: 'custom' };
      }
      viewsRef.current = next; return next;
    });
  }, []);
  const pointInPane = useCallback((side: Side, point: Point): Point => {
    const rect = paneRefs.current[side]!.getBoundingClientRect();
    return { x: (point.x - rect.left) / Math.max(1, rect.width) - 0.5, y: (point.y - rect.top) / Math.max(1, rect.height) - 0.5 };
  }, []);
  const reset = useCallback((both = false) => {
    userAction.current++; stopGestures();
    setViews(value => {
      const next = { ...value };
      for (const side of both ? sides : [safeSide]) { const image = sourcesRef.current[side]; if (image) next[viewIdentity(side, image)] = { ...fittedImageView }; }
      viewsRef.current = next; return next;
    });
  }, [safeSide, stopGestures]);
  const zoomFromControls = useCallback((factor: number) => transform(safeSide, factor, zoomPoints.current[safeSide] || { x: 0, y: 0 }), [safeSide, transform]);
  function applyMode(mode: MediaPreviewZoomMode) {
    if (mode === 'custom') return;
    userAction.current++; stopGestures();
    setViews(value => {
      const next = { ...value };
      for (const side of linked && comparisonMode ? sides : [safeSide]) {
        const image = sourcesRef.current[side]; if (!image) continue;
        const id = viewIdentity(side, image), base = baseSize(side), size = sizes[imageSourceIdentity(image)];
        const scale = mode === 'fit' ? 1 : mode === 'width' ? (frames[side].width - 24) / base.width : size ? size.width / base.width : 1;
        next[id] = { scale: Math.max(MIN_SCALE, scale), x: 0, y: 0, mode };
      }
      viewsRef.current = next; return next;
    });
  }
  useEffect(() => {
    const wheel = (event: WheelEvent) => {
      if (!isTopmostDialogLayer(backdropRef.current) || !event.deltaY || !(event.target instanceof Element)) return;
      const pane = event.target.closest<HTMLElement>('[data-image-preview-pane]'); if (!pane || !stageRef.current?.contains(pane)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const side = pane.dataset.imagePreviewPane as Side, point = pointInPane(side, { x: event.clientX, y: event.clientY });
      zoomPoints.current[side] = point; transform(side, event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP, point);
    };
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', wheel, true);
  }, [pointInPane, transform]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!isTopmostDialogLayer(backdropRef.current) || event.target instanceof Element && event.target.closest('select, input, textarea, button, a[href], summary, [contenteditable]')) return;
      const key = event.key;
      if (!['ArrowLeft', 'ArrowRight', '+', '=', '-', '0'].includes(key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (key === 'ArrowLeft' && hasNavigation) onPrevious?.();
      if (key === 'ArrowRight' && hasNavigation) onNext?.();
      if (key === '+' || key === '=') zoomFromControls(SCALE_STEP);
      if (key === '-') zoomFromControls(1 / SCALE_STEP);
      if (key === '0') reset();
    };
    window.addEventListener('keydown', handle, true); return () => window.removeEventListener('keydown', handle, true);
  }, [hasNavigation, onNext, onPrevious, reset, zoomFromControls]);

  function pointerDown(side: Side, event: PointerEvent<HTMLDivElement>) {
    if (!isTopmostDialogLayer(backdropRef.current) || event.target instanceof Element && event.target.closest('button, a[href], input, select') || event.pointerType !== 'touch' && event.button !== 0) return;
    event.preventDefault(); userAction.current++; setActiveSide(side);
    points.current[side].set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(side: Side, event: PointerEvent<HTMLDivElement>) {
    const map = points.current[side];
    const nextPoint = { x: event.clientX, y: event.clientY };
    zoomPoints.current[side] = pointInPane(side, nextPoint);
    const previous = map.get(event.pointerId); if (!previous) return;
    const before = Array.from(map.values()).slice(0, 2);
    map.set(event.pointerId, nextPoint);
    const after = Array.from(map.values()).slice(0, 2);
    const centroid = (values: Point[]) => ({ x: values.reduce((sum, p) => sum + p.x, 0) / values.length, y: values.reduce((sum, p) => sum + p.y, 0) / values.length });
    const from = pointInPane(side, centroid(before)), to = pointInPane(side, centroid(after));
    const distance = (values: Point[]) => Math.max(1, Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y));
    transform(side, before.length === 2 ? distance(after) / distance(before) : 1, from, to);
  }
  function pointerEnd(side: Side, event: PointerEvent<HTMLDivElement>) {
    points.current[side].delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function ready(side: Side, image: ImageComparisonSource, token: number | undefined, size: IntrinsicSize) {
    if (!alive.current) return;
    const id = imageSourceIdentity(image);
    setSizes(value => value[id]?.width === size.width && value[id]?.height === size.height ? value : { ...value, [id]: size });
    if (token !== undefined) {
      const request = requests.current[side]; if (!request || request.token !== token || request.controller.signal.aborted) return;
      delete requests.current[side]; stopGestures();
      if (side === 'current') setCurrentImage(image);
      else { setComparisonImage(image); setComparisonMode(true); }
      setPending(value => ({ ...value, [side]: undefined }));
      setActiveSide(side); request.resolve(true);
    }
    onImageLoaded?.(image.src);
  }
  function failed(side: Side, token?: number) {
    const request = requests.current[side];
    if (token === undefined || !request || request.token !== token || !alive.current) return;
    delete requests.current[side]; setPending(value => ({ ...value, [side]: undefined }));
    setMessage('图片未能加载，原图保留，请重新选择'); request.reject(new Error('图片未能加载，原图保留，请重新选择'));
    if (side === 'comparison' && !sourcesRef.current.comparison) setComparisonMode(false);
  }
  function choose(side: Side, image: ImageComparisonSource) { userAction.current++; return requestImage(side, image); }
  async function chooseLocal(side: Side, file: File) {
    if (!file.type.startsWith('image/') || file.size > 64 * 1024 * 1024) throw new Error('请选择64MB以内的图片');
    const url = URL.createObjectURL(file); localUrls.current.add(url);
    try { const applied = await choose(side, { src: url, alt: '本机图片', fileName: file.name });
      if (!applied) { URL.revokeObjectURL(url); localUrls.current.delete(url); }
      else setMessage('本机图片仅本次预览，不上传、不跨重开保存');
      return applied;
    } catch (error) { URL.revokeObjectURL(url); localUrls.current.delete(url); throw error; }
  }
  function swap() {
    if (!comparisonImage) return;
    userAction.current++; stopGestures(); cancelRequests();
    setViews(value => ({ ...value, [viewIdentity('current', comparisonImage)]: value[viewIdentity('comparison', comparisonImage)] || { ...fittedImageView },
      [viewIdentity('comparison', currentImage)]: value[viewIdentity('current', currentImage)] || { ...fittedImageView } }));
    setCurrentImage(comparisonImage); setComparisonImage(currentImage); setActiveSide(activeSide === 'current' ? 'comparison' : 'current');
  }
  function pane(side: Side) {
    const image = sources[side], waiting = pending[side];
    const list = image ? [{ source: image, token: undefined as number | undefined }, ...(waiting ? [waiting] : [])] : waiting ? [waiting] : [];
    return <div key={side} ref={element => { if (element) paneRefs.current[side] = element; else delete paneRefs.current[side]; }}
      className={styles.comparePane} data-image-preview-pane={side} data-active={safeSide === side} role="group" aria-label={side === 'current' ? '当前图' : '对比图'} tabIndex={0}
      onFocus={() => setActiveSide(side)} onPointerDown={event => pointerDown(side, event)} onPointerMove={event => pointerMove(side, event)}
      onPointerUp={event => pointerEnd(side, event)} onPointerCancel={event => pointerEnd(side, event)} onLostPointerCapture={event => pointerEnd(side, event)}
      onDoubleClick={() => { setActiveSide(side); userAction.current++; setViews(value => ({ ...value, ...(image ? { [viewIdentity(side, image)]: { ...fittedImageView } } : {}) })); }}>
      {comparisonMode && <span className={styles.compareLabel}>{side === 'current' ? '当前图' : '对比图'}</span>}
      {list.map(entry => {
        const id = identity(entry.source), view = views[viewIdentity(side, entry.source)] || fittedImageView, base = baseSize(side, entry.source);
        const loading = entry.token !== undefined;
        return <PreviewImage key={id + ':' + entry.source.src + ':' + (entry.token ?? 'current')} src={entry.source.src} alt={side === 'current' ? '当前图' : '对比图'} original={originals[viewIdentity(side, entry.source)] || false}
          className={styles.compareImage} hidden={loading}
          style={{ width: sizes[id] ? base.width : undefined, height: sizes[id] ? base.height : undefined,
            transform: 'translate(calc(-50% + ' + (view.x * base.width) + 'px), calc(-50% + ' + (view.y * base.height) + 'px)) scale(' + view.scale + ')' }}
          onReady={size => ready(side, entry.source, entry.token, size)} onFailure={() => failed(side, entry.token)} />;
      })}
      {waiting && <div className={styles.imageStatus} role="status">正在加载所选图片，原图保留</div>}
    </div>;
  }
  const activeOriginal = originals[viewIdentity(safeSide, selectedImage)] || false;
  const copySource = displaySource(selectedImage.src, activeOriginal ? 'original' : 'preview');
  const visibleMetadata = isOriginalSubject ? { model: safeMetadataValue(safeDetails?.model ?? metadata?.model), quality: safeMetadataValue(safeDetails?.quality ?? metadata?.quality),
    ratio: safeMetadataValue(safeDetails?.ratio ?? metadata?.ratio), resolution: safeMetadataValue(safeDetails?.resolution ?? metadata?.resolution), time: safeMetadataTime(safeDetails?.time ?? metadata?.time) } : {};
  const visibleSize = isOriginalSubject && safeDetails?.width && safeDetails.height ? { width: safeDetails.width, height: safeDetails.height } : sizes[selectedId];
  const rawTime = safeDetails?.time ?? metadata?.time;
  const hasMetadata = Object.values(visibleMetadata).some(Boolean) || Boolean(visibleSize);
  const candidates = Array.from(new Map([incoming, ...(comparison ? [comparison] : []), ...comparisonCandidates].filter(image => image.src).map(image => [identity(image), image])).values());
  function thumbnail(side: Side) {
    const image = sources[side];
    return <button type="button" className={styles.sourceThumb} data-active={safeSide === side} title={side === 'current' ? '更换当前图' : '选择或更换对比图'} aria-label={side === 'current' ? '更换当前图' : '选择或更换对比图'} onClick={() => { userAction.current++; stopGestures(); setPickerSide(side); }}>
      {image ? <img src={image.thumbnailSrc || displaySource(image.src, 'thumbnail')} alt="" draggable={false} /> : <Plus size={20} />}
      <span>{side === 'current' ? '当前图' : '对比图'}</span>
    </button>;
  }
  return <><span ref={portalAnchorRef} hidden />{portalRoot && createPortal(<div ref={backdropRef} className={styles.backdrop} data-media-preview="sd2-media-preview" role="dialog" aria-modal="true" aria-label={imageTitle} tabIndex={-1}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <div ref={toolbarRef} className={styles.toolbar} data-has-comparison="true" data-has-metadata={hasMetadata || undefined}>
      <div className={styles.comparisonActions}>
        <div className={styles.sourceGroup}>{thumbnail('current')}<button type="button" data-image-preview-compare aria-pressed={comparisonMode} title={comparisonMode ? '退出对比' : '开启对比'} aria-label={comparisonMode ? '退出对比' : '开启对比'}
          onClick={() => { userAction.current++; stopGestures(); if (comparisonMode) { setComparisonMode(false); setActiveSide('current'); }
            else if (comparisonImage) setComparisonMode(true); else setPickerSide('comparison'); }}><ArrowLeftRight size={16} /><span className={styles.actionLabel}>对比</span></button>{thumbnail('comparison')}</div>
        {comparisonMode && <div className={styles.compareOptions}>
          <label className={styles.linkedMode}><input type="checkbox" checked={linked} onChange={event => { userAction.current++; stopGestures(); setLinked(event.target.checked); }} />联动</label>
          <button type="button" title={axis === 'horizontal' ? '切换上下对比' : '切换左右对比'} aria-label={axis === 'horizontal' ? '切换上下对比' : '切换左右对比'} onClick={() => { userAction.current++; stopGestures(); setAxis(value => value === 'horizontal' ? 'vertical' : 'horizontal'); }}>{axis === 'horizontal' ? <ArrowUpDown size={16} /> : <ArrowLeftRight size={16} />}</button>
          <select aria-label="对比更多操作" value="" onChange={event => { if (event.target.value === 'swap') swap(); else if (event.target.value === 'reset') reset(true); }}><option value="">更多</option><option value="swap">交换两图</option><option value="reset">还原两图</option></select>
        </div>}
      </div>
      <div className={styles.leading}>{selectedImage.contentKey && <ContentReactions contentKey={selectedImage.contentKey} imageSharing={imageSharing} />}
        <div className={styles.title}><strong>{safeSide === 'current' ? '当前图' : '对比图'}</strong><span>{Math.round(selectedView.scale * 100)}%{comparisonMode && linked ? ' · 联动' : ''}</span></div>
      </div>
      <div className={styles.actions}>
        <button type="button" disabled={copyState?.busy} title={safeSide === 'current' ? '复制当前图' : '复制对比图'} aria-label={safeSide === 'current' ? '复制当前图' : '复制对比图'} onClick={() => {
          setCopyState({ src: copySource, busy: true }); void copyImage(copySource).then(() => { if (alive.current) setCopyState({ src: copySource, success: true, message: '图片已复制' }); }).catch(() => { if (alive.current) setCopyState({ src: copySource, message: '浏览器未允许复制，请使用图片右键菜单' }); });
        }}>{copyState?.success && copyState.src === copySource ? <Check size={16} /> : <Copy size={16} />}</button>
        {displaySource(selectedImage.src, 'preview') !== displaySource(selectedImage.src, 'original') && <button type="button" aria-pressed={activeOriginal} title={activeOriginal ? '切换高清预览' : '加载选中图完整原图'} onClick={() => { userAction.current++; stopGestures(); setOriginals(value => ({ ...value, [viewIdentity(safeSide, selectedImage)]: !activeOriginal })); }}><span className={styles.actionLabel}>{activeOriginal ? '原图' : '高清预览'}</span></button>}
        {hasNavigation && <><button type="button" title="当前图上一张" aria-label="当前图上一张" onClick={onPrevious}><ArrowLeft size={16} /></button><button type="button" title="当前图下一张" aria-label="当前图下一张" onClick={onNext}><ArrowRight size={16} /></button></>}
        <label className={styles.zoomMode}><span className={styles.srOnly}>选中图显示比例</span><select aria-label="选中图显示比例" value={selectedView.mode} onChange={event => applyMode(event.target.value as MediaPreviewZoomMode)}><option value="fit">适合窗口</option><option value="width">适合宽度</option><option value="actual">实际像素</option><option value="custom" disabled>手动缩放</option></select></label>
        <button type="button" onClick={() => zoomFromControls(1 / SCALE_STEP)} title="缩小选中图" aria-label="缩小选中图"><ZoomOut size={16} /></button>
        <button type="button" onClick={() => zoomFromControls(SCALE_STEP)} title="放大选中图" aria-label="放大选中图"><ZoomIn size={16} /></button>
        <button type="button" onClick={() => reset()} title={safeSide === 'current' ? '还原当前图' : '还原对比图'} aria-label={safeSide === 'current' ? '还原当前图' : '还原对比图'}><RotateCcw size={16} /></button>
      </div>
      <button type="button" className={styles.closeButton} onClick={dismissPreview} title="关闭大图" aria-label="关闭大图"><X size={16} /></button>
      {hasMetadata && <div className={styles.metadata}><div className={styles.metadataValues}>{visibleMetadata.model && <span>{visibleMetadata.model}</span>}{visibleMetadata.quality && <span>{visibleMetadata.quality}</span>}{visibleMetadata.ratio && <span>{visibleMetadata.ratio}</span>}
        {visibleSize && <span className={styles.dimensionHint}><span tabIndex={0} aria-describedby={dimensionsTooltipId}>尺寸</span><span id={dimensionsTooltipId} className={styles.dimensionTooltip} role="tooltip">{visibleSize.width} × {visibleSize.height} 像素</span></span>}</div>
        {visibleMetadata.time && <span className={styles.metadataTime}>{rawTime && Number.isFinite(Date.parse(rawTime)) ? <RelativeTime value={rawTime} /> : visibleMetadata.time}</span>}
      </div>}
      {(message || copyState?.src === copySource && copyState.message) && <div className={styles.notice} role="status">{message || copyState?.message}</div>}
      {isOriginalSubject && notice != null && <div className={styles.notice}>{notice}</div>}
      {isOriginalSubject && details != null && <details className={styles.detailDisclosure}><summary>详情</summary><div className={styles.detailContent}>{details}</div></details>}
    </div>
    <div ref={stageRef} className={styles.stage} data-image-preview-stage onAuxClick={event => event.preventDefault()}>
      <div className={styles.compareFrame + ' ' + (comparisonMode ? axis === 'vertical' ? styles.compareVertical : styles.compareHorizontal : styles.singleFrame)} data-image-preview-compare-frame>
        {pane('current')}{comparisonMode && pane('comparison')}
      </div>
    </div>
  </div>, portalRoot)}
  {portalRoot && pickerSide && <ImageComparisonPicker side={pickerSide} container={portalRoot} candidates={candidates}
    onSelect={image => choose(pickerSide, image)} onLocal={file => chooseLocal(pickerSide, file)}
    onClose={() => { cancelRequests(); setPickerSide(null); }} />}
  </>;
}
