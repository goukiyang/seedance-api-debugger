'use client';

import { Bookmark, FolderPlus, Heart } from 'lucide-react';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import type { WorkCard, WorkLifecycleMutation, WorkStateMutation } from '@/lib/works/types';
import styles from './Works.module.css';

export type WorkOperate = (key: string, url: string, body: Record<string, unknown>, method?: string) => Promise<Record<string, unknown> | null>;
export function WorkActions({ work, busy, operate, onClassify }: { work: WorkCard; busy: boolean; operate: WorkOperate; onClassify: (work: WorkCard) => void }) {
  const state = (action: WorkStateMutation['action'], active: boolean) => void operate(`work:${work.id}`, `/api/works/${work.id}/state`, { action, active, expectedVersion: work.personal.version, expectedMediaVersion: work.mediaVersion });
  const lifecycle = (action: WorkLifecycleMutation['action']) => void operate(`work:${work.id}`, `/api/works/${work.id}/lifecycle`, { action, expectedRevision: work.revision, expectedMediaVersion: work.mediaVersion });
  return <div className={styles.actions}>
    <button type="button" data-work-action="like" title={work.personal.liked ? '取消赞' : '赞'} aria-label={work.personal.liked ? '取消赞' : '赞'} aria-pressed={work.personal.liked} data-liked={work.personal.liked || undefined} disabled={busy} onClick={() => state('like', !work.personal.liked)}><Heart size={17} fill={work.personal.liked ? 'currentColor' : 'none'} />{work.likeCount > 0 && <span>{work.likeCount}</span>}</button>
    <button type="button" data-work-action="favorite" title={work.personal.favorited ? '取消收藏' : '收藏到全部收藏'} aria-label={work.personal.favorited ? '取消收藏' : '收藏到全部收藏'} aria-pressed={work.personal.favorited} disabled={busy} onClick={() => state('favorite', !work.personal.favorited)}><Bookmark size={17} fill={work.personal.favorited ? 'currentColor' : 'none'} /></button>
    {work.personal.favorited && <button type="button" data-work-action="classify" className={styles.classifyButton} title="归类到集合" aria-label="归类到集合" disabled={busy} onClick={() => onClassify(work)}><FolderPlus size={17} /></button>}
    <span className={styles.actionEnd} data-work-action="manage"><ProductActionMenu label={`管理作品：${work.title}`} disabled={busy} actions={[
      ...(work.personal.favorited ? [{ id: 'classify', label: '归类到集合', onSelect: () => onClassify(work) }] : []),
      { id: 'hide', label: work.personal.hidden ? '恢复对我显示' : '对我隐藏', onSelect: () => state('hide', !work.personal.hidden) },
      ...(work.canManage ? [
        ...(!work.withdrawn ? [{ id: 'discovery', label: work.discoverable ? '移出广场' : '恢复到广场', onSelect: () => lifecycle(work.discoverable ? 'exclude' : 'restore-discovery') }] : []),
        { id: 'sharing', label: work.withdrawn ? '恢复分享' : '撤回分享', onSelect: () => lifecycle(work.withdrawn ? 'restore-sharing' : 'withdraw') },
      ] : []),
    ]} /></span>
  </div>;
}
