'use client';

import { useState } from 'react';
import { Bookmark, FolderPlus } from 'lucide-react';
import LikeButton from '@/components/content-reactions/LikeButton';
import { InlineActionFeedback, useInlineActionFeedback } from '@/components/InlineActionFeedback';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import type { WorkCard, WorkLifecycleMutation, WorkStateMutation } from '@/lib/works/types';
import styles from './Works.module.css';

export type WorkOperate = (key: string, url: string, body: Record<string, unknown>, method?: string) => Promise<Record<string, unknown> | null>;
export async function reuseWorkTemplate(work: WorkCard, operate: WorkOperate, version: string) {
  const result = await operate(`method:${work.id}`, `/api/works/${encodeURIComponent(work.id)}/method`, { expectedMediaVersion: work.mediaVersion, expectedTemplateVersion: version });
  return result && typeof result.href === 'string' && result.href.startsWith('/') && !result.href.startsWith('//') ? result.href : null;
}
export function WorkActions({ work, labels = false, cover = false, busy, operate, onClassify }: { work: WorkCard; labels?: boolean; cover?: boolean; busy: boolean; operate: WorkOperate; onClassify: (work: WorkCard) => void }) {
  const [bloom, setBloom] = useState(0);
  const { feedback, setFeedback } = useInlineActionFeedback();
  const state = (action: WorkStateMutation['action'], active: boolean) => operate(`work:${work.id}`, `/api/works/${work.id}/state`, { action, active, expectedVersion: work.personal.version, expectedMediaVersion: work.mediaVersion });
  async function toggleLike() {
    const active = !work.personal.liked;
    const result = await state('like', active);
    if (result?.liked === active) setBloom(value => active ? value + 1 : 0);
  }
  async function toggleFavorite() {
    const active = !work.personal.favorited;
    setFeedback(null);
    const result = await state('favorite', active);
    if (result?.favorited === active) setFeedback({ text: active ? '已收藏' : '已取消收藏' });
    else if (!result) setFeedback({ text: '收藏未确认，查看页面提示', failed: true });
  }
  const lifecycle = (action: WorkLifecycleMutation['action']) => void operate(`work:${work.id}`, `/api/works/${work.id}/lifecycle`, { action, expectedRevision: work.revision, expectedMediaVersion: work.mediaVersion });
  const editorial = (action: 'feature' | 'nominate', active: boolean) => operate(`work:${work.id}`, `/api/works/${work.id}/editorial`, {
    action, active, expectedVersion: work.editorial?.version || 0, expectedMediaVersion: work.mediaVersion,
  });
  return <div className={styles.actions}>
    <span className={styles.likeControl} data-work-action="like"><LikeButton active={work.personal.liked} count={work.likeCount} showCount={work.likeCount > 0} animateCount={true} disabled={busy} bloom={bloom} onClick={() => void toggleLike()} /></span>
    <InlineActionFeedback feedback={feedback}><button type="button" data-work-action="favorite" title={work.personal.favorited ? '取消收藏' : '收藏到全部收藏'} aria-label={work.personal.favorited ? '取消收藏' : '收藏到全部收藏'} aria-pressed={work.personal.favorited} disabled={busy} onClick={() => void toggleFavorite()}><Bookmark size={17} fill={work.personal.favorited ? 'currentColor' : 'none'} />{labels && <span>收藏</span>}</button></InlineActionFeedback>
    {!cover && work.personal.favorited && <button type="button" data-work-action="classify" className={styles.classifyButton} title="归类到集合" aria-label="归类到集合" disabled={busy} onClick={() => onClassify(work)}><FolderPlus size={17} />{labels && <span>归类</span>}</button>}
    {!cover && <span className={styles.actionEnd} data-work-action="manage"><ProductActionMenu label={`管理作品：${work.title}`} disabled={busy} actions={[
      ...(work.personal.favorited ? [{ id: 'classify', label: '归类到集合', onSelect: () => onClassify(work) }] : []),
      { id: 'hide', label: work.personal.hidden ? '恢复对我显示' : '对我隐藏', onSelect: () => state('hide', !work.personal.hidden) },
      ...(work.editorial?.canFeature ? [{ id: 'feature', label: work.editorial.featured ? '取消精选' : '设为精选', onSelect: () => editorial('feature', !work.editorial?.featured) }] : []),
      ...(work.editorial?.canNominate ? [{ id: 'nominate', label: work.editorial.nominated ? '停止新作展示' : work.editorial.nominationExpired ? '新作展示已结束' : '恢复新作展示', disabled: !work.editorial.nominated && work.editorial.nominationExpired, onSelect: () => editorial('nominate', !work.editorial?.nominated) }] : []),
      ...(work.canManage ? [
        ...(!work.withdrawn ? [{ id: 'discovery', label: work.discoverable ? '移出广场' : '恢复到广场', onSelect: () => lifecycle(work.discoverable ? 'exclude' : 'restore-discovery') }] : []),
        { id: 'sharing', label: work.withdrawn ? '恢复分享' : '撤回分享', onSelect: () => lifecycle(work.withdrawn ? 'restore-sharing' : 'withdraw') },
      ] : []),
    ]} /></span>}
  </div>;
}
