'use client';
import { useState } from 'react';
import { LockKeyhole, UnlockKeyhole, Plus, X, RefreshCw } from 'lucide-react';
import { CONFIG, allowed, type Dimension, type FusionSettings } from '@/lib/character-fusion/engine';
import { TRAITS, concreteOptions, displayGroup, emptyCatalogue, emptyTrait, type TraitState } from '@/lib/character-fusion/catalogue';
import styles from './studio.module.css';

export default function CatalogueEditor({ settings, onChange }: { settings: FusionSettings; onChange: (next: FusionSettings) => void }) {
  const [tab, setTab] = useState<'fusion' | 'body' | 'extra'>('fusion');
  const catalogue = settings.catalogue || emptyCatalogue();
  const changeTrait = (id: string, update: (state: TraitState) => TraitState) => onChange({ ...settings, catalogue: { ...catalogue, traits: { ...catalogue.traits, [id]: update(catalogue.traits[id] || emptyTrait()) } } });
  const selectTrait = (id: string, label: string) => {
    const definition = TRAITS.find(t => t.id === id)!;
    changeTrait(id, s => {
      const values = definition.multi && !label.startsWith('无') ? s.values.filter(v => !v.startsWith('无')).includes(label) ? s.values.filter(v => v !== label && !v.startsWith('无')) : [...s.values.filter(v => !v.startsWith('无')), label] : [label];
      return { ...s, enabled: true, locked: values.length > 0, values, excluded: s.excluded.filter(v => v !== label) };
    });
  };
  const basePicker = (id: Dimension) => {
    const definition = CONFIG.find(c => c.id === id)!, joined = settings.bossDimensions.includes(id), fixed = settings.bossLocks[id];
    const detail = catalogue.details[id];
    const groups = (fixed ? [settings.boss[id]] : allowed(settings, id)).map(label => ({ label, options: concreteOptions(id, label) })).filter(g => g.options.length);
    const updateGroup = (value: string) => {
      const details = { ...catalogue.details }; delete details[id];
      onChange({ ...settings, boss: { ...settings.boss, [id]: value || settings.boss[id] }, bossLocks: { ...settings.bossLocks, [id]: Boolean(value) }, bossDimensions: Array.from(new Set([...settings.bossDimensions, id])), catalogue: { ...catalogue, details } });
    };
    return <div key={id} className={styles.catalogueRow}>
      <div className={styles.catalogueLabel}><strong>{id === 'source' ? '造型母体' : id === 'concept' ? '主题灵感' : id === 'personality' ? '主性格' : definition.title}</strong><button className={styles.iconButton} title={fixed ? '解锁类别，允许抽卡更换' : '固定当前类别'} aria-label={`${fixed ? '解锁' : '锁定'}${definition.title}类别`} aria-pressed={fixed} onClick={() => onChange({ ...settings, bossLocks: { ...settings.bossLocks, [id]: !fixed } })}>{fixed ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button><small>{joined ? fixed ? '类别固定' : '类别随机' : '未启用'}</small>{id === 'mechanism' && <button className={styles.iconButton} aria-label={joined ? '移出机制' : '加入机制'} onClick={() => onChange({ ...settings, bossDimensions: joined ? settings.bossDimensions.filter(v => v !== id) : [...settings.bossDimensions, id] })}>{joined ? <X size={15} /> : <Plus size={15} />}</button>}</div>
      <div className={styles.catalogueValues}><div className={styles.pills}><button type="button" aria-pressed={joined && !fixed} onClick={() => updateGroup('')}>随机类别</button>{allowed(settings, id).map(label => <button type="button" key={label} aria-pressed={joined && fixed && settings.boss[id] === label} onClick={() => updateGroup(label)}>{displayGroup(label)}</button>)}</div>
        {groups.length > 0 && <label className={styles.concretePicker}><span>具体{id === 'source' ? '母体' : id === 'concept' ? '主题参考实例' : '设计'}</span><select aria-label={`具体${definition.title}选项`} value={detail?.locked ? detail.value : ''} onChange={e => {
          const value = e.target.value, details = { ...catalogue.details };
          if (!value) { delete details[id]; onChange({ ...settings, catalogue: { ...catalogue, details } }); return; }
          const group = groups.find(g => g.options.some(o => o.zh === value))!;
          onChange({ ...settings, boss: { ...settings.boss, [id]: group.label }, bossLocks: { ...settings.bossLocks, [id]: true }, bossDimensions: Array.from(new Set([...settings.bossDimensions, id])), catalogue: { ...catalogue, details: { ...details, [id]: { value, locked: true } } } });
        }}><option value="">在类别范围内随机</option>{groups.map(g => <optgroup label={displayGroup(g.label)} key={g.label}>{g.options.map(o => <option value={o.zh} key={o.zh}>{displayGroup(o.zh)}</option>)}</optgroup>)}</select>{detail?.locked && <small>已固定具体选项</small>}{id === 'concept' && settings.catalogue?.traits.occupation?.enabled && <small>职业按独立设置；参考实例保留。</small>}</label>}
      </div>
    </div>;
  };
  const renderTrait = (id: string) => {
    const t = TRAITS.find(t => t.id === id)!, s = catalogue.traits[id] || emptyTrait();
    const legacyDimension = id === 'primaryPersonality' ? 'personality' : ['mechanismPrinciple', 'mechanismMotion'].includes(id) ? 'mechanism' : undefined;
    const inherited = !s.enabled && legacyDimension && settings.bossDimensions.includes(legacyDimension);
    return <div className={styles.catalogueRow} key={id}>
      <div className={styles.catalogueLabel}><strong>{t.title}</strong><button className={`${styles.iconButton} ${s.locked ? styles.locked : ''}`} aria-label={`${s.locked ? '解锁' : '锁定'}${t.title}`} aria-pressed={s.locked} disabled={!s.enabled || !s.values.length} title="锁定后抽卡保留当前选择" onClick={() => changeTrait(id, v => ({ ...v, locked: !v.locked }))}>{s.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button><small>{s.enabled ? s.locked ? t.multi ? '固定 · 可多选' : '固定' : '随机' : inherited ? '沿用原卡片' : '未单独设置'}</small><button className={`${styles.iconButton} ${styles.catalogueReveal}`} aria-label={s.enabled ? `移出${t.title}` : `加入${t.title}`} title={s.enabled ? '移出，保留选择与规则' : '加入抽卡'} onClick={() => changeTrait(id, v => ({ ...v, enabled: !v.enabled, locked: v.values.length > 0 && v.locked }))}>{s.enabled ? <X size={15} /> : <Plus size={15} />}</button></div>
      <div className={styles.catalogueValues}>{inherited && legacyDimension && <p className={styles.hint}>原卡片：{settings.bossLocks[legacyDimension] ? settings.boss[legacyDimension] : '按原规则随机'}；在这里选择后覆盖同一属性。</p>}<div className={styles.pills}><button type="button" aria-pressed={s.enabled && !s.locked} onClick={() => changeTrait(id, v => ({ ...v, enabled: true, locked: false }))}><RefreshCw size={13} />随机</button>{t.options.filter(o => !s.excluded.includes(o.zh)).map(o => <button type="button" key={o.zh} aria-pressed={s.enabled && s.locked && s.values.includes(o.zh)} onClick={() => selectTrait(id, o.zh)}>{o.zh}</button>)}</div>
        <details className={styles.facetRules}><summary>规则{s.excluded.length + s.must.length > 0 && ` · ${s.must.length}必出 / ${s.excluded.length}排除`}</summary><div className={styles.tags}>{t.options.map(o => <label key={o.zh}><span className={styles.srOnly}>{t.title}：{o.zh}规则</span><select value={s.excluded.includes(o.zh) ? 'exclude' : s.must.includes(o.zh) ? 'must' : 'default'} onChange={e => changeTrait(id, v => ({ ...v, excluded: [...v.excluded.filter(x => x !== o.zh), ...(e.target.value === 'exclude' ? [o.zh] : [])], must: [...v.must.filter(x => x !== o.zh), ...(e.target.value === 'must' ? [o.zh] : [])] }))}><option value="default">{o.zh} · 可用</option><option value="must">{o.zh} · 本批必出</option><option value="exclude">{o.zh} · 排除</option></select></label>)}</div></details>
      </div>
    </div>;
  };
  const primaryBody = ['headRatio', 'silhouette', 'torsoLength', 'armLength', 'legLength', 'exaggeration'];
  return <div className={styles.catalogue}>
    <div className={styles.tabs} aria-label="组合设置分组">{([['fusion', '融合设定'], ['body', '身形比例'], ['extra', '扩展设定']] as const).map(([id, title]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</button>)}</div>
    {tab === 'fusion' && <>{(['source', 'concept'] as Dimension[]).map(basePicker)}{['primaryPersonality', 'mechanismPrinciple', 'mechanismMotion'].map(renderTrait)}<details className={styles.catalogueMore}><summary>独立设置职业、文化、世界与性格</summary>{TRAITS.filter(t => t.group === 'fusion' && !['primaryPersonality', 'mechanismPrinciple', 'mechanismMotion'].includes(t.id)).map(t => renderTrait(t.id))}</details></>}
    {tab === 'body' && <>{primaryBody.map(renderTrait)}<details className={styles.catalogueMore}><summary>更多身形属性</summary>{TRAITS.filter(t => t.group === 'body' && !primaryBody.includes(t.id)).map(t => renderTrait(t.id))}</details><p className={styles.hint}>同一属性以这里的明确选择为准；原有身形选项与固定要求原文保留。</p></>}
    {tab === 'extra' && <>{['narrative', 'allegiance', 'gameRole', 'equipmentPolicy', 'bodyCount'].map(renderTrait)}{(['角色关系与组合', '道具属性', '识别特征'] as const).map((title, i) => <details key={title} className={styles.catalogueMore}><summary>{title}</summary>{(i === 0 ? ['relationship', 'assembly', 'consciousness'] : i === 1 ? ['equipmentUse', 'equipmentReach', 'equipmentStructure'] : ['signatureArea', 'signatureKind']).map(renderTrait)}</details>)}</>}
  </div>;
}
