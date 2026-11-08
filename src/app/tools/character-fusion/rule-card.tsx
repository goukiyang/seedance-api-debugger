'use client';
import { Check, ChevronDown, ChevronUp, GripVertical, Plus } from 'lucide-react';
import type { Tag } from '@/lib/character-fusion/engine';
import styles from './studio.module.css';

export default function RuleCard({ id, title, tags, joined, expanded, onToggle, onJoin, onTag, onDrop, onMove, children }: {
  id: string; title: string; tags: Tag[]; joined: boolean; expanded: boolean; onToggle: () => void;
  onJoin: () => void; onTag: (label: string) => void; onDrop: (id: string) => void; onMove: (direction: number) => void; children?: React.ReactNode;
}) {
  return <article className={`${styles.ruleCard} ${joined ? styles.joinedCard : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(e.dataTransfer.getData('application/x-sd2-fusion-dimension')); }}>
    <div className={styles.ruleHead} draggable={expanded} onDragStart={e => {
      if ((e.target as HTMLElement).closest('button')?.hasAttribute('aria-pressed')) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-sd2-fusion-dimension', id); e.dataTransfer.effectAllowed = 'copyMove';
    }}>
      <button className={styles.cardToggle} aria-expanded={expanded} aria-controls={`card-${id}`} onClick={onToggle}>{expanded && <GripVertical size={15} aria-hidden="true" />}<span>{title}</span><ChevronDown size={15} className={expanded ? styles.rotated : ''} aria-hidden="true" /></button>
      <button className={joined ? styles.joinedState : styles.notJoinedState} aria-pressed={joined} onClick={onJoin}>{joined ? <Check size={14} /> : <Plus size={14} />}{joined ? '已加入' : '未加入'}</button>
    </div>
    {expanded && <div id={`card-${id}`}>
      <div className={styles.cardTools}><span>拖动顶部可排序或加入组合</span><button aria-label={`前移${title}`} onClick={() => onMove(-1)}><ChevronUp size={14} /></button><button aria-label={`后移${title}`} onClick={() => onMove(1)}><ChevronDown size={14} /></button></div>
      <div className={styles.tags}>{tags.map(tag => <button key={tag.label} className={tag.status === 'must' ? styles.must : tag.status === 'exclude' ? styles.excluded : ''} aria-label={`${title}：${tag.label}，${tag.status === 'must' ? '必须用' : tag.status === 'exclude' ? '排除' : '可以用'}，点击切换`} onClick={() => onTag(tag.label)}><span aria-hidden="true">{tag.status === 'must' ? '✓' : tag.status === 'exclude' ? '−' : '○'}</span>{tag.label}</button>)}</div>
      {children}
    </div>}
  </article>;
}
