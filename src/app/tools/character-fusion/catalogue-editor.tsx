'use client';
import { useId, useState } from 'react';
import { LockKeyhole, UnlockKeyhole, Plus, X, RefreshCw } from 'lucide-react';
import { CONFIG, allowed, reconcile, type Dimension, type FusionSettings } from '@/lib/character-fusion/engine';
import { TRAITS, concreteOptions, displayGroup, emptyCatalogue, emptyTrait, dynamicPolicy, type TraitState } from '@/lib/character-fusion/catalogue';
import RuleCard from './rule-card';
import ChoicePills from './choice-pills';
import { toggleChoice } from '@/lib/character-fusion/selection';
import type { FusionCategory } from '@/lib/character-fusion/catalogue-model';
import styles from './studio.module.css';

export type CatalogueView = { presentation: 'cards' | 'groups'; expanded: string[]; order: string[] };
export const defaultCatalogueView = (): CatalogueView => ({ presentation: 'cards', expanded: [], order: [] });
export function toggleCategoryLock(settings: FusionSettings, id: Dimension): FusionSettings {
  const catalogue = settings.catalogue || emptyCatalogue(), locked = settings.bossLocks[id] || catalogue.details[id]?.locked || id === 'source' && catalogue.sourceFusion?.enabled && catalogue.sourceFusion.locked;
  const details = { ...catalogue.details }; if (details[id]) details[id] = { ...details[id]!, locked: false };
  return { ...settings, bossLocks: { ...settings.bossLocks, [id]: !locked }, catalogue: { ...catalogue, details, ...(id === 'source' && catalogue.sourceFusion?.enabled ? { sourceFusion: { ...catalogue.sourceFusion, locked: !locked } } : {}) } };
}


export function joinCatalogueCard(settings: FusionSettings, source: string): FusionSettings | null {
  if (!source.startsWith('catalogue-')) return null;
  const id = source.slice('catalogue-'.length);
  if (id === 'source' || id === 'concept') return { ...settings, bossDimensions: Array.from(new Set<Dimension>([...settings.bossDimensions, id])) };
  if (settings.catalogue?.dynamic?.selections[id]) { const catalogue = settings.catalogue, dynamic = catalogue.dynamic!; return { ...settings, catalogue: { ...catalogue, dynamic: { ...dynamic, selections: { ...dynamic.selections, [id]: { ...dynamic.selections[id], enabled: true } } } } }; }
  if (!TRAITS.some(t => t.id === id)) return null;
  const catalogue = settings.catalogue || emptyCatalogue(), value = catalogue.traits[id] || emptyTrait();
  return { ...settings, catalogue: { ...catalogue, traits: { ...catalogue.traits, [id]: { ...value, enabled: true, locked: value.values.length > 0 && value.locked } } } };
}

export default function CatalogueEditor({ settings, onChange, view, onViewChange, initialGroup }: { initialGroup?: 'fusion' | 'body' | 'extra'; settings: FusionSettings; onChange: (next: FusionSettings) => void; view?: CatalogueView; onViewChange?: (next: CatalogueView) => void }) {
  const instanceId = useId();
  const [tab, setTab] = useState<'fusion' | 'body' | 'extra'>(initialGroup || 'fusion');
  const [searches, setSearches] = useState<Record<string, string>>({});
  const [localView, setLocalView] = useState(defaultCatalogueView);
  const ui = view || localView, cards = ui.presentation === 'cards';
  const updateView = (update: Partial<CatalogueView>) => (onViewChange || setLocalView)({ ...ui, ...update });
  const dynamicCategories = (settings.catalogue?.dynamic?.snapshot.categories || []).filter(category => settings.catalogue?.dynamic?.selections[category.id]);
  const extraCategories = dynamicCategories.filter(category => !TRAITS.some(trait => trait.id === category.id) && !['dimension:source', 'dimension:concept'].includes(category.id));
  const cardIds = [...(tab === 'fusion' ? ['catalogue-source', 'catalogue-concept'] : []), ...TRAITS.filter(t => t.group === tab).map(t => `catalogue-${t.id}`), ...extraCategories.filter(category => category.group === tab).map(category => `catalogue-${category.id}`)];
  const orderedIds = Array.from(new Set([...ui.order, ...cardIds])).filter(id => cardIds.includes(id));
  const moveCard = (source: string, target: string) => {
    if (!orderedIds.includes(source) || !orderedIds.includes(target) || source === target) return;
    const next = orderedIds.filter(id => id !== source); next.splice(orderedIds.indexOf(target), 0, source);
    updateView({ order: [...ui.order.filter(id => !cardIds.includes(id)), ...next] });
  };
  const moveBy = (id: string, direction: number) => { const index = orderedIds.indexOf(id), target = index + direction; if (index < 0 || target < 0 || target >= orderedIds.length) return; moveCard(id, orderedIds[target]); };
  const toggleExpanded = (id: string) => updateView({ expanded: ui.expanded.includes(id) ? ui.expanded.filter(value => value !== id) : [...ui.expanded, id] });
  const card = (id: string, props: Omit<React.ComponentProps<typeof RuleCard>, 'id' | 'expanded' | 'onToggle' | 'onDrop' | 'onMove' | 'collapseRules' | 'selection'> & { summary: string }, controls: React.ReactNode) => {
    const { summary, ...rest } = props, detailId = `${instanceId}-${id}`;
    return <RuleCard key={id} {...rest} id={id} controlId={detailId} expanded={ui.expanded.includes(id)} collapseRules onToggle={() => toggleExpanded(id)} onDrop={source => moveCard(source, id)} onMove={direction => moveBy(id, direction)} selection={<button className={styles.catalogueChoice} aria-expanded={ui.expanded.includes(id)} aria-controls={detailId} onClick={() => toggleExpanded(id)}>{summary}</button>}>{controls}</RuleCard>;
  };
  const catalogue = settings.catalogue || emptyCatalogue();
  const toggleBaseLock = (id: Dimension) => onChange(toggleCategoryLock(settings, id));
  const changeTrait = (id: string, update: (state: TraitState) => TraitState) => onChange({ ...settings, catalogue: { ...catalogue, traits: { ...catalogue.traits, [id]: update(catalogue.traits[id] || emptyTrait()) } } });
  const selectTrait = (id: string, label: string) => {
    const definition = TRAITS.find(t => t.id === id)!;
    changeTrait(id, s => {
      const values = toggleChoice(s.locked ? s.values : [], label, definition);
      return { ...s, enabled: values.length > 0, locked: values.length > 0, values, excluded: s.excluded.filter(v => v !== label) };
    });
  };
  const basePicker = (id: Dimension) => {
    const dynamicCategory = dynamicCategories.find(category => category.id === `dimension:${id}`); if (dynamicCategory) return renderDynamic(dynamicCategory);
    const definition = CONFIG.find(c => c.id === id)!, joined = settings.bossDimensions.includes(id);
    const detail = catalogue.details[id], fixed = settings.bossLocks[id] || Boolean(detail?.locked);
    const fusion = catalogue.sourceFusion || emptyTrait();
    const fusionOptions = allowed(settings, 'source').flatMap(group => concreteOptions('source', group)).filter(option => option.zh !== (catalogue.details.source?.locked ? catalogue.details.source.value : undefined));
    const fusionSummary = !fusion.enabled ? '' : fusion.locked ? ` ＋ ${fusion.values.slice(0, 2).join('、')}${fusion.values.length > 2 ? ` +${fusion.values.length - 2}` : ''}` : ' ＋ 随机融合';
    const groups = (fixed ? [settings.boss[id]] : allowed(settings, id)).map(label => ({ label, options: concreteOptions(id, label) })).filter(g => g.options.length);
    const updateGroup = (value: string) => {
      const details = { ...catalogue.details }; delete details[id];
      onChange({ ...settings, boss: { ...settings.boss, [id]: value || settings.boss[id] }, bossLocks: { ...settings.bossLocks, [id]: Boolean(value) }, bossDimensions: Array.from(new Set([...settings.bossDimensions, id])), catalogue: { ...catalogue, details } });
    };
    const controls = (
      <div className={styles.catalogueValues}><div className={styles.pills}><button type="button" aria-pressed={joined && !fixed} onClick={() => updateGroup('')}>随机类别</button>{allowed(settings, id).map(label => <button type="button" key={label} aria-pressed={joined && fixed && settings.boss[id] === label} onClick={() => updateGroup(label)}>{displayGroup(label)}</button>)}</div>
        {groups.length > 0 && <label className={styles.concretePicker}><span>具体{id === 'source' ? '母体' : id === 'concept' ? '主题参考实例' : '设计'}</span><select aria-label={`具体${definition.title}选项`} value={detail?.locked ? detail.value : ''} onChange={e => {
          const value = e.target.value, details = { ...catalogue.details };
          if (!value) { delete details[id]; onChange({ ...settings, catalogue: { ...catalogue, details } }); return; }
          const group = groups.find(g => g.options.some(o => o.zh === value))!;
          onChange({ ...settings, boss: { ...settings.boss, [id]: group.label }, bossLocks: { ...settings.bossLocks, [id]: true }, bossDimensions: Array.from(new Set([...settings.bossDimensions, id])), catalogue: { ...catalogue, details: { ...details, [id]: { value, locked: true } } } });
        }}><option value="">在类别范围内随机</option>{groups.map(g => <optgroup label={displayGroup(g.label)} key={g.label}>{g.options.map(o => <option value={o.zh} key={o.zh}>{displayGroup(o.zh)}</option>)}</optgroup>)}</select>{detail?.locked && <small>已固定具体选项</small>}{id === 'concept' && settings.catalogue?.traits.occupation?.enabled && <small>职业按独立设置；参考实例保留。</small>}</label>}
        {id === 'source' && <details className={styles.catalogueMore}><summary>辅助融合元素 · 可多选{fusion.enabled && ` · ${fusion.locked ? `${fusion.values.length}项` : '随机1–3项'}`}</summary>
          <div className={styles.choiceMeta}><span>主母体保留，所选元素共同融入同一角色</span><button type="button" aria-pressed={fusion.enabled && !fusion.locked} onClick={() => onChange({ ...settings, catalogue: { ...catalogue, sourceFusion: { ...fusion, enabled: true, locked: false, values: [] } } })}>随机1–3项</button><button type="button" onClick={() => onChange({ ...settings, catalogue: { ...catalogue, sourceFusion: { ...fusion, enabled: false } } })}>不加入</button></div>
          <ChoicePills label="辅助融合元素" multi options={fusionOptions.map(option => ({ label: option.zh }))} values={fusion.enabled && fusion.locked ? fusion.values : []} onSelect={label => {
            const values = toggleChoice(fusion.locked ? fusion.values : [], label, { multi: true });
            onChange({ ...settings, catalogue: { ...catalogue, sourceFusion: { ...fusion, values, enabled: values.length > 0, locked: values.length > 0 } } });
          }} />
        </details>}
      </div>
    );
    if (cards) return card(`catalogue-${id}`, {
      title: id === 'source' ? '造型母体' : '主题灵感', tags: settings.rules[id], joined, locked: fixed || Boolean(detail?.locked) || id === 'source' && fusion.enabled && fusion.locked,
      summary: (detail?.locked ? displayGroup(detail.value) : fixed ? `${displayGroup(settings.boss[id])} · 类内随机` : '随机') + (id === 'source' ? fusionSummary : ''),
      onLock: () => toggleBaseLock(id), onJoin: () => onChange({ ...settings, bossDimensions: joined ? settings.bossDimensions.filter(value => value !== id) : [...settings.bossDimensions, id] }),
      onCycle: () => { const pool = allowed(settings, id); if (pool.length) updateGroup(pool[(pool.indexOf(settings.boss[id]) + 1) % pool.length]); },
      onTag: (label, status) => onChange(reconcile({ ...settings, rules: { ...settings.rules, [id]: settings.rules[id].map(tag => tag.label === label ? { ...tag, status } : tag) } })),
    }, controls);
    return <div key={id} className={styles.catalogueRow}>
      <div className={styles.catalogueLabel}><strong>{id === 'source' ? '造型母体' : id === 'concept' ? '主题灵感' : id === 'personality' ? '主性格' : definition.title}</strong><button className={styles.iconButton} title={fixed ? '解锁类别，允许抽卡更换' : '固定当前类别'} aria-label={`${fixed ? '解锁' : '锁定'}${definition.title}类别`} aria-pressed={fixed} onClick={() => toggleBaseLock(id)}>{fixed ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button><small>{joined ? fixed ? '类别固定' : '类别随机' : '未启用'}</small>{id === 'mechanism' && <button className={styles.iconButton} aria-label={joined ? '移出机制' : '加入机制'} onClick={() => onChange({ ...settings, bossDimensions: joined ? settings.bossDimensions.filter(v => v !== id) : [...settings.bossDimensions, id] })}>{joined ? <X size={15} /> : <Plus size={15} />}</button>}</div>
      {controls}
    </div>;
  };
  const renderDynamic = (category: FusionCategory) => {
    const dynamic = catalogue.dynamic!, value = dynamic.selections[category.id];
    const terms = dynamic.snapshot.terms.filter(term => term.categoryId === category.id);
    const scopeLabels = { private: '本人', shared: '共享', builtin: '内置' };
    const nameCounts = new Map<string, number>();
    for (const term of terms) nameCounts.set(term.nameZh, (nameCounts.get(term.nameZh) || 0) + 1);
    const scopedLabels = new Map(terms.map(term => [term.id, nameCounts.get(term.nameZh)! > 1 ? `${term.nameZh} · ${scopeLabels[term.scope]}` : term.nameZh]));
    const labelCounts = new Map<string, number>();
    for (const name of Array.from(scopedLabels.values())) labelCounts.set(name, (labelCounts.get(name) || 0) + 1);
    const labelsById = new Map(terms.map(term => { const name = scopedLabels.get(term.id)!; return [term.id, labelCounts.get(name)! > 1 ? `${name} · ${term.id.slice(-8)}` : name]; }));
    const termsByLabel = new Map(terms.map(term => [labelsById.get(term.id)!, term]));
    const eligible = terms.filter(term => term.enabled && category.enabled && !value.excluded.includes(term.id));
    const query = (searches[category.id] || '').trim().toLocaleLowerCase();
    const matches = eligible.filter(term => !query || [term.nameZh, term.nameEn, ...term.aliases, ...term.tags].some(text => text.toLocaleLowerCase().includes(query)));
    const change = (next: typeof value) => onChange({ ...settings, catalogue: { ...catalogue, dynamic: { ...dynamic, selections: { ...dynamic.selections, [category.id]: next } } } });
    const label = (id: string) => labelsById.get(id) || `不可用词条 ${id}`;
    const summary = value.locked ? value.values.map(label).join('、') || '尚未选择' : `随机${category.randomMax === 1 ? '1项' : `1–${category.randomMax}项`}`;
    const controls = <div className={styles.catalogueValues}>
      {!category.enabled && <p className={styles.error}>此类别已停用，原选择保留。请移出或在词库中恢复后再生成。</p>}
      <div className={styles.choiceMeta}><span>{category.multi ? '多选组合共同生效' : '单选'} · {eligible.length} 个可用词条</span><button type="button" onClick={() => change({ ...value, enabled: true, locked: false })}><RefreshCw size={13} />随机</button></div>
      <input aria-label={`搜索${category.nameZh}词条`} placeholder="搜索名称、别名或标签" value={searches[category.id] || ''} onChange={event => setSearches(current => ({ ...current, [category.id]: event.target.value }))} />
      <ChoicePills label={category.nameZh} multi={category.multi} options={matches.map(term => ({ label: label(term.id) }))} values={value.locked ? value.values.map(label) : []} onSelect={name => {
        const term = termsByLabel.get(name)!;
        const values = toggleChoice(value.locked ? value.values : [], term.id, dynamicPolicy(category, terms));
        change({ ...value, enabled: values.length > 0, locked: values.length > 0, values, excluded: value.excluded.filter(id => id !== term.id) });
      }} />
      {!matches.length && <p className={styles.hint}>{query ? '没有匹配词条，原选择保留。' : '当前没有可用词条，请调整排除规则或移出此类别。'}</p>}
      {value.values.filter(id => !eligible.some(term => term.id === id)).length > 0 && <p className={styles.error}>原选择含停用或排除词条：{value.values.filter(id => !eligible.some(term => term.id === id)).map(label).join('、')}。未自动替换。</p>}
      <details className={styles.facetRules}><summary>候选池与规则{value.candidates !== undefined ? ` · ${value.candidates.length}项候选` : ''}</summary>
        <label><input type="checkbox" checked={value.candidates !== undefined} onChange={event => { const next = { ...value }; if (event.target.checked) next.candidates = eligible.map(term => term.id); else delete next.candidates; change(next); }} />限定随机候选池</label>
        {value.candidates !== undefined && <div className={styles.pills}>{terms.filter(term => term.enabled).map(term => <label key={term.id} className={styles.choicePill}><input type="checkbox" checked={value.candidates!.includes(term.id)} onChange={event => change({ ...value, candidates: event.target.checked ? [...value.candidates!, term.id] : value.candidates!.filter(id => id !== term.id) })} />{label(term.id)}</label>)}</div>}
        <div className={styles.tags}>{terms.map(term => <label key={term.id}><span className={styles.srOnly}>{label(term.id)}规则</span><select value={value.excluded.includes(term.id) ? 'exclude' : value.must.includes(term.id) ? 'must' : 'default'} onChange={event => change({ ...value, excluded: [...value.excluded.filter(id => id !== term.id), ...(event.target.value === 'exclude' ? [term.id] : [])], must: [...value.must.filter(id => id !== term.id), ...(event.target.value === 'must' ? [term.id] : [])] })}><option value="default">{label(term.id)} · 可用</option><option value="must">{label(term.id)} · 本批必出</option><option value="exclude">{label(term.id)} · 排除</option></select></label>)}</div>
      </details>
    </div>;
    const tags = terms.map(term => ({ label: label(term.id), en: term.nameEn, status: value.excluded.includes(term.id) ? 'exclude' as const : value.must.includes(term.id) ? 'must' as const : 'default' as const }));
    if (cards) return card(`catalogue-${category.id}`, { title: category.nameZh, tags, joined: value.enabled, locked: value.locked, lockDisabled: !value.values.length, summary, onLock: () => change({ ...value, locked: !value.locked }), onJoin: () => change({ ...value, enabled: !value.enabled }), onTag: (name, status) => { const id = termsByLabel.get(name)!.id; change({ ...value, excluded: [...value.excluded.filter(item => item !== id), ...(status === 'exclude' ? [id] : [])], must: [...value.must.filter(item => item !== id), ...(status === 'must' ? [id] : [])] }); } }, controls);
    return <div className={styles.catalogueRow} key={category.id}><div className={styles.catalogueLabel}><strong>{category.nameZh}</strong><button className={styles.iconButton} aria-label={`${value.locked ? '解锁' : '锁定'}${category.nameZh}`} aria-pressed={value.locked} disabled={!value.values.length} onClick={() => change({ ...value, locked: !value.locked })}>{value.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button><small>{value.enabled ? summary : '未启用'}</small><button className={styles.iconButton} aria-label={`${value.enabled ? '移出' : '加入'}${category.nameZh}`} onClick={() => change({ ...value, enabled: !value.enabled })}>{value.enabled ? <X size={15} /> : <Plus size={15} />}</button></div>{controls}</div>;
  };
  const renderTrait = (id: string) => {
    const dynamicCategory = dynamicCategories.find(category => category.id === id);
    if (dynamicCategory) return renderDynamic(dynamicCategory);
    const t = TRAITS.find(t => t.id === id)!, s = catalogue.traits[id] || emptyTrait();
    const legacyDimension = id === 'primaryPersonality' ? 'personality' : ['mechanismPrinciple', 'mechanismMotion'].includes(id) ? 'mechanism' : undefined;
    const inherited = !s.enabled && legacyDimension && settings.bossDimensions.includes(legacyDimension);
    const noProps = id.startsWith('equipment') && id !== 'equipmentPolicy' && catalogue.traits.equipmentPolicy?.enabled && catalogue.traits.equipmentPolicy.locked && catalogue.traits.equipmentPolicy.values.includes('无道具');
    const summary = s.locked ? `${s.values.slice(0, 2).join('、')}${s.values.length > 2 ? ` +${s.values.length - 2}` : ''}${t.multi ? ` · ${s.values.length}项` : ''}` : `随机${t.randomMax === 1 ? '1项' : '1–3项'}`;
    const controls = (
      <div className={styles.catalogueValues}>{inherited && legacyDimension && <p className={styles.hint}>原卡片：{settings.bossLocks[legacyDimension] ? settings.boss[legacyDimension] : '按原规则随机'}；在这里选择后覆盖同一属性。</p>}
        <div className={styles.choiceMeta}><span>{t.multi ? '可多选，所选项共同生效' : '单选'}{s.enabled && s.locked ? ` · 已固定${s.values.length}项` : ''}</span><button type="button" disabled={Boolean(noProps)} aria-pressed={s.enabled && !s.locked} onClick={() => changeTrait(id, v => ({ ...v, enabled: true, locked: false, values: [] }))}><RefreshCw size={13} />随机{t.randomMax === 1 ? '1项' : '1–3项'}</button></div>
        {noProps && <p className={styles.hint}>当前明确无道具，这些选择保留但不用于生成。</p>}
        <ChoicePills label={t.title} multi={t.multi} disabled={Boolean(noProps)} options={t.options.filter(o => !s.excluded.includes(o.zh)).map(option => ({ label: option.zh }))} values={s.enabled && s.locked ? s.values : []} onSelect={label => selectTrait(id, label)} />
        {!cards && <details className={styles.facetRules}><summary>规则{s.excluded.length + s.must.length > 0 && ` · ${s.must.length}必出 / ${s.excluded.length}排除`}</summary><div className={styles.tags}>{t.options.map(o => <label key={o.zh}><span className={styles.srOnly}>{t.title}：{o.zh}规则</span><select value={s.excluded.includes(o.zh) ? 'exclude' : s.must.includes(o.zh) ? 'must' : 'default'} onChange={e => changeTrait(id, v => ({ ...v, excluded: [...v.excluded.filter(x => x !== o.zh), ...(e.target.value === 'exclude' ? [o.zh] : [])], must: [...v.must.filter(x => x !== o.zh), ...(e.target.value === 'must' ? [o.zh] : [])] }))}><option value="default">{o.zh} · 可用</option><option value="must">{o.zh} · 本批必出</option><option value="exclude">{o.zh} · 排除</option></select></label>)}</div></details>}
      </div>
    );
    if (cards) return card(`catalogue-${id}`, {
      title: t.title, tags: t.options.map(option => ({ label: option.zh, en: option.en, status: s.excluded.includes(option.zh) ? 'exclude' as const : s.must.includes(option.zh) ? 'must' as const : 'default' as const })),
      joined: s.enabled, locked: s.locked, lockDisabled: !s.values.length,
      summary: noProps ? `${summary} · 无道具时不使用` : summary,
      onLock: () => changeTrait(id, value => ({ ...value, locked: !value.locked })),
      onJoin: () => changeTrait(id, value => ({ ...value, enabled: !value.enabled, locked: value.values.length > 0 && value.locked })),
      onCycle: t.multi ? undefined : () => changeTrait(id, value => { const pool = t.options.filter(option => !value.excluded.includes(option.zh)); if (!pool.length) return value; return { ...value, enabled: true, locked: true, values: [pool[(pool.findIndex(option => option.zh === value.values[0]) + 1) % pool.length].zh] }; }),
      onTag: (label, status) => changeTrait(id, value => ({ ...value, excluded: [...value.excluded.filter(option => option !== label), ...(status === 'exclude' ? [label] : [])], must: [...value.must.filter(option => option !== label), ...(status === 'must' ? [label] : [])] })),
    }, controls);
    return <div className={styles.catalogueRow} key={id}>
      <div className={styles.catalogueLabel}><strong>{t.title}</strong><button className={`${styles.iconButton} ${s.locked ? styles.locked : ''}`} aria-label={`${s.locked ? '解锁' : '锁定'}${t.title}`} aria-pressed={s.locked} disabled={!s.enabled || !s.values.length} title="锁定后抽卡保留当前选择" onClick={() => changeTrait(id, v => ({ ...v, locked: !v.locked }))}>{s.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button><small>{s.enabled ? s.locked ? t.multi ? '固定 · 可多选' : '固定' : '随机' : inherited ? '沿用原卡片' : '未单独设置'}</small><button className={`${styles.iconButton} ${styles.catalogueReveal}`} aria-label={s.enabled ? `移出${t.title}` : `加入${t.title}`} title={s.enabled ? '移出，保留选择与规则' : '加入抽卡'} onClick={() => changeTrait(id, v => ({ ...v, enabled: !v.enabled, locked: v.values.length > 0 && v.locked }))}>{s.enabled ? <X size={15} /> : <Plus size={15} />}</button></div>
      {controls}
    </div>;
  };
  const primaryBody = ['headRatio', 'silhouette', 'torsoLength', 'armLength', 'legLength', 'exaggeration'];
  return <div className={`${styles.catalogue} ${cards ? styles.catalogueCardView : ''}`} onDragOver={event => { if (cards) event.preventDefault(); }} onDrop={event => {
    const source = event.dataTransfer.getData('application/x-sd2-fusion-dimension');
    const next = joinCatalogueCard(settings, source); if (!next) return;
    event.preventDefault(); event.stopPropagation(); onChange(next);
  }}>
    <div className={styles.catalogueToolbar}><div className={styles.tabs} aria-label="组合设置分组">{([['fusion', '融合设定'], ['body', '身形比例'], ['extra', '扩展设定']] as const).map(([id, title]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</button>)}</div><div className={styles.presentationToggle} role="group" aria-label="设置呈现方式"><button type="button" aria-pressed={cards} onClick={() => updateView({ presentation: 'cards' })}>卡片</button><button type="button" aria-pressed={!cards} onClick={() => updateView({ presentation: 'groups' })}>分组</button></div></div>
    {cards ? <div className={`${styles.ruleGrid} ${styles.catalogueCardGrid}`}>{orderedIds.map(key => { const id = key.slice('catalogue-'.length); return id === 'source' || id === 'concept' ? basePicker(id) : extraCategories.some(category => category.id === id) ? renderDynamic(extraCategories.find(category => category.id === id)!) : renderTrait(id); })}</div> : <>
    {tab === 'fusion' && <>{(['source', 'concept'] as Dimension[]).map(basePicker)}{['primaryPersonality', 'mechanismPrinciple', 'mechanismMotion'].map(renderTrait)}<details className={styles.catalogueMore}><summary>独立设置职业、文化、世界与性格</summary>{TRAITS.filter(t => t.group === 'fusion' && !['primaryPersonality', 'mechanismPrinciple', 'mechanismMotion'].includes(t.id)).map(t => renderTrait(t.id))}</details></>}
    {tab === 'body' && <>{primaryBody.map(renderTrait)}<details className={styles.catalogueMore}><summary>更多身形属性</summary>{TRAITS.filter(t => t.group === 'body' && !primaryBody.includes(t.id)).map(t => renderTrait(t.id))}</details><p className={styles.hint}>同一属性以这里的明确选择为准；原有身形选项与固定要求原文保留。</p></>}
    {tab === 'extra' && <>{['narrative', 'allegiance', 'gameRole', 'equipmentPolicy', 'bodyCount'].map(renderTrait)}{(['角色关系与组合', '道具属性', '识别特征'] as const).map((title, i) => <details key={title} className={styles.catalogueMore}><summary>{title}</summary>{(i === 0 ? ['relationship', 'assembly', 'consciousness'] : i === 1 ? ['equipmentUse', 'equipmentReach', 'equipmentStructure'] : ['signatureArea', 'signatureKind']).map(renderTrait)}</details>)}</>}
    {extraCategories.filter(category => category.group === tab).map(renderDynamic)}
    </>}
  </div>;
}
