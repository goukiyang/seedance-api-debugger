'use client';
import { Check, ChevronDown, ChevronUp, GripVertical, LockKeyhole, Plus, RefreshCw, UnlockKeyhole, X } from 'lucide-react';
import type { Tag } from '@/lib/character-fusion/engine';
import styles from './studio.module.css';

export default function RuleCard({ id, title, tags, joined, expanded, locked, selection, onLock, onCycle, onToggle, onJoin, onTag, onDrop, onMove, children, collapseRules = false, lockDisabled = false, controlId }: {
  id: string; title: string; tags: Tag[]; joined: boolean; expanded: boolean; onToggle: () => void;
  locked: boolean; selection: React.ReactNode; onLock: () => void; onCycle?: () => void;
  onJoin: () => void; onTag: (label: string, status: Tag['status']) => void; onDrop: (id: string) => void; onMove: (direction: number) => void; children?: React.ReactNode; collapseRules?: boolean; lockDisabled?: boolean; controlId?: string;
}) {
  const detailId = controlId || `card-${id}`;
  const must = tags.filter(t => t.status === 'must').length, excluded = tags.filter(t => t.status === 'exclude' && !t.definitionOnly).length;
  const tagControls = <div className={styles.tags}>{tags.map(tag => tag.definitionOnly ? <button type="button" key={tag.label} aria-label={`将${tag.label}加入${title}可用范围`} onClick={() => onTag(tag.label, 'default')}><Plus size={13} />{tag.label} · 未加入</button> : <select key={tag.label} className={tag.status === 'must' ? styles.must : tag.status === 'exclude' ? styles.excluded : ''} aria-label={`${title}：${tag.label}规则`} value={tag.status} onChange={e => onTag(tag.label, e.target.value as Tag['status'])}><option value="default">○ {tag.label} · 可用</option><option value="must">✓ {tag.label} · 这批分别用</option><option value="exclude">− {tag.label} · 排除</option></select>)}</div>;
  return <article id={`${detailId}-root`} className={`${styles.ruleCard} ${joined ? styles.joinedCard : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(e.dataTransfer.getData('application/x-sd2-fusion-dimension')); }}>
    <div className={styles.ruleHead} draggable={expanded} onDragStart={e => {
      const button = (e.target as HTMLElement).closest('button');
      if (button && !button.hasAttribute('aria-expanded')) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-sd2-fusion-dimension', id); e.dataTransfer.effectAllowed = 'copyMove';
    }}>
      {expanded && <GripVertical size={15} aria-hidden="true" />}
      {joined ? <><span className={styles.joinedState}><Check size={16} aria-hidden="true" /><span className={styles.srOnly}>{title}已加入组合</span></span><div className={styles.cardIdentity}><strong className={styles.cardTitle}>{title}</strong><button className={`${styles.iconButton} ${locked ? styles.locked : styles.revealAction}`} aria-label={`${locked ? '解锁' : '锁定'}${title}`} title={locked ? '已锁定，每条都用；点击解锁' : '锁定后每条都用'} aria-pressed={locked} disabled={lockDisabled} onClick={onLock}>{locked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}</button></div><button className={`${styles.iconButton} ${styles.revealAction}`} aria-label={`将${title}移出组合`} title="移出组合，保留卡片与规则" onClick={onJoin}><X size={16} aria-hidden="true" /></button></> : <><button className={styles.cardToggle} aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}><ChevronDown size={15} className={expanded ? styles.rotated : ''} aria-hidden="true" /><span>{title}</span></button><button className={styles.iconButton} aria-label={`将${title}加入组合`} title={`将${title}加入组合`} aria-pressed={joined} onClick={onJoin}><Plus size={17} aria-hidden="true" /></button></>}
    </div>
    {joined && <>{selection}<div className={styles.cardFooter}>{onCycle && <button className={`${styles.iconButton} ${styles.revealAction}`} aria-label={`更换${title}`} title={`更换${title}并锁定`} onClick={onCycle}><RefreshCw size={15} aria-hidden="true" /></button>}<button className={styles.ruleToggle} aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>调整<ChevronDown size={14} className={expanded ? styles.rotated : ''} aria-hidden="true" /></button></div></>}
    {(must > 0 || excluded > 0) && <p className={styles.ruleSummary}>{[must > 0 && `${must}项分别用`, excluded > 0 && `${excluded} 排除`].filter(Boolean).join(' · ')}</p>}
    {expanded && <div className={styles.cardDetails} id={detailId}>
      <div className={styles.cardTools}><span>拖动排序；也可用右侧按钮移动。</span><button aria-label={`前移${title}`} onClick={() => onMove(-1)}><ChevronUp size={14} /></button><button aria-label={`后移${title}`} onClick={() => onMove(1)}><ChevronDown size={14} /></button></div>
      {collapseRules ? <>{children}<details className={styles.facetRules}><summary>标签规则</summary>{tagControls}</details></> : <>{tagControls}{children}</>}
    </div>}
  </article>;
}
