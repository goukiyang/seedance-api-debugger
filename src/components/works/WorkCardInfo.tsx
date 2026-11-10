'use client';

import { Eye, Repeat2 } from 'lucide-react';
import type { WorkCard } from '@/lib/works/types';
import { WorkAuthor } from './WorkAuthor';
import styles from './Works.module.css';

const compactCount = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

export function WorkCardInfo({ work, onAuthor }: { work: WorkCard; onAuthor?: () => void }) {
  const source = work.provenance?.template || work.provenance?.tool;
  return <div className={styles.cardInfo}>
    <div className={styles.cardSource} data-work-action="source">{source
      ? <a href={source.href} title={`${work.provenance!.tool.label} · ${source.label}`}>{source.label}</a>
      : <span>来源未记录</span>}</div>
    {work.activity && <div className={styles.cardActivity}>
      <span role="img" title={`查看 ${work.activity.views} 次`} aria-label={`查看 ${work.activity.views} 次`}><Eye size={13} aria-hidden="true" />{compactCount.format(work.activity.views)}</span>
      <span role="img" title={`复用 ${work.activity.reuses} 次`} aria-label={`复用 ${work.activity.reuses} 次`}><Repeat2 size={13} aria-hidden="true" />{compactCount.format(work.activity.reuses)}</span>
    </div>}
    <div className={styles.cardIdentity} data-work-action="author"><WorkAuthor author={work.author} onClick={onAuthor} /></div>
  </div>;
}
