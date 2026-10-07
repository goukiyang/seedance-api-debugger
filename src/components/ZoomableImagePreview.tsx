'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, Check, Copy, Download, Lock, Unlock, MoreHorizontal, Plus, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { copyImage } from '@/lib/media/copy-image';
import styles from './ZoomableImagePreview.module.css';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import type { ContentKey } from '@/lib/content-reactions/types';
import { isSafeIdentifier, useMediaPreviewState, type MediaPreviewZoomMode } from '@/lib/hooks/use-media-preview-state';
import { useImageReadProgress } from '@/lib/hooks/use-image-read-progress';
import { useHdImageSource, versionedHdSource, type HdDescription } from '@/lib/hooks/use-hd-image-source';
import { isTopmostDialogLayer, useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useImagePreviewHistoryDismiss } from './useImagePreviewHistoryDismiss';
import { ImageComparisonPicker } from './ImageComparisonPicker';
import {
  fittedImageView, imageSourceIdentity, imageDisplaySource as displaySource, sourcePickerKey, resolveComparisonImage,
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

export type SafeImagePreviewDetails = Omit<ImagePreviewMetadata, 'context'> & { width?: number; height?: number; fileSize?: number };

type ZoomableImagePreviewProps = {
  src: string;
  thumbnailSrc?: string;
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
type DecodedImage = { source: string; fullSize: boolean; hd?: HdDescription; mime?: string; bytes?: number; account: string };

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

function PreviewImage({ src, thumbnailSrc, alt, original, version = '', className, style, onReady, onThumbnailReady, onUnavailable }: { src: string; thumbnailSrc?: string; alt: string; original: boolean; version?: string; className: string; style: CSSProperties; onReady?: (size: IntrinsicSize, decoded: DecodedImage) => void; onThumbnailReady?: (size: IntrinsicSize) => void; onUnavailable?: () => void }) {
  const { user } = useAppSession();
  const image = useRef<HTMLImageElement>(null);
  const thumbnailImage = useRef<HTMLImageElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onThumbnailReadyRef = useRef(onThumbnailReady);
  onThumbnailReadyRef.current = onThumbnailReady;
  const onUnavailableRef = useRef(onUnavailable); onUnavailableRef.current = onUnavailable;
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [failedKey, setFailedKey] = useState('');
  const hd = useHdImageSource(src, original, attempt, version);
  const [fallbackKey, setFallbackKey] = useState('');
  const fallbackIdentity = `${user?.id || 'anonymous'}:${src}:${hd.version}:${attempt}`;
  const rawFallback = fallbackKey === fallbackIdentity;
  const displaySrc = rawFallback ? displaySource(src, 'original') : hd.readSource;
  const thumbnail = thumbnailSrc || displaySource(src, 'thumbnail');
  const hasThumbnail = thumbnail !== displaySource(src, 'preview');
  const accountIdentity = `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}`;
  const key = `${accountIdentity}:${hd.version}:${displaySrc}:${attempt}`;
  const [thumbnailLoaded, setThumbnailLoaded] = useState('');
  const [upgradeKey, setUpgradeKey] = useState('');
  const [shown, setShown] = useState<{ identity: string; source: string } | null>(null);
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;
  // Prepare the clear image in parallel; these frames gate presentation, not its request.
  useEffect(() => {
    let next = 0;
    const frame = requestAnimationFrame(() => { next = requestAnimationFrame(() => setUpgradeKey(key)); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(next); };
  }, [key]);
  useEffect(() => {
    if (!hasThumbnail) return;
    if (thumbnailImage.current?.complete) {
      if (thumbnailImage.current.naturalWidth > 0) {
        setThumbnailLoaded(thumbnail);
        onThumbnailReadyRef.current?.({ width: thumbnailImage.current.naturalWidth, height: thumbnailImage.current.naturalHeight });
      }
    }
  }, [hasThumbnail, thumbnail, onThumbnailReady]);
  const readResult = useImageReadProgress(displaySrc, attempt, Boolean(displaySrc), hd.version);
  const readProgress = readResult.progress;
  const imageSrc = readResult.imageSrc || undefined;
  const loaded = loadedKey === key && upgradeKey === key && Boolean(imageSrc);
  const unsupported = readProgress.phase === 'unsupported';
  const failed = failedKey === key || unsupported || readProgress.phase === 'unavailable';
  useEffect(() => { if (!imageSrc || readResult.denied || hd.denied) onUnavailableRef.current?.(); }, [imageSrc, readResult.denied, hd.denied, key]);
  useEffect(() => {
    if (failed && !readResult.denied && hd.description?.status === 'ready' && !hd.description.original && !rawFallback && !original) setFallbackKey(fallbackIdentity);
  }, [failed, readResult.denied, hd.description?.status, hd.description?.original, rawFallback, original, fallbackIdentity]);
  const reportReady = (target: HTMLImageElement) => {
    setShown({ identity: `${accountIdentity}:${src}`, source: target.src });
    onReadyRef.current?.({ width: target.naturalWidth, height: target.naturalHeight },
      { source: target.src, fullSize: hd.fullSize || rawFallback, hd: hd.description, mime: readResult.mime, bytes: readResult.bytes, account: accountIdentity });
  };
  useEffect(() => {
    if (loaded || unsupported || upgradeKey !== key || !displaySrc) return;
    if (image.current?.complete && image.current.naturalWidth > 0) {
      const target = image.current;
      void target.decode().then(() => { if (currentKeyRef.current === key) { setLoadedKey(key); reportReady(target); } }).catch(() => { if (currentKeyRef.current === key) setFailedKey(key); });
    }
    if (readProgress.phase === 'reading') return;
    const timer = window.setTimeout(() => setFailedKey(key), 30000);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded, readProgress.phase, unsupported, upgradeKey, displaySrc]);
  const progressLabel = readProgress.phase === 'unsupported'
    ? readProgress.message || '该来源不是图片，未读取文件内容'
    : readProgress.phase === 'unavailable'
      ? readProgress.message || '当前来源无法提供读取进度'
      : readProgress.phase === 'decoding' ? '正在解码' : '正在读取';
  return <>
    {!loaded && !readResult.denied && !hd.denied && shown?.identity === `${accountIdentity}:${src}` && shown.source !== imageSrc && <img src={shown.source} alt={alt} className={className} style={style} draggable={false} onError={() => setShown(null)} />}
    {hasThumbnail && !loaded && !readResult.denied && (!shown || shown.identity !== `${accountIdentity}:${src}` || hd.denied) && <img ref={thumbnailImage} key={`thumbnail:${accountIdentity}:${thumbnail}`} src={thumbnail} alt={alt} className={className} style={style} draggable={false} data-image-preview-thumbnail
      onLoad={event => { setThumbnailLoaded(thumbnail); onThumbnailReadyRef.current?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }} />}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {imageSrc && <img ref={image} key={`preview:${key}`} src={imageSrc} alt={alt} className={className} style={{ ...style, opacity: loaded ? 1 : 0 }} draggable={false} data-image-preview-image
      onLoad={event => { const target = event.currentTarget; void target.decode().then(() => { if (currentKeyRef.current !== key) return; setLoadedKey(key); setFailedKey(''); reportReady(target); }).catch(() => { if (currentKeyRef.current === key) setFailedKey(key); }); }} onError={() => { if (currentKeyRef.current === key) setFailedKey(key); }} />}
    {loaded && hd.pending && <div className={styles.imageStatus} role="status">当前为完整原图，高清图正在准备</div>}
    {!loaded && <div className={styles.imageStatus} role="status">
      <span>{hd.pending ? '高清图正在准备，缩略图仍可查看' : failed ? (unsupported ? progressLabel : thumbnailLoaded === thumbnail ? '高清未能加载，缩略图仍可查看，请重试' : '图片未能加载，请重试') : upgradeKey !== key ? `${alt} · ${hasThumbnail ? '正在显示缩略图' : '正在准备图片'}` : `${alt} · ${original || rawFallback || hd.description?.status === 'skipped' || hd.description?.status === 'failed' ? '完整原图' : hd.description?.status === 'ready' ? '原尺寸高清' : '轻量预览'} · ${progressLabel}`}</span>
      {hd.error && <span>{hd.denied ? '当前仅可预览，无权读取高清原件' : '高清状态读取失败，可重试或查看原图'}</span>}
      {failed && !unsupported && readProgress.phase === 'unavailable' && <span>{readProgress.message || '当前来源无法提供读取进度'}</span>}
      {!failed && readProgress.phase === 'reading' && readProgress.percent != null && <>
        <progress className={styles.imageProgress} max={100} value={readProgress.percent} aria-label={`${alt}读取进度 ${readProgress.percent}%`} />
        {readProgress.totalBytes != null && <span>{readProgress.percent}% · {formatImageBytes(readProgress.loadedBytes)} / {formatImageBytes(readProgress.totalBytes)}</span>}
      </>}
      {!failed && readProgress.phase === 'reading' && readProgress.percent == null && <span>已读取 {formatImageBytes(readProgress.loadedBytes)}</span>}
      {!failed && readProgress.phase === 'decoding' && <span>已读取 {formatImageBytes(readProgress.loadedBytes)}</span>}
      {(failed || hd.error) && !unsupported && <button type="button" title="重新加载" aria-label="重新加载图片" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}><RotateCcw size={16} /></button>}
    </div>}
  </>;
}


type Side = 'current' | 'comparison';
type Point = { x: number; y: number };
type Frames = Record<Side, IntrinsicSize>;
type ImageRequest = { token: number; controller: AbortController; resolve: (applied: boolean) => void; reject: (error: Error) => void };
const sides: Side[] = ['current', 'comparison'];
const viewIdentity = (side: Side, image: ImageComparisonSource) => imageSourceIdentity(image) + ':' + side;

export function ZoomableImagePreview({ src, thumbnailSrc, alt, fileName, title, previewKey, sourceVersion, contentKey, imageSharing = true, metadata, safeDetails, comparison, comparisonCandidates = [], details, notice, hasNavigation, onPrevious, onNext, onImageLoaded, onClose }: ZoomableImagePreviewProps) {
  const { user, hasLoadedUser } = useAppSession();
  const owner = user?.id || '';
  const backdropRef = useRef<HTMLDivElement>(null), toolbarRef = useRef<HTMLDivElement>(null), stageRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<Partial<Record<Side, HTMLDivElement>>>({});
  const portalAnchorRef = useRef<HTMLSpanElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const incoming: ImageComparisonSource = { src, thumbnailSrc, alt, fileName, id: previewKey, version: sourceVersion, contentKey, width: safeDetails?.width, height: safeDetails?.height, fileSize: safeDetails?.fileSize };
  const [currentImage, setCurrentImage] = useState<ImageComparisonSource>(incoming);
  const [comparisonImage, setComparisonImage] = useState<ImageComparisonSource | null>(comparison || null);
  const sources = { current: currentImage, comparison: comparisonImage };
  const sourcesRef = useRef(sources); sourcesRef.current = sources;
  const [comparisonMode, setComparisonMode] = useState(false), [linked, setLinked] = useState(false);
  const [axis, setAxis] = useState<'horizontal' | 'vertical'>('horizontal'), [activeSide, setActiveSide] = useState<Side>('current');
  const [pickerSide, setPickerSide] = useState<Side | null>(null);
  const requests = useRef<Partial<Record<Side, ImageRequest>>>({}), sequence = useRef(0);
  const [views, setViews] = useState<Record<string, ImageView>>({});
  const viewsRef = useRef(views); viewsRef.current = views;
  const [sizes, setSizes] = useState<Record<string, IntrinsicSize>>({});
  const [originalSizes, setOriginalSizes] = useState<Record<string, IntrinsicSize>>({});
  const [thumbnailFrames, setThumbnailFrames] = useState<Record<string, IntrinsicSize>>({});
  const [originals, setOriginals] = useState<Record<string, boolean>>({});
  const [decodedImages, setDecodedImages] = useState<Record<string, DecodedImage>>({});
  const [frames, setFrames] = useState<Frames>({ current: { width: 1, height: 1 }, comparison: { width: 1, height: 1 } });
  const [message, setMessage] = useState(''), [copyState, setCopyState] = useState<{ src: string; busy?: boolean; success?: boolean; message?: string } | null>(null);
  const points = useRef<Record<Side, Map<number, Point>>>({ current: new Map(), comparison: new Map() });
  const zoomPoints = useRef<Partial<Record<Side, Point>>>({});
  const localUrls = useRef(new Set<string>());
  const alive = useRef(true), userAction = useRef(0);
  const [initializedOwner, setInitializedOwner] = useState<string | null>(null);
  const controlsId = useId();
  const [controlsOpen, setControlsOpen] = useState<'zoom' | 'more' | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null), zoomTriggerRef = useRef<HTMLButtonElement>(null), moreTriggerRef = useRef<HTMLButtonElement>(null);
  const dismissPreview = useImagePreviewHistoryDismiss(Boolean(portalRoot), controlsOpen ? controlsRef : backdropRef, onClose);
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
      for (const id of Array.from(points.current[side].keys())) { if (pane?.hasPointerCapture(id)) pane.releasePointerCapture(id); }
      points.current[side].clear();
    }
  }, []);
  const cancelRequests = useCallback(() => {
    for (const request of Object.values(requests.current)) { request?.controller.abort(); request?.resolve(false); }
    requests.current = {};
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stopGestures(); for (const request of Object.values(requests.current)) { request?.controller.abort(); request?.resolve(false); }
      for (const url of Array.from(localUrls.current)) URL.revokeObjectURL(url); localUrls.current.clear(); };
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
        if (side === 'current' && existing?.src === next.src && existing.version === next.version && imageSourceIdentity(existing) === imageSourceIdentity(next)) {
          delete requests.current[side]; resolve(true); return;
        }
        setMessage('');
        delete requests.current[side];
        if (side === 'current') setCurrentImage(next);
        else { setComparisonImage(next); setComparisonMode(true); }
        setActiveSide(side); resolve(true);
      })().catch(error => {
        if (requests.current[side] !== request || !alive.current) { resolve(false); return; }
        delete requests.current[side];
        const failure = error instanceof Error ? error : new Error('图片无法加载，原图保留');
        setMessage(failure.message); reject(failure);
      });
    });
  }, [stopGestures]);

  const originalOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!hasLoadedUser || !portalRoot) return;
    if (originalOwner.current !== null && originalOwner.current !== owner) { cancelRequests(); onClose(); return; }
    originalOwner.current = owner;
    const preferences = owner ? readComparisonPreferences(owner) : {};
    setLinked(preferences.linked ?? false);
    setAxis(preferences.axis || (window.matchMedia('(max-width: 640px)').matches ? 'vertical' : 'horizontal'));
    setInitializedOwner(owner);
    if (!owner || !selectionAnchor) return;
    const saved = readComparisonSelection(owner, selectionAnchor, imageSourceIdentity(incoming)), action = userAction.current;
    const controller = new AbortController();
    void (async () => {
      const restored = saved.comparison ? await resolveComparisonImage(saved.comparison.key, controller.signal) : null;
      if (!alive.current || controller.signal.aborted || userAction.current !== action) return;
      if (restored && imageSourceIdentity(restored) === saved.comparison?.identity) {
        await requestImage('comparison', restored, false);
        if (!alive.current || controller.signal.aborted || userAction.current !== action) return;
        setComparisonMode(saved.enabled);
      } else if (saved.comparison) setMessage('上次对比图已失效，请重新选择');
      // Explicitly opened images always anchor the left side; restore only the comparison selection.
    })().catch(() => { if (alive.current && !controller.signal.aborted && userAction.current === action) setMessage('上次图片无法恢复，原图保留，请重新选择'); });
    return () => controller.abort();
  // Restore once per account/opening; explicit navigation must not replay an old selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, hasLoadedUser, portalRoot]);

  const incomingIdentity = JSON.stringify([src, previewKey, sourceVersion, contentKey, thumbnailSrc]);
  const lastIncoming = useRef(incomingIdentity);
  useLayoutEffect(() => {
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
  useDialogDismiss({ open: Boolean(controlsOpen && portalRoot), dialogRef: controlsRef, modal: false,
    branchRefs: [zoomTriggerRef, moreTriggerRef], onDismiss: () => setControlsOpen(null) });
  useEffect(() => {
    if (!controlsOpen) return;
    stopGestures();
    const frame = window.requestAnimationFrame(() => controlsRef.current?.querySelector<HTMLElement>('button:not(:disabled),select,input')?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [controlsOpen, stopGestures]);
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
    const frame = frames[side], size = image && (thumbnailFrames[imageSourceIdentity(image)] || sizes[imageSourceIdentity(image)] || (image.width && image.height ? { width: image.width, height: image.height } : undefined));
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
    const targets = linked && comparisonMode ? sides : [safeSide];
    const actualSize = (image: ImageComparisonSource) => originalSizes[imageSourceIdentity(image)] || (image.width && image.height ? { width: image.width, height: image.height } : undefined);
    if (mode === 'actual' && targets.some(side => { const image = sourcesRef.current[side]; return image && !actualSize(image); })) {
      setMessage('原图像素尺寸未知，请先加载完整原图'); return;
    }
    setViews(value => {
      const next = { ...value };
      for (const side of targets) {
        const image = sourcesRef.current[side]; if (!image) continue;
        const id = viewIdentity(side, image), base = baseSize(side), size = actualSize(image);
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
  function ready(side: Side, image: ImageComparisonSource, size: IntrinsicSize, decoded: DecodedImage) {
    if (!alive.current) return;
    if (sourcesRef.current[side] !== image) return;
    const id = imageSourceIdentity(image);
    setSizes(value => value[id]?.width === size.width && value[id]?.height === size.height ? value : { ...value, [id]: size });
    setDecodedImages(value => ({ ...value, [viewIdentity(side, image)]: decoded }));
    if (decoded.fullSize) setOriginalSizes(value => value[id]?.width === size.width && value[id]?.height === size.height ? value : { ...value, [id]: size });
    onImageLoaded?.(image.src);
  }
  function thumbnailReady(side: Side, image: ImageComparisonSource, size: IntrinsicSize) {
    if (!alive.current || sourcesRef.current[side] !== image || image.width && image.height || size.width <= 0 || size.height <= 0) return;
    const id = imageSourceIdentity(image), frame = frames[side];
    if (frame.width <= 24 || frame.height <= 24) return;
    // Only the display frame is inferred; actual-pixel controls still use the decoded full image.
    const fit = Math.min(Math.max(1, frame.width - 24) / size.width, Math.max(1, frame.height - 24) / size.height);
    setThumbnailFrames(value => value[id] ? value : { ...value, [id]: { width: size.width * fit, height: size.height * fit } });
  }
  function choose(side: Side, image: ImageComparisonSource) { userAction.current++; return requestImage(side, image); }
  async function chooseLocal(side: Side, file: File) {
    if (!file.type.startsWith('image/') || file.size > 64 * 1024 * 1024) throw new Error('请选择64MB以内的图片');
    const url = URL.createObjectURL(file); localUrls.current.add(url);
    try { const applied = await choose(side, { src: url, alt: '本机图片', fileName: file.name, fileSize: file.size });
      if (!applied) { URL.revokeObjectURL(url); localUrls.current.delete(url); }
      else setMessage('本机图片仅本次预览，不上传、不跨重开保存');
      return applied;
    } catch (error) { URL.revokeObjectURL(url); localUrls.current.delete(url); throw error; }
  }
  function pane(side: Side) {
    const image = sources[side];
    return <div key={side} ref={element => { if (element) paneRefs.current[side] = element; else delete paneRefs.current[side]; }}
      className={styles.comparePane} data-image-preview-pane={side} data-active={safeSide === side} role="group" aria-label={side === 'current' ? '当前图' : '对比图'} tabIndex={0}
      onFocus={() => setActiveSide(side)} onPointerDown={event => pointerDown(side, event)} onPointerMove={event => pointerMove(side, event)}
      onPointerUp={event => pointerEnd(side, event)} onPointerCancel={event => pointerEnd(side, event)} onLostPointerCapture={event => pointerEnd(side, event)}
      onDoubleClick={() => { setActiveSide(side); userAction.current++; setViews(value => ({ ...value, ...(image ? { [viewIdentity(side, image)]: { ...fittedImageView } } : {}) })); }}>
      {comparisonMode && <span className={styles.compareLabel}>{side === 'current' ? '当前图' : '对比图'}</span>}
      {image && (() => {
        const id = identity(image), view = views[viewIdentity(side, image)] || fittedImageView, base = baseSize(side, image);
        const dimensionsKnown = Boolean(thumbnailFrames[id] || sizes[id] || image.width && image.height);
        return <PreviewImage key={`${id}:${image.src}:${image.version || ''}`} src={image.src} thumbnailSrc={image.thumbnailSrc} version={image.version} alt={side === 'current' ? '当前图' : '对比图'} original={originals[viewIdentity(side, image)] || false}
          className={styles.compareImage}
          style={{ width: dimensionsKnown ? base.width : undefined, height: dimensionsKnown ? base.height : undefined,
            transform: 'translate(calc(-50% + ' + (view.x * base.width) + 'px), calc(-50% + ' + (view.y * base.height) + 'px)) scale(' + view.scale + ')' }}
          onThumbnailReady={size => thumbnailReady(side, image, size)} onReady={(size, decoded) => ready(side, image, size, decoded)}
          onUnavailable={() => setDecodedImages(current => { const key = viewIdentity(side, image); if (!current[key]) return current; const next = { ...current }; delete next[key]; return next; })} />;
      })()}
    </div>;
  }
  const activeOriginal = originals[viewIdentity(safeSide, selectedImage)] || false;
  const candidateDecoded = decodedImages[viewIdentity(safeSide, selectedImage)];
  const decoded = candidateDecoded?.account === `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` ? candidateDecoded : undefined;
  const copySource = decoded?.fullSize ? decoded.source : '';
  const visibleMetadata = isOriginalSubject ? { model: safeMetadataValue(safeDetails?.model ?? metadata?.model), quality: safeMetadataValue(safeDetails?.quality ?? metadata?.quality),
    ratio: safeMetadataValue(safeDetails?.ratio ?? metadata?.ratio), resolution: safeMetadataValue(safeDetails?.resolution ?? metadata?.resolution), time: safeMetadataTime(safeDetails?.time ?? metadata?.time) } : {};
  const visibleSize = originalSizes[selectedId] || (selectedImage.width && selectedImage.height ? { width: selectedImage.width, height: selectedImage.height } : undefined);
  const previewSize = sizes[selectedId];
  const fileSize = selectedImage.fileSize;
  const knownFileSize = typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > 0;
  const rawTime = safeDetails?.time ?? metadata?.time;
  const candidates = Array.from(new Map([incoming, ...(comparison ? [comparison] : []), ...comparisonCandidates].filter(image => image.src).map(image => [identity(image), image])).values());
  function thumbnail(side: Side) {
    const image = sources[side];
    return <button type="button" className={styles.sourceThumb} data-active={safeSide === side} title={side === 'current' ? '更换当前图' : '选择或更换对比图'} aria-label={`${side === 'current' ? '更换当前图' : '选择或更换对比图'}${safeSide === side ? '，当前选中' : ''}`} onClick={() => { userAction.current++; stopGestures(); setControlsOpen(null); setPickerSide(side); }}>
      {image ? <img src={image.thumbnailSrc || displaySource(image.src, 'thumbnail')} alt="" draggable={false} /> : <Plus size={20} />}
      <span className={styles.srOnly}>{side === 'current' ? '当前图' : '对比图'}</span>
    </button>;
  }
  return <><span ref={portalAnchorRef} hidden />{portalRoot && createPortal(<div ref={backdropRef} className={styles.backdrop} data-media-preview="sd2-media-preview" role="dialog" aria-modal="true" aria-label={imageTitle} tabIndex={-1}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <div ref={toolbarRef} className={styles.toolbar}>
      <div className={styles.sourceGroup}>
        {hasNavigation && <div className={styles.desktopNavigation}><button type="button" title="当前图上一张" aria-label="当前图上一张" onClick={onPrevious}><ArrowLeft size={16} /></button><button type="button" title="当前图下一张" aria-label="当前图下一张" onClick={onNext}><ArrowRight size={16} /></button></div>}
        {comparisonMode && <button type="button" title={linked ? '关闭两图联动，独立调整' : '开启两图联动'} aria-label={linked ? '关闭两图联动，独立调整' : '开启两图联动'} aria-pressed={linked} onClick={() => { userAction.current++; stopGestures(); setLinked(value => !value); }}>{linked ? <Lock size={16} /> : <Unlock size={16} />}</button>}
        <button ref={zoomTriggerRef} type="button" className={styles.zoomTrigger} title="缩放选中图" aria-label={`${safeSide === 'current' ? '当前图' : '对比图'}缩放 ${Math.round(selectedView.scale * 100)}%${comparisonMode && linked ? '，联动已开启' : ''}`} aria-expanded={controlsOpen === 'zoom'} aria-controls={controlsOpen === 'zoom' ? controlsId : undefined} aria-haspopup="dialog" onClick={() => setControlsOpen(value => value === 'zoom' ? null : 'zoom')}><ZoomIn size={16} /><span>{Math.round(selectedView.scale * 100)}%</span></button>
      </div>
      <div className={styles.compareSources} role="group" aria-label="当前图与对比图">{thumbnail('current')}<button type="button" className={styles.compareToggle} data-image-preview-compare aria-pressed={comparisonMode} title={comparisonMode ? '退出对比' : '开启对比'} aria-label={comparisonMode ? '退出对比' : '开启对比'}
          onClick={() => { userAction.current++; stopGestures(); if (comparisonMode) { setComparisonMode(false); setActiveSide('current'); }
            else if (comparisonImage) setComparisonMode(true); else { setControlsOpen(null); setPickerSide('comparison'); } }}><ArrowLeftRight size={16} /></button>{thumbnail('comparison')}</div>
      <div className={styles.actions}>
        <button ref={moreTriggerRef} type="button" title="图片与对比更多操作" aria-label="图片与对比更多操作" aria-expanded={controlsOpen === 'more'} aria-controls={controlsOpen === 'more' ? controlsId : undefined} aria-haspopup="dialog" onClick={() => setControlsOpen(value => value === 'more' ? null : 'more')}><MoreHorizontal size={18} /></button>
        <button type="button" className={styles.closeButton} onClick={dismissPreview} title="关闭大图" aria-label="关闭大图"><X size={18} /></button>
      </div>
      {controlsOpen && <div ref={controlsRef} id={controlsId} className={styles.controlsPopover} role="dialog" aria-label={controlsOpen === 'zoom' ? '缩放选中图' : '图片与对比更多操作'}>
        <header><strong>{safeSide === 'current' ? '当前图' : '对比图'}{controlsOpen === 'zoom' ? '缩放' : '操作'}</strong><button type="button" title="收起操作" aria-label="收起操作" onClick={() => setControlsOpen(null)}><X size={16} /></button></header>
        {controlsOpen === 'zoom' ? <>
          <label className={styles.zoomMode}><span>显示比例</span><select aria-label="选中图显示比例" value={selectedView.mode} onChange={event => applyMode(event.target.value as MediaPreviewZoomMode)}><option value="fit">适合窗口</option><option value="width">适合宽度</option><option value="actual">实际像素</option><option value="custom" disabled>手动缩放</option></select></label>
          <div className={styles.popoverRow}><button type="button" onClick={() => zoomFromControls(1 / SCALE_STEP)} title="缩小选中图" aria-label="缩小选中图"><ZoomOut size={16} /></button><span>{Math.round(selectedView.scale * 100)}%</span><button type="button" onClick={() => zoomFromControls(SCALE_STEP)} title="放大选中图" aria-label="放大选中图"><ZoomIn size={16} /></button><button type="button" onClick={() => reset()} title="还原选中图" aria-label="还原选中图"><RotateCcw size={16} /></button></div>
        </> : <>
          {selectedImage.contentKey && <ContentReactions key={`reactions:${owner}:${selectedImage.contentKey}`} contentKey={selectedImage.contentKey} imageSharing={imageSharing} />}
          <button type="button" className={styles.menuAction} disabled={copyState?.busy || !copySource} onClick={() => {
            setCopyState({ src: copySource, busy: true }); void copyImage(copySource).then(() => { if (alive.current) setCopyState({ src: copySource, success: true, message: '原尺寸图片已复制' }); }).catch(error => { if (alive.current) setCopyState({ src: copySource, message: error instanceof Error ? error.message : '复制失败，请重试' }); });
          }}>{copyState?.success && copyState.src === copySource ? <Check size={16} /> : <Copy size={16} />}{copyState?.busy ? '正在复制' : safeSide === 'current' ? '复制当前图' : '复制对比图'}</button>
          {displaySource(selectedImage.src, 'preview') !== displaySource(selectedImage.src, 'original') && <button type="button" className={styles.menuAction} aria-pressed={activeOriginal} onClick={() => { userAction.current++; stopGestures(); setOriginals(value => ({ ...value, [viewIdentity(safeSide, selectedImage)]: !activeOriginal })); }}><ZoomIn size={16} />{activeOriginal ? '切换高清预览' : '加载完整原图'}</button>}
          {displaySource(selectedImage.src, 'download') !== selectedImage.src && <>
            {decoded?.hd?.status === 'ready' ? <a className={styles.menuAction} href={versionedHdSource(selectedImage.src, 'hd-download', decoded.hd.sourceVersion)}><Download size={16} />下载高清 {decoded.hd.format?.toUpperCase()}{decoded.hd.bytes ? ` · ${formatImageBytes(decoded.hd.bytes)}` : ''}</a> : <span className={styles.menuAction}>高清档尚未就绪，原图仍可下载</span>}
            <a className={styles.menuAction} href={displaySource(selectedImage.src, 'download')} download={selectedImage.fileName || 'original-image'}><Download size={16} />下载原图{knownFileSize ? ` · ${formatImageBytes(fileSize)}` : ''}</a>
          </>}
          {hasNavigation && <div className={styles.mobileNavigation}><button type="button" className={styles.menuAction} onClick={onPrevious}><ArrowLeft size={16} />当前图上一张</button><button type="button" className={styles.menuAction} onClick={onNext}><ArrowRight size={16} />当前图下一张</button></div>}
          {comparisonMode && <div className={styles.compareOptions}>
            <button type="button" className={styles.menuAction} onClick={() => { userAction.current++; stopGestures(); setAxis(value => value === 'horizontal' ? 'vertical' : 'horizontal'); }}>{axis === 'horizontal' ? <ArrowUpDown size={16} /> : <ArrowLeftRight size={16} />}{axis === 'horizontal' ? '切换上下对比' : '切换左右对比'}</button>
            <button type="button" className={styles.menuAction} onClick={() => reset(true)}><RotateCcw size={16} />还原两图</button>
          </div>}
          <div className={styles.metadata}>{visibleMetadata.model && <span>模型：{visibleMetadata.model}</span>}{visibleMetadata.quality && <span>质量：{visibleMetadata.quality}</span>}{visibleMetadata.ratio && <span>比例：{visibleMetadata.ratio}</span>}{visibleMetadata.resolution && <span>分辨率：{visibleMetadata.resolution}</span>}
            <span>原图尺寸：{visibleSize ? `${visibleSize.width} × ${visibleSize.height} 像素` : '未知'}</span>
            <span>原文件大小：{knownFileSize ? formatImageBytes(fileSize) : '未知'}</span>
            {decoded?.mime && <span>当前显示：{decoded.mime.replace('image/', '').toUpperCase()}{decoded.bytes ? ` · ${formatImageBytes(decoded.bytes)}` : ''}</span>}
            {!visibleSize && previewSize && <span>当前预览：{previewSize.width} × {previewSize.height} 像素（非原图尺寸）</span>}
            {visibleMetadata.time && <span>{rawTime && Number.isFinite(Date.parse(rawTime)) ? <RelativeTime value={rawTime} /> : visibleMetadata.time}</span>}
          </div>
          {isOriginalSubject && details != null && <details className={styles.detailDisclosure}><summary>详情</summary><div className={styles.detailContent}>{details}</div></details>}
        </>}
      </div>}
    </div>
    <div ref={stageRef} className={styles.stage} data-image-preview-stage onAuxClick={event => event.preventDefault()}>
      {(message || copyState?.src === copySource && copyState.message || isOriginalSubject && notice != null) && <div className={styles.notice} role="status">{message || (copyState?.src === copySource ? copyState.message : null)}{isOriginalSubject && notice}</div>}
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
