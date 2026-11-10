'use client';
import { Check, ChevronDown, ChevronUp, GripVertical, Plus } from 'lucide-react';
import type { Tag } from '@/lib/character-fusion/engine';
import styles from './studio.module.css';

export default function RuleCard({ id, title, tags, joined, expanded, required, onToggle, onJoin, onTag, onDrop, onMove, children }: {
  id: string; title: string; tags: Tag[]; joined: boolean; expanded: boolean; onToggle: () => void;
  required?: boolean; onJoin: () => void; onTag: (label: string, status: Tag['status']) => void; onDrop: (id: string) => void; onMove: (direction: number) => void; children?: React.ReactNode;
}) {
  return <article className={`${styles.ruleCard} ${joined ? styles.joinedCard : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(e.dataTransfer.getData('application/x-sd2-fusion-dimension')); }}>
    <div className={styles.ruleHead} draggable={expanded} onDragStart={e => {
      if ((e.target as HTMLElement).closest('button')?.hasAttribute('aria-pressed')) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-sd2-fusion-dimension', id); e.dataTransfer.effectAllowed = 'copyMove';
    }}>
      <button className={styles.cardToggle} aria-expanded={expanded} aria-controls={`card-${id}`} onClick={onToggle}>{expanded && <GripVertical size={15} aria-hidden="true" />}<span>{title}{required && <small>基础</small>}</span><ChevronDown size={15} className={expanded ? styles.rotated : ''} aria-hidden="true" /></button>
      <button className={joined ? styles.joinedState : styles.notJoinedState} aria-pressed={joined} onClick={onJoin}>{joined ? <Check size={14} /> : <Plus size={14} />}{joined ? '已加入' : '未加入'}</button>
    </div>
    <p className={styles.ruleSummary}>{tags.filter(t => t.status !== 'exclude').length} 可用{tags.some(t => t.status === 'must') && ` · ${tags.filter(t => t.status === 'must').length} 本批必出`}{tags.some(t => t.status === 'exclude') && ` · ${tags.filter(t => t.status === 'exclude').length} 排除`}</p>
    {expanded && <div id={`card-${id}`}>
      <div className={styles.cardTools}><span>拖动顶部可排序或加入组合；必出项在本批至少一次。</span><button aria-label={`前移${title}`} onClick={() => onMove(-1)}><ChevronUp size={14} /></button><button aria-label={`后移${title}`} onClick={() => onMove(1)}><ChevronDown size={14} /></button></div>
      <div className={styles.tags}>{tags.map(tag => <select key={tag.label} className={tag.status === 'must' ? styles.must : tag.status === 'exclude' ? styles.excluded : ''} aria-label={`${title}：${tag.label}规则`} value={tag.status} onChange={e => onTag(tag.label, e.target.value as Tag['status'])}><option value="default">○ {tag.label} · 可用</option><option value="must">✓ {tag.label} · 本批必出</option><option value="exclude">− {tag.label} · 排除</option></select>)}</div>
      {children}
    </div>}
  </article>;
}
