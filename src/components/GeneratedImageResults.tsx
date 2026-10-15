'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Image as ImageIcon, Download, Eye, ImagePlus, Scissors, Video } from 'lucide-react';
import { ResultImageCover } from './ResultImageCover';
import { ZoomableImagePreview, type ZoomableImagePreviewProps } from './ZoomableImagePreview';
import ContentReactions from './content-reactions/ContentReactions';
import { LoadingSkeleton, LoadingStatus } from './LoadingState';
import { copyImage } from '@/lib/media/copy-image';
import { useResultPages } from './useResultPages';
import styles from './GeneratedImageResults.module.css';
import { ImageBillingBadge } from './ImageBillingBadge';
import type { ImageBillingView } from '@/lib/image-studio/billing-contract';
import { ImageGenerationWaiting, type ImageGenerationWait } from './ImageGenerationWaiting';
import { useImageGenerationWaitDisplay } from './useImageGenerationWaitDisplay';
import type { ImageGenerationWaitDisplay } from '@/lib/image-studio/wait-display';
import { ImageResultNextActions, ImageResultNextActionFeedback } from './ImageResultNextActions';
import { useImageResultNextActions } from './useImageResultNextActions';
import { ResultImageContextMenu, type ResultImageContextMenuItem } from './ResultImageContextMenu';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { prepareImagePreview, type ImagePreviewPreparation, type ImagePreviewPreparationOptions } from '@/lib/media/image-preview-session';
import { TaskNotice } from './TaskNotice';
import type { ContentKey } from '@/lib/content-reactions/types';

export type GeneratedImageResult = {
  id: string;
  label: string;
  status: string;
  pending?: boolean;
  waitingThumbnail?: string;
  generationWait?: ImageGenerationWait;
  media?: Omit<ZoomableImagePreviewProps, 'onClose' | 'hasNavigation' | 'onPrevious' | 'onNext'>;
  transparent?: boolean;
  applied?: boolean;
  onViewed?: () => void;
  download?: () => void | Promise<unknown>;
  downloadDisabled?: boolean;
  downloadTemporarilyBusy?: boolean;
  downloadMessage?: string;
  viewOnly?: boolean;
  error?: string | null;
  billing?: ImageBillingView | null;
};

const noMore = async () => undefined;
type PreviewPreparation = { scope: string; itemId: string; handle: ImagePreviewPreparation };

function previewPreparationOptions(item: GeneratedImageResult, account: string): ImagePreviewPreparationOptions | null {
  return item.media?.src ? { account, source: item.media.src, sourceVersion: item.media.sourceVersion, previewOnly: Boolean(item.viewOnly || item.media.previewOnly) } : null;
}

function preparationMatches(handle: ImagePreviewPreparation, options: ImagePreviewPreparationOptions) {
  return handle.account === options.account && handle.source === options.source
    && (handle.sourceVersion || '') === (options.sourceVersion || '') && Boolean(handle.previewOnly) === Boolean(options.previewOnly);
}

type ResultRenderers<T> = {
  renderMetadata?: (item: T) => ReactNode; renderActions?: (item: T) => ReactNode;
  renderPrimaryActions?: (item: T, waitDisplay?: ImageGenerationWaitDisplay) => ReactNode; renderDelete?: (item: T) => ReactNode;
  renderOverlay?: (item: T, controls: { openPreview: () => void }) => ReactNode; renderSupplement?: (item: T) => ReactNode;
  renderReactionAction?: (item: T) => ReactNode;
  contextActionsEnabled?: boolean;
  coverDeleteWithContextActions?: boolean;
  contextActions?: (item: T) => ResultImageContextMenuItem[];
};

export function ResultImageContextMenuHint() {
  return <span className={styles.contextHint}><span className={styles.pointerHint}>图片右键可操作</span><span className={styles.touchHint}>长按图片可操作</span></span>;
}

function WaitingImage({ src }: { src?: string }) {
  const [failed, setFailed] = useState('');
  return src && failed !== src ? <img className={styles.waitingImage} src={src} alt="本次输入图片" onError={() => setFailed(src)} /> : <ImagePlus size={24} aria-hidden="true" />;
}

function GeneratedImageResultCard<T extends GeneratedImageResult>({ item, scope, visible, previewAccount, currentSelection, supportsNextActions, nextSourceSet, select, changePreview, operate, feedback, onSelect, onQuickUse, renderMetadata, renderActions, renderPrimaryActions, renderDelete, renderOverlay, renderSupplement, renderReactionAction, contextActionsEnabled = false, coverDeleteWithContextActions = false, contextActions }: ResultRenderers<T> & {
  item: T; scope: string; visible: boolean; currentSelection: string | null | undefined; supportsNextActions: boolean; nextSourceSet: Set<ContentKey>;
  previewAccount: string;
  select: (item: T) => void; changePreview: (item: T | null, alreadySelected?: boolean, prepared?: ImagePreviewPreparation) => void;
  operate: (item: T, kind: 'copy' | 'download') => Promise<void>;
  feedback: { id: string; message: string; busy: boolean } | null;
  onSelect?: (item: T) => void; onQuickUse?: (item: T) => void;
}) {
  const { user, sessionChanged } = useAppSession();
  const downloadableResult = Boolean(item.generationWait?.resultReady && item.media?.src && item.download && !item.viewOnly
    && (!item.downloadDisabled || item.downloadTemporarilyBusy) && !item.media?.previewOnly && !sessionChanged && !isClientSessionBlocked());
  const waitDisplay = useImageGenerationWaitDisplay(item.generationWait ? { ...item.generationWait, resultReady: downloadableResult } : undefined,
    `${scope}:${user?.id || ''}:${item.id}:${item.generationWait?.taskKey || ''}`, visible);
  const resultError = waitDisplay ? waitDisplay.showIssue ? waitDisplay.detail || item.error : null : item.error;
  const [menuOpen, setMenuOpen] = useState(false);
  const cancelPreviewRef = useRef<(() => void) | null>(null);
  const nextEnabled = Boolean(item.media?.contentKey && nextSourceSet.has(item.media.contentKey));
  const controller = useImageResultNextActions({ sourceKey: item.media?.contentKey, resultId: item.id, scope, enabled: contextActionsEnabled && nextEnabled });
  const identity = JSON.stringify([scope, user?.id || '', item.id, item.media?.contentKey || '']);
  const menuActive = visible && !sessionChanged && !isClientSessionBlocked();
  const readOnly = Boolean(item.viewOnly || item.media?.previewOnly);
  const menuItems: ResultImageContextMenuItem[] = [];
  if (item.media) {
    menuItems.push({ id: 'view', label: '查看大图', group: 'view', icon: <Eye size={15} />, transferFocus: true, onSelect: () => changePreview(item) });
    if (!readOnly) {
      if (item.download) menuItems.push({ id: 'download', label: '下载图片', group: 'view', icon: <Download size={15} />,
        disabled: item.downloadDisabled || Boolean(feedback?.busy), description: item.downloadDisabled ? '图片下载暂不可用' : feedback?.busy ? '正在处理图片，请稍后' : undefined,
        onSelect: () => void operate(item, 'download') });
      menuItems.push({ id: 'copy', label: '复制图片', group: 'view', icon: <ImageIcon size={15} />, disabled: Boolean(feedback?.busy),
        description: feedback?.busy ? '正在处理图片，请稍后' : undefined, onSelect: () => void operate(item, 'copy') });
    }
  }
  if (!readOnly) {
    const pageActions = contextActions?.(item) || [];
    menuItems.push(...pageActions.filter(action => action.group === 'continue'));
    if (nextEnabled) menuItems.push(
      { id: 'cutout', label: '一键抠图', group: 'continue', icon: <Scissors size={15} />, disabled: !controller.canCutout,
        description: controller.cutoutDisabledReason || '打开抠图，费用在目标页确认', onSelect: () => void controller.open('cutout') },
      { id: 'video', label: '用图生成视频', group: 'continue', icon: <Video size={15} />, disabled: !controller.canVideo,
        description: controller.videoDisabledReason || '带入首帧，不立即生成', onSelect: () => void controller.open('video') },
    );
    menuItems.push(...pageActions.filter(action => action.group !== 'continue'));
  }
  const secondaryActions = contextActionsEnabled && readOnly ? null : renderActions?.(item);
  const primaryActions = renderPrimaryActions?.(item, waitDisplay);
  const groupedDelete = coverDeleteWithContextActions ? renderDelete?.(item) : null;
  const coverReactions = Boolean(renderReactionAction && item.media?.contentKey);
  const reactions = item.media?.contentKey ? <ContentReactions contentKey={item.media.contentKey} imageSharing={item.media.imageSharing}
    secondaryAction={renderReactionAction ? null : undefined} overlay={!renderReactionAction} parentControlled={!renderReactionAction} /> : null;
  const cover = item.media ? <ResultImageCover key={`${scope}:${item.id}`} src={item.media.thumbnailSrc || item.media.src} alt={item.label} selected={currentSelection === item.id} applied={Boolean(item.applied)} onSelect={() => select(item)} onPreview={prepared => changePreview(item, true, prepared)} previewSource={previewAccount ? previewPreparationOptions(item, previewAccount) || undefined : undefined} onViewed={item.onViewed} active={visible && Boolean(previewAccount)} onQuickUse={onQuickUse && !item.viewOnly && (!contextActionsEnabled || !readOnly) ? () => onQuickUse(item) : undefined} loadingOverlay={waitDisplay?.finishing ? <span aria-hidden="true" /> : waitDisplay ? <ImageGenerationWaiting display={waitDisplay} visible={visible} loadingImage /> : undefined}
    contextMenuEnabled={contextActionsEnabled} menuOpen={menuOpen && menuActive} cancelPreviewRef={cancelPreviewRef} />
    : <div className={`${styles.pending}${item.generationWait && item.pending ? ` ${styles.generationPending}` : ' sd2-loading-surface'}`} data-busy={item.pending || undefined}
      data-result-choice={onSelect ? '' : undefined} role={onSelect || contextActionsEnabled ? 'button' : undefined} tabIndex={onSelect || contextActionsEnabled ? 0 : undefined} aria-label={onSelect ? `选择${item.label}` : contextActionsEnabled ? `${item.label}，图片操作` : undefined} aria-pressed={onSelect ? currentSelection === item.id : undefined}
      onClick={onSelect ? event => { if (!event.defaultPrevented) select(item); } : undefined}
      onKeyDown={onSelect ? event => { if (!event.defaultPrevented && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item); } } : undefined}>
      <WaitingImage src={item.waitingThumbnail} />{waitDisplay && item.pending ? <ImageGenerationWaiting display={waitDisplay} visible={visible} /> : <span role="status" className={styles.phase}>{waitDisplay?.label || item.status}</span>}
    </div>;
  return <article id={supportsNextActions ? `image-result-${item.id}` : undefined} className={styles.card} data-result-id={item.id} data-result-controls-parent>
    <div className={styles.media} data-transparent={item.transparent || undefined} data-reaction-surface>
      {contextActionsEnabled ? <ResultImageContextMenu identity={identity} active={menuActive} items={menuItems} onOpenChange={open => {
        if (open) cancelPreviewRef.current?.();
        setMenuOpen(open);
      }}>{cover}</ResultImageContextMenu> : cover}
      {waitDisplay?.finishing && <ImageGenerationWaiting display={waitDisplay} visible={visible} />}
      {coverReactions ? <div className={styles.coverReactions}>{reactions}<div className={styles.coverPin}>{renderReactionAction?.(item)}</div></div> : reactions}
      {renderOverlay?.(item, { openPreview: () => changePreview(item) })}
      <ImageBillingBadge billing={item.billing} />
      {!contextActionsEnabled && !coverDeleteWithContextActions && renderDelete && <div className={styles.deleteSlot} data-result-secondary onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>{renderDelete(item)}</div>}
      {(item.media || secondaryActions || groupedDelete) && <div className={styles.mediaActions} data-cover-context-delete={coverDeleteWithContextActions || undefined} data-result-secondary aria-busy={feedback?.id === item.id && feedback.busy || undefined} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        {(item.media || groupedDelete) && <div className={styles.commonActions}>
          {item.media && <>
            {item.download && (!contextActionsEnabled || !readOnly) && <button type="button" aria-label="下载图片" title="下载图片" disabled={item.downloadDisabled || Boolean(feedback?.busy)} onClick={() => void operate(item, 'download')}><Download size={15} /></button>}
            {!item.viewOnly && (!contextActionsEnabled || !readOnly) && <button type="button" aria-label="复制图片" title="复制图片" disabled={Boolean(feedback?.busy)} onClick={() => void operate(item, 'copy')}><ImageIcon size={15} /></button>}
            <button type="button" aria-label="查看图片" title="查看图片" onClick={() => changePreview(item)}><Eye size={15} /></button>
          </>}
          {groupedDelete}
        </div>}
        {secondaryActions && <div className={styles.specialtyActions}>{secondaryActions}</div>}
      </div>}
    </div>
    {contextActionsEnabled ? <ImageResultNextActionFeedback controller={controller} className={`${styles.feedback} ${styles.nextFeedback}`} /> : item.media?.contentKey && nextSourceSet.has(item.media.contentKey) && <ImageResultNextActions sourceKey={item.media.contentKey} resultId={item.id} className={styles.nextActions} />}
    {renderMetadata ? renderMetadata(item) : <div className={styles.heading}><strong title={item.label}>{item.label}</strong><span>{item.status}</span></div>}
    {primaryActions && <div className={styles.actions} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>{primaryActions}</div>}
    {feedback?.id === item.id && <p className={styles.feedback} role="status">{feedback.message}</p>}
    {resultError && <TaskNotice kind={waitDisplay?.pending && !waitDisplay.showRecovery ? 'status' : 'recoverable'} className={styles.notice}>{resultError}</TaskNotice>}
    {renderSupplement?.(item)}
  </article>;
}

export function GeneratedImageResults<T extends GeneratedImageResult>({ items, scope, visible = true, loading = false, busy = false, error = '', emptyLabel = '暂无生成结果', hasMore = false, total, loadMore = noMore, onRetry, selectedId, onSelect, previewId, onPreviewChange, renderMetadata, renderActions, renderPrimaryActions, renderDelete, renderOverlay, renderSupplement, renderReactionAction, paginationSlot, onQuickUse, contextActionsEnabled = false, coverDeleteWithContextActions = false, contextActions }: ResultRenderers<T> & {
  items: T[]; scope: string; visible?: boolean; loading?: boolean; busy?: boolean; error?: string; emptyLabel?: string;
  hasMore?: boolean; loadMore?: () => Promise<unknown>; onRetry?: () => void;
  total?: number | null;
  /** A supplied slot owns pagination placement; null reserves it until mounted. */
  paginationSlot?: HTMLElement | null;
  selectedId?: string | null; onSelect?: (item: T) => void;
  onQuickUse?: (item: T) => void;
  previewId?: string | null; onPreviewChange?: (item: T | null) => void;
}) {
  const { user, hasLoadedUser, userLoadError, sessionChanged } = useAppSession();
  const previewAccount = user ? `${user.id}:${user.role}:${user.account_type || ''}` : '';
  const previewSessionAllowed = Boolean(user && hasLoadedUser && !userLoadError && !sessionChanged && !isClientSessionBlocked());
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [previewPreparation, setPreviewPreparation] = useState<PreviewPreparation | null>(null);
  const previewPreparationRef = useRef<PreviewPreparation | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; message: string; busy: boolean } | null>(null);
  const [readState, setReadState] = useState({ scope, busy: false, error: '' });
  const readLock = useRef(false);
  const requestedPreview = previewId === undefined ? localPreview : previewId;
  const previewOwner = useRef({ scope, account: previewAccount, id: requestedPreview });
  if (previewOwner.current.id !== requestedPreview || !previewOwner.current.account && previewOwner.current.scope === scope) {
    previewOwner.current = { scope, account: previewAccount, id: requestedPreview };
  }
  const previewOwned = previewOwner.current.scope === scope && previewOwner.current.account === previewAccount;
  const activePreview = previewOwned ? requestedPreview : null;
  const currentSelection = selectedId === undefined ? localSelection : selectedId;
  const currentScope = useRef(scope); currentScope.current = scope;
  const pendingOperation = useRef(false);
  const alive = useRef(true);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const previewContext = useRef({ scope, account: previewAccount, allowed: previewSessionAllowed, visible, items });
  previewContext.current = { scope, account: previewAccount, allowed: previewSessionAllowed, visible, items };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; previewPreparationRef.current?.handle.release(); previewPreparationRef.current = null; };
  }, []);
  const readMore = useCallback(async () => {
    if (readLock.current) return;
    readLock.current = true;
    setReadState({ scope, busy: true, error: '' });
    try { await loadMore(); }
    catch (cause) {
      if (alive.current && currentScope.current === scope) setReadState({ scope, busy: false, error: cause instanceof Error ? cause.message : '结果未能读取，请重试' });
      throw cause;
    } finally {
      readLock.current = false;
      if (alive.current && currentScope.current === scope) setReadState(state => ({ ...state, busy: false }));
    }
  }, [loadMore, scope]);
  const readBusy = busy || loading || readState.scope === scope && readState.busy;
  const readError = error || (readState.scope === scope ? readState.error : '');
  const pages = useResultPages({ items, storageKey: scope, visible, busy: readBusy, error: Boolean(readError), hasMore, total, loadMore: readMore, currentId: activePreview || currentSelection || null });
  useEffect(() => { setLocalPreview(null); setLocalSelection(null); setFeedback(null); }, [scope]);
  const previewable = items.filter(item => item.media?.src);
  const preview = previewable.find(item => item.id === activePreview);
  const previewIndex = previewable.findIndex(item => item.id === activePreview);
  const supportsNextActions = scope.startsWith('sd2-image-studio-') || scope.startsWith('story:');
  const nextSources = supportsNextActions ? items.filter(item => item.media?.contentKey?.startsWith('asset:') && !item.pending && !item.viewOnly && !item.media.previewOnly).map(item => item.media!.contentKey!) : [];
  const nextSourceSet = new Set(nextSources);
  const focusRestored = useRef('');
  const focusPositioned = useRef('');
  useEffect(() => {
    if (!supportsNextActions || !visible) return;
    const focusId = new URLSearchParams(window.location.search).get('image_result_focus');
    if (!focusId || focusRestored.current === `${scope}:${focusId}` || !items.some(item => item.id === focusId)) return;
    const focusKey = `${scope}:${focusId}`;
    if (focusPositioned.current !== focusKey) {
      focusPositioned.current = focusKey;
      pages.goToId(focusId); setLocalSelection(focusId);
      const item = items.find(item => item.id === focusId); if (item) onSelect?.(item);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`image-result-${focusId}`);
      if (!card) return;
      focusRestored.current = `${scope}:${focusId}`;
      card.scrollIntoView({ block: 'nearest' }); card.querySelector<HTMLElement>('[data-result-cover], [data-result-choice]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [items, onSelect, pages, scope, supportsNextActions, visible]);
  const imageNeighbors = Array.from(new Set([previewable[previewIndex - 1], previewable[previewIndex + 1]]))
    .filter(item => item?.media && !item.viewOnly && !item.media.previewOnly).map(item => ({ source: item.media!.src, sourceVersion: item.media!.sourceVersion,
      thumbnail: item.media!.thumbnailSrc, width: item.media!.safeDetails?.width, height: item.media!.safeDetails?.height, bytes: item.media!.safeDetails?.fileSize }));
  const changePreview = useCallback((item: T | null, alreadySelected = false, prepared?: ImagePreviewPreparation) => {
    const context = previewContext.current;
    if (!alive.current || context.scope !== scope || context.account !== previewAccount) { prepared?.release(); return; }
    let nextPreparation: PreviewPreparation | null = null;
    if (item) {
      const currentItem = context.items.find(value => value.id === item.id);
      const options = currentItem && previewPreparationOptions(currentItem, context.account);
      const requested = previewPreparationOptions(item, context.account);
      if (!context.allowed || !context.visible || isClientSessionBlocked() || !options || !requested
        || options.source !== requested.source || options.sourceVersion !== requested.sourceVersion || options.previewOnly !== requested.previewOnly
        || prepared && !preparationMatches(prepared, options)) { prepared?.release(); return; }
      // The card's first-click lease is transferred intact. Menu and navigation
      // entry points acquire their current-image lease before changing the view.
      nextPreparation = { scope, itemId: item.id, handle: prepared || prepareImagePreview(options) };
    } else prepared?.release();
    const previous = previewPreparationRef.current;
    previewPreparationRef.current = nextPreparation;
    if (previous?.handle !== nextPreparation?.handle) previous?.handle.release();
    setPreviewPreparation(nextPreparation);
    previewOwner.current = { scope, account: previewAccount, id: item?.id || null };
    if (item && !activePreview) previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      if (item && !alreadySelected) { pages.goToId(item.id); setLocalSelection(item.id); onSelect?.(item); }
      setLocalPreview(item?.id || null);
      onPreviewChange?.(item);
    } catch (cause) {
      if (previewPreparationRef.current === nextPreparation) { nextPreparation?.handle.release(); previewPreparationRef.current = null; setPreviewPreparation(null); }
      throw cause;
    }
    if (!item) {
      const trigger = previewTrigger.current;
      previewTrigger.current = null;
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
    }
  }, [activePreview, onPreviewChange, onSelect, pages, previewAccount, scope]);
  const previewOptions = preview && previewPreparationOptions(preview, previewAccount);
  const currentPreparation = previewPreparation?.scope === scope && previewPreparation.itemId === preview?.id
    && previewOptions && preparationMatches(previewPreparation.handle, previewOptions) ? previewPreparation.handle : undefined;
  useEffect(() => {
    const pending = previewPreparationRef.current;
    if (!pending) return;
    if (!visible || !previewSessionAllowed || isClientSessionBlocked() || pending.scope !== scope || pending.itemId !== preview?.id
      || !previewOptions || !preparationMatches(pending.handle, previewOptions)) {
      pending.handle.release(); previewPreparationRef.current = null; setPreviewPreparation(null);
    }
  }, [activePreview, preview, previewOptions, previewPreparation, previewSessionAllowed, scope, visible]);
  useEffect(() => {
    if (requestedPreview && (!previewOwned || !preview || !visible || !previewSessionAllowed)) { setLocalPreview(null); onPreviewChange?.(null); }
  }, [requestedPreview, previewOwned, preview, onPreviewChange, previewSessionAllowed, visible]);
  function movePreview(direction: -1 | 1) {
    const index = previewable.findIndex(item => item.id === activePreview);
    if (index >= 0) changePreview(previewable[(index + direction + previewable.length) % previewable.length]);
  }
  function select(item: T) { pages.goToId(item.id); setLocalSelection(item.id); onSelect?.(item); }
  async function operate(item: T, kind: 'copy' | 'download') {
    if (pendingOperation.current) return;
    pendingOperation.current = true;
    const identity = scope;
    setFeedback({ id: item.id, busy: true, message: kind === 'copy' ? '复制中' : '准备下载' });
    try {
      if (kind === 'copy' && item.media) await copyImage(item.media.src);
      else await item.download?.();
      if (alive.current && identity === currentScope.current) setFeedback({ id: item.id, busy: false, message: kind === 'copy' ? '图片已复制' : item.downloadMessage || '已交给浏览器下载' });
    } catch (cause) {
      if (alive.current && identity === currentScope.current) setFeedback({ id: item.id, busy: false, message: cause instanceof Error ? cause.message : '操作未完成，请重试' });
    } finally { pendingOperation.current = false; }
  }
  const pageLabel = `第 ${pages.page}${pages.pages === null ? ' 页，仍有更多' : ` / ${pages.pages} 页`}${pages.restoring && !pages.navigationIssue && !readError ? '，正在读取目标页' : ''}`;
  const pagination = (position: 'top' | 'bottom' | 'header') => (items.length > 0 || readError) && <nav className={`${styles.pagination}${position === 'header' ? ` ${styles.headerPagination}` : ''}`} aria-label={position === 'header' ? '图片结果翻页' : position === 'top' ? '图片结果顶部翻页' : '图片结果底部翻页'}>
    <button type="button" aria-label="回到第一页图片" title="回到第一页图片" disabled={!pages.start && !pages.restoring || readBusy} onClick={pages.reset}><ChevronFirst size={17} /></button>
    <button type="button" aria-label="上一页图片" title="上一页图片" disabled={!pages.start || readBusy || pages.restoring && !readError && !pages.navigationIssue} onClick={pages.previous}><ChevronLeft size={17} /></button>
    <span role="status" title={position === 'header' ? pageLabel : undefined}>{pageLabel}</span>
    <button type="button" aria-label="下一页图片" title="下一页图片" disabled={!pages.canNext || readBusy || pages.restoring} onClick={pages.next}><ChevronRight size={17} /></button>
    <button type="button" aria-label="最后一页图片" title="最后一页" disabled={!pages.canLast || readBusy || pages.restoring} onClick={pages.last}><ChevronLast size={17} /></button>
  </nav>;
  return <div className={styles.results} data-generated-image-results>
    {paginationSlot && createPortal(pagination('header'), paginationSlot)}
    {(readError || pages.navigationIssue) && <TaskNotice kind="recoverable" className={styles.notice}>{readError || pages.navigationIssue}<button type="button" disabled={readBusy} onClick={() => { setReadState({ scope, busy: false, error: '' }); pages.retry(); if (pages.restoring && hasMore) return; if (onRetry) onRetry(); else void readMore().catch(() => undefined); }}>{!readError && pages.restoring && hasMore ? '继续翻页' : '重试读取'}</button>{pages.restoring && onRetry && readError && <button type="button" disabled={readBusy} onClick={() => { pages.retry(); onRetry(); }}>刷新目录</button>}</TaskNotice>}
    {loading && (items.length ? <LoadingStatus>正在更新结果，已有图片保留</LoadingStatus> : <LoadingSkeleton label="正在读取生成结果" grid />)}
    {!loading && !items.length && !error && <p className={styles.empty}>{emptyLabel}</p>}
    {paginationSlot === undefined && ((pages.pages ?? 1) > 1 || hasMore) && pagination('top')}
    <div className={styles.grid} ref={pages.gridRef} data-result-pages data-page-capacity={pages.capacity} onKeyDown={event => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-result-cover], [data-result-choice]')) return;
      const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -Math.max(1, pages.capacity / 3), ArrowDown: Math.max(1, pages.capacity / 3) }[event.key];
      if (offset === undefined) return;
      const id = event.target.closest<HTMLElement>('[data-result-id]')?.dataset.resultId;
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return;
      event.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, index + offset))]; select(next);
      requestAnimationFrame(() => { const card = Array.from(pages.gridRef.current?.querySelectorAll<HTMLElement>('[data-result-id]') || []).find(element => element.dataset.resultId === next.id); card?.querySelector<HTMLElement>('[data-result-cover], [data-result-choice]')?.focus(); });
    }}>
      {pages.pageItems.map(item => <GeneratedImageResultCard key={`${scope}:${item.id}`} item={item} scope={scope} visible={visible} previewAccount={previewSessionAllowed ? previewAccount : ''} currentSelection={currentSelection}
        supportsNextActions={supportsNextActions} nextSourceSet={nextSourceSet} select={select} changePreview={changePreview} operate={operate} feedback={feedback}
        onSelect={onSelect} onQuickUse={onQuickUse} renderMetadata={renderMetadata} renderActions={renderActions} renderPrimaryActions={renderPrimaryActions}
        renderDelete={renderDelete} renderOverlay={renderOverlay} renderSupplement={renderSupplement} renderReactionAction={renderReactionAction}
        contextActionsEnabled={contextActionsEnabled} coverDeleteWithContextActions={coverDeleteWithContextActions} contextActions={contextActions} />)}
    </div>
    {paginationSlot === undefined && pagination('bottom')}
    {visible && previewSessionAllowed && preview?.media && <ZoomableImagePreview {...preview.media} preparation={currentPreparation} previewOnly={Boolean(preview.viewOnly || preview.media.previewOnly)} nextActionSources={nextSources as ContentKey[]} nextActionResultId={preview.id} imageNeighbors={imageNeighbors} resolveDownload={src => items.find(item => item.media?.src === src)?.download} previewKey={preview.media.previewKey || `${scope}:${preview.id}`} hasNavigation={previewable.length > 1} onPrevious={() => movePreview(-1)} onNext={() => movePreview(1)} onClose={() => changePreview(null)} />}
  </div>;
}
