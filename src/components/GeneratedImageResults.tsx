'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, Eye, ImagePlus, RotateCcw } from 'lucide-react';
import { ResultImageCover } from './ResultImageCover';
import { ZoomableImagePreview, type ZoomableImagePreviewProps } from './ZoomableImagePreview';
import ContentReactions from './content-reactions/ContentReactions';
import { LoadingSkeleton, LoadingStatus } from './LoadingState';
import { copyImage } from '@/lib/media/copy-image';
import { useResultPages } from './useResultPages';
import styles from './GeneratedImageResults.module.css';
import { ImageBillingBadge } from './ImageBillingBadge';
import type { ImageBillingView } from '@/lib/image-studio/billing-contract';

export type GeneratedImageResult = {
  id: string;
  label: string;
  status: string;
  pending?: boolean;
  waitingThumbnail?: string;
  media?: Omit<ZoomableImagePreviewProps, 'onClose' | 'hasNavigation' | 'onPrevious' | 'onNext'>;
  transparent?: boolean;
  applied?: boolean;
  onViewed?: () => void;
  download?: () => void | Promise<unknown>;
  downloadDisabled?: boolean;
  downloadMessage?: string;
  error?: string | null;
  billing?: ImageBillingView | null;
};

const noMore = async () => undefined;

function WaitingImage({ src }: { src?: string }) {
  const [failed, setFailed] = useState('');
  return src && failed !== src ? <img className={styles.waitingImage} src={src} alt="本次输入图片" onError={() => setFailed(src)} /> : <ImagePlus size={24} aria-hidden="true" />;
}

export function GeneratedImageResults<T extends GeneratedImageResult>({ items, scope, visible = true, loading = false, busy = false, error = '', emptyLabel = '暂无生成结果', hasMore = false, loadMore = noMore, onRetry, selectedId, onSelect, previewId, onPreviewChange, renderMetadata, renderActions, renderPrimaryActions, renderDelete, renderOverlay, renderSupplement }: {
  items: T[]; scope: string; visible?: boolean; loading?: boolean; busy?: boolean; error?: string; emptyLabel?: string;
  hasMore?: boolean; loadMore?: () => Promise<unknown>; onRetry?: () => void;
  selectedId?: string | null; onSelect?: (item: T) => void;
  previewId?: string | null; onPreviewChange?: (item: T | null) => void;
  renderMetadata?: (item: T) => ReactNode; renderActions?: (item: T) => ReactNode;
  renderPrimaryActions?: (item: T) => ReactNode; renderDelete?: (item: T) => ReactNode;
  renderOverlay?: (item: T, controls: { openPreview: () => void }) => ReactNode; renderSupplement?: (item: T) => ReactNode;
}) {
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; message: string; busy: boolean } | null>(null);
  const [readState, setReadState] = useState({ scope, busy: false, error: '' });
  const readLock = useRef(false);
  const activePreview = previewId === undefined ? localPreview : previewId;
  const currentSelection = selectedId === undefined ? localSelection : selectedId;
  const currentScope = useRef(scope); currentScope.current = scope;
  const pendingOperation = useRef(false);
  const alive = useRef(true);
  const previewTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
  const pages = useResultPages({ items, storageKey: scope, visible, busy: readBusy, error: Boolean(readError), hasMore, loadMore: readMore, currentId: activePreview || currentSelection || null });
  useEffect(() => { setLocalPreview(null); setLocalSelection(null); setFeedback(null); }, [scope]);
  const previewable = items.filter(item => item.media?.src);
  const preview = previewable.find(item => item.id === activePreview);
  const changePreview = useCallback((item: T | null, alreadySelected = false) => {
    if (item && !activePreview) previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (item && !alreadySelected) { pages.goToId(item.id); setLocalSelection(item.id); onSelect?.(item); }
    setLocalPreview(item?.id || null);
    onPreviewChange?.(item);
    if (!item) {
      const trigger = previewTrigger.current;
      previewTrigger.current = null;
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
    }
  }, [activePreview, onPreviewChange, onSelect, pages]);
  useEffect(() => {
    if (activePreview && !preview) { setLocalPreview(null); onPreviewChange?.(null); }
  }, [activePreview, preview, onPreviewChange]);
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
  const pagination = (position: 'top' | 'bottom') => (items.length > 0 || readError) && <nav className={styles.pagination} aria-label={position === 'top' ? '图片结果顶部翻页' : '图片结果底部翻页'}>
    <button type="button" aria-label="上一页图片" title="上一页图片" disabled={!pages.start || readBusy || pages.restoring && !readError} onClick={pages.previous}><ChevronLeft size={17} /></button>
    <span role="status">第 {pages.page} / {pages.pages}{hasMore ? '+' : ''} 页</span>
    <button type="button" aria-label="下一页图片" title="下一页图片" disabled={!pages.canNext || readBusy || pages.restoring} onClick={pages.next}><ChevronRight size={17} /></button>
    {position === 'bottom' && pages.canNext && <button type="button" disabled={readBusy || pages.restoring} onClick={pages.next}>{readBusy ? '读取中' : '加载更多'}</button>}
    <button type="button" aria-label="回到第一页图片" title="回到第一页图片" disabled={readBusy || pages.restoring && !readError} onClick={pages.reset}><RotateCcw size={15} /></button>
  </nav>;
  return <div className={styles.results} data-generated-image-results>
    {readError && <p role="alert" className={styles.error}>{readError}<button type="button" disabled={readBusy} onClick={() => { setReadState({ scope, busy: false, error: '' }); if (onRetry) onRetry(); else void readMore().catch(() => undefined); }}>重试读取</button></p>}
    {loading && (items.length ? <LoadingStatus>正在更新结果，已有图片保留</LoadingStatus> : <LoadingSkeleton label="正在读取生成结果" grid />)}
    {!loading && !items.length && !error && <p className={styles.empty}>{emptyLabel}</p>}
    {(pages.pages > 1 || hasMore) && pagination('top')}
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
      {pages.pageItems.map(item => {
        const secondaryActions = renderActions?.(item);
        const primaryActions = renderPrimaryActions?.(item);
        return (
          <article key={item.id} className={styles.card} data-result-id={item.id} data-result-controls-parent>
            <div className={styles.media} data-transparent={item.transparent || undefined} data-reaction-surface>
              {item.media ? <>
                <ResultImageCover src={item.media.thumbnailSrc || item.media.src} alt={item.label} selected={currentSelection === item.id} applied={Boolean(item.applied)} onSelect={() => select(item)} onPreview={() => changePreview(item, true)} onViewed={item.onViewed} />
                {item.media.contentKey && <ContentReactions contentKey={item.media.contentKey} imageSharing={item.media.imageSharing} overlay parentControlled />}
              </> : <div className={`${styles.pending} sd2-loading-surface`} data-busy={item.pending || undefined}
                data-result-choice={onSelect ? '' : undefined} role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={onSelect ? `选择${item.label}` : undefined} aria-pressed={onSelect ? currentSelection === item.id : undefined}
                onClick={onSelect ? () => select(item) : undefined}
                onKeyDown={onSelect ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(item); } } : undefined}>
                <WaitingImage src={item.waitingThumbnail} /><span role="status" className={styles.phase}>{item.status}</span>
              </div>}
              {renderOverlay?.(item, { openPreview: () => changePreview(item) })}
              <ImageBillingBadge billing={item.billing} />
              {renderDelete && <div className={styles.deleteSlot} data-result-secondary onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>{renderDelete(item)}</div>}
              {(item.media || secondaryActions) && <div className={styles.mediaActions} data-result-secondary aria-busy={feedback?.id === item.id && feedback.busy || undefined} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
                {item.media && <div className={styles.commonActions}>
                  {item.download && <button type="button" aria-label="下载图片" title="下载图片" disabled={item.downloadDisabled || Boolean(feedback?.busy)} onClick={() => void operate(item, 'download')}><Download size={15} /></button>}
                  <button type="button" aria-label="复制图片" title="复制图片" disabled={Boolean(feedback?.busy)} onClick={() => void operate(item, 'copy')}><Copy size={15} /></button>
                  <button type="button" aria-label="查看图片" title="查看图片" onClick={() => changePreview(item)}><Eye size={15} /></button>
                </div>}
                {secondaryActions && <div className={styles.specialtyActions}>{secondaryActions}</div>}
              </div>}
            </div>
            {renderMetadata ? renderMetadata(item) : <div className={styles.heading}><strong title={item.label}>{item.label}</strong><span>{item.status}</span></div>}
            {primaryActions && <div className={styles.actions} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>{primaryActions}</div>}
            {feedback?.id === item.id && <p className={styles.feedback} role="status">{feedback.message}</p>}
            {item.error && <p role="alert" className={styles.error}>{item.error}</p>}
            {renderSupplement?.(item)}
          </article>
        );
      })}
    </div>
    {pagination('bottom')}
    {preview?.media && <ZoomableImagePreview {...preview.media} resolveDownload={src => items.find(item => item.media?.src === src)?.download} previewKey={preview.media.previewKey || `${scope}:${preview.id}`} hasNavigation={previewable.length > 1} onPrevious={() => movePreview(-1)} onNext={() => movePreview(1)} onClose={() => changePreview(null)} />}
  </div>;
}
