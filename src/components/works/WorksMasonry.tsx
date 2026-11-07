'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowUpRight, Eye, Repeat2 } from 'lucide-react';
import { defaultRangeExtractor, useWindowVirtualizer } from '@tanstack/react-virtual';
import { ImageResultStatusDetails } from '@/components/ImageResultStatusDetails';
import { RelativeTime } from '@/components/RelativeTime';
import type { WorkCard } from '@/lib/works/types';
import type { WorkAnchor, WorkRestore } from '@/lib/works/view-state';
import type { AssetPlaybackCoordinator } from '@/lib/media/asset-playback';
import { WorkMedia } from './WorkMedia';
import { WorkActions, reuseWorkTemplate, type WorkOperate } from './WorkActions';
import { WorkAuthor } from './WorkAuthor';
import styles from './Works.module.css';

const compactCount = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

export function visibleWorkAnchor(): WorkAnchor | null {
  const card = Array.from(document.querySelectorAll<HTMLElement>('[data-work-card]')).filter(card => { const rect = card.getBoundingClientRect(); return rect.bottom > 100 && rect.top < window.innerHeight; }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusCard = active?.closest<HTMLElement>('[data-work-card]');
  const focusAction = focusCard ? active?.closest<HTMLElement>('[data-work-action]')?.dataset.workAction : undefined;
  return card ? { id: card.dataset.workCard!, offset: card.getBoundingClientRect().top, ...(focusAction && focusCard?.dataset.workCard ? { focusId: focusCard.dataset.workCard, focusAction } : {}) } : null;
}
type LogicalFocus = { workId: string; action: string; navigationEpoch: number };
export function WorksMasonry({ items, playback, contextKey, detailOpen, layoutKey, busyKeys, operate, onClassify, onOpen, onFilter, restore, navigationEpoch, onRestored }: {
  items: WorkCard[]; playback: AssetPlaybackCoordinator; contextKey: string; detailOpen: boolean; busyKeys: string[]; operate: WorkOperate;
  onClassify: (work: WorkCard) => void; onOpen: (work: WorkCard) => void; onFilter: (key: 'author' | 'project', id: string) => void;
  restore: WorkRestore | null; navigationEpoch: MutableRefObject<number>; onRestored: (generation: number) => void;
  layoutKey?: string;
}) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0), [margin, setMargin] = useState(0), [focused, setFocused] = useState<string | null>(null);
  const resizeRestore = useRef<WorkRestore | null>(null), lastWidth = useRef(0), restorationGeneration = useRef(0), resizeGeneration = useRef(0), focus = useRef<LogicalFocus | null>(null), previousGeometry = useRef('');
  const itemsRef = useRef(items); itemsRef.current = items;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function reuse(work: WorkCard) {
    const epoch = navigationEpoch.current, version = work.provenance?.template?.reuseVersion;
    if (!version) return;
    const href = await reuseWorkTemplate(work, operate, version);
    if (mounted.current && epoch === navigationEpoch.current && href) window.location.assign(href);
  }
  useLayoutEffect(() => {
    const element = container.current; if (!element) return;
    const update = () => {
      const nextWidth = element.clientWidth;
      if (lastWidth.current && lastWidth.current !== nextWidth) { const anchor = visibleWorkAnchor(); if (anchor) resizeRestore.current = { ...anchor, navigationEpoch: navigationEpoch.current, generation: --resizeGeneration.current }; }
      lastWidth.current = nextWidth; setWidth(nextWidth); setMargin(element.getBoundingClientRect().top + window.scrollY);
    };
    update(); const observer = new ResizeObserver(update); observer.observe(element); window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [navigationEpoch]);
  useLayoutEffect(() => { const element = container.current; if (element) setMargin(element.getBoundingClientRect().top + window.scrollY); }, [items, busyKeys, detailOpen, layoutKey]);
  const lanes = width >= 1450 ? 5 : width >= 1100 ? 4 : width >= 760 ? 3 : 2, gap = width < 600 ? 10 : 18, columnWidth = Math.max(0, (width - gap * (lanes - 1)) / lanes);
  const focusedIndex = items.findIndex(work => work.id === (restore?.focusId || focused)), geometry = `${width}:${margin}:${items.map(work => `${work.id}:${work.width}:${work.height}`).join(',')}`;
  const getItemKey = useCallback((index: number) => itemsRef.current[index].id, []);
  const virtual = useWindowVirtualizer({ count: width ? items.length : 0, lanes, gap, scrollMargin: margin, overscan: 2, getItemKey,
    estimateSize: index => { const work = itemsRef.current[index]; return Math.max(40, columnWidth * (work.width && work.height ? work.height / work.width : 1)) + (work.medium === 'video' ? 44 : 0); },
    rangeExtractor: range => { const visible = defaultRangeExtractor(range); return focusedIndex < 0 || visible.includes(focusedIndex) ? visible : [...visible, focusedIndex].sort((a, b) => a - b); },
  });
  useLayoutEffect(() => {
    if (previousGeometry.current === geometry) return;
    previousGeometry.current = geometry;
    // Public reset drops lane/item history, while stable work keys preserve controls and focus.
    // No element measurements are accumulated; geometry is bounded by the six-page window.
    virtual.measure();
  }, [geometry, virtual]);
  useLayoutEffect(() => {
    const generation = ++restorationGeneration.current, anchor = restore || resizeRestore.current;
    if (!width || !anchor) return;
    let frame = 0, attempts = 0;
    const current = () => generation === restorationGeneration.current && anchor.navigationEpoch === navigationEpoch.current;
    const finish = () => { if (generation !== restorationGeneration.current) return; resizeRestore.current = null; onRestored(anchor.generation); };
    if (!current()) { finish(); return; }
    const index = items.findIndex(work => work.id === anchor.id), offset = index >= 0 ? virtual.getOffsetForIndex(index, 'start')?.[0] : undefined;
    if (offset === undefined) { window.scrollTo({ top: margin, behavior: 'instant' as ScrollBehavior }); finish(); return; }
    // A single explicit scroll avoids the virtualizer retaining a scroll-to-index retry intent.
    window.scrollTo({ top: offset, behavior: 'instant' as ScrollBehavior });
    const settle = () => {
      if (!current()) { finish(); return; }
      const card = container.current?.querySelector<HTMLElement>(`[data-work-card="${CSS.escape(anchor.id)}"]`);
      if (!card && ++attempts < 3) { frame = requestAnimationFrame(settle); return; }
      if (card && current()) {
        window.scrollBy({ top: card.getBoundingClientRect().top - anchor.offset, behavior: 'instant' as ScrollBehavior });
        if (anchor.focusAction) {
          const focusCard = anchor.focusId ? container.current?.querySelector<HTMLElement>(`[data-work-card="${CSS.escape(anchor.focusId)}"]`) : card;
          const action = focusCard?.querySelector<HTMLElement>(`[data-work-action="${CSS.escape(anchor.focusAction)}"]`);
          const target = action?.matches('button, a, [tabindex]') ? action : action?.querySelector<HTMLElement>('button, a, [tabindex]');
          if (target && !target.matches(':disabled, [aria-disabled="true"]')) target.focus({ preventScroll: true });
        }
      }
      finish();
    };
    frame = requestAnimationFrame(settle);
    return () => { restorationGeneration.current++; cancelAnimationFrame(frame); };
  }, [geometry, items, margin, navigationEpoch, onRestored, restore, virtual, width]);
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body || target.closest('[data-work-card], [role="dialog"], [role="menu"]')) return;
      focus.current = null; setFocused(null);
    };
    window.addEventListener('focusin', moved); return () => window.removeEventListener('focusin', moved);
  }, []);
  useLayoutEffect(() => {
    const candidate = focus.current;
    if (!candidate || detailOpen || candidate.navigationEpoch !== navigationEpoch.current || !items.some(work => work.id === candidate.workId)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement && active.isConnected) return;
    const frame = requestAnimationFrame(() => {
      if (focus.current !== candidate || candidate.navigationEpoch !== navigationEpoch.current || document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
      const action = container.current?.querySelector<HTMLElement>(`[data-work-card="${CSS.escape(candidate.workId)}"] [data-work-action="${CSS.escape(candidate.action)}"]`);
      const target = action?.matches('button, a, [tabindex]') ? action : action?.querySelector<HTMLElement>('button, a, [tabindex]');
      if (target && !target.matches(':disabled, [aria-disabled="true"]')) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [busyKeys, detailOpen, geometry, items, navigationEpoch]);
  function rememberFocus(workId: string, target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    const action = target.closest<HTMLElement>('[data-work-action]')?.dataset.workAction;
    if (action) { focus.current = { workId, action, navigationEpoch: navigationEpoch.current }; setFocused(workId); }
  }
  return <div ref={container} className={styles.masonry} style={{ height: virtual.getTotalSize() }} aria-label="作品列表">{virtual.getVirtualItems().map(item => { const work = items[item.index];
    const canReuse = Boolean(work.provenance?.template?.reuseVersion);
    const busy = busyKeys.includes(`work:${work.id}`) || busyKeys.includes(`method:${work.id}`);
    const source = work.provenance?.template || work.provenance?.tool;
    return <article key={work.id} className={styles.workCard} data-work-card={work.id} style={{ width: columnWidth, position: 'absolute', top: 0, left: item.lane * (columnWidth + gap), transform: `translateY(${item.start - margin}px)` }}
    onFocusCapture={event => rememberFocus(work.id, event.target)} onKeyDownCapture={event => rememberFocus(work.id, event.target)} onPointerDownCapture={event => { if (event.currentTarget.contains(document.activeElement)) rememberFocus(work.id, document.activeElement); }}>
    <div className={styles.cardVisual}>
      <div className={styles.mediaButton} data-work-action="preview" role="button" tabIndex={0} aria-label={`查看作品：${work.title}`} onClick={() => onOpen(work)} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onOpen(work); } }}><WorkMedia key={`${work.id}:${work.mediaVersion}`} work={work} playback={playback} contextKey={contextKey} detailOpen={detailOpen} /></div>
      {work.medium === 'image' && <div className={styles.imageCardDetails} data-work-action="details">
        <ImageResultStatusDetails active={!detailOpen} scopeKey={`${contextKey}:${work.id}:${work.mediaVersion}:card-details`} label="查看作品详情" heading="作品详情">
          <div className={styles.imageCardDetailsBody}>
            <p className={styles.imageCardTitle}>{work.title}</p>
            <dl className={styles.imageCardDetailsList}>
              <div><dt>作者</dt><dd><WorkAuthor author={work.author} onClick={() => onFilter('author', work.author.id)} /></dd></div>
              <div><dt>完成时间</dt><dd><RelativeTime value={work.completedAt} /></dd></div>
              <div><dt>来源</dt><dd>{source ? <a href={source.href} title={`${work.provenance?.tool.label || source.label} · ${source.label}`}>{source.label}</a> : '来源未记录'}</dd></div>
              {work.activity && <div><dt>使用情况</dt><dd>{work.activity.views} 次查看 · {work.activity.reuses} 次复用</dd></div>}
            </dl>
            <button type="button" className={styles.imageCardDetailAction} onClick={() => onOpen(work)}>打开完整作品详情</button>
          </div>
        </ImageResultStatusDetails>
      </div>}
      <div className={styles.cardOverlay}><WorkActions work={work} cover busy={busy} operate={operate} onClassify={onClassify} /></div>
      {canReuse && <button type="button" className={styles.reuseButton} data-work-action="reuse" disabled={busy} onClick={() => void reuse(work)}><span>一键参考</span><ArrowUpRight size={15} aria-hidden="true" /></button>}
    </div>
    {work.medium === 'video' && <div className={styles.cardInfo}>
      <div className={styles.cardSource} data-work-action="source">{work.provenance
        ? <a href={(work.provenance.template || work.provenance.tool).href} title={`${work.provenance.tool.label} · ${work.provenance.template?.label || work.provenance.tool.label}`}>{(work.provenance.template || work.provenance.tool).label}</a>
        : <span>来源未记录</span>}</div>
      {work.activity && <div className={styles.cardActivity}>
        <span role="img" title={`查看 ${work.activity.views} 次`} aria-label={`查看 ${work.activity.views} 次`}><Eye size={13} aria-hidden="true" />{compactCount.format(work.activity.views)}</span>
        <span role="img" title={`复用 ${work.activity.reuses} 次`} aria-label={`复用 ${work.activity.reuses} 次`}><Repeat2 size={13} aria-hidden="true" />{compactCount.format(work.activity.reuses)}</span>
      </div>}
      <div className={styles.cardIdentity} data-work-action="author"><WorkAuthor author={work.author} onClick={() => onFilter('author', work.author.id)} /></div>
    </div>}
  </article>; })}</div>;
}
