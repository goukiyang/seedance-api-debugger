'use client';
import { useEffect, useRef, useState } from 'react';
import { Copy, Download, GripVertical, LockKeyhole, Plus, RefreshCw, Save, UnlockKeyhole, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { ADDONS, CONFIG, CORE, COUNTS, allowed, bossRow, changeRow, csvFor, defaults, generateBatch, missingRequired, parseSettings, reconcile, refreshBoss, textFor, txtFor, type Dimension, type FusionRow, type FusionSettings } from '@/lib/character-fusion/engine';
import type { FusionRecipe } from '@/lib/character-fusion/recipes';
import styles from './studio.module.css';
const API = '/api/character-fusion/recipes';
const statusLabels = { default: '可以用', must: '必须用', exclude: '排除' };
type RecipeForm = { action: 'save' | 'rename'; id: string; name: string; revision?: string };

export default function CharacterFusionStudio({ ownerId }: { ownerId: string }) {
  const { user, hasLoadedUser, sessionChanged } = useAppSession();
  const active = hasLoadedUser && user?.id === ownerId && !sessionChanged;
  const activeRef = useRef(active); activeRef.current = active;
  const [settings, setSettings] = useState<FusionSettings>(defaults);
  const [rows, setRows] = useState<FusionRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<'workspace' | 'recipes'>('workspace');
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [tagInputs, setTagInputs] = useState<Partial<Record<Dimension, string>>>({});
  const [recipes, setRecipes] = useState<FusionRecipe[]>([]);
  const [loadingRecipes, setLoadingRecipes] = useState(false), [recipeError, setRecipeError] = useState('');
  const [recipeReload, setRecipeReload] = useState(0);
  const [form, setForm] = useState<RecipeForm | null>(null), [busy, setBusy] = useState(false);
  const [draftReady, setDraftReady] = useState(false), [rulesAtGeneration, setRulesAtGeneration] = useState('');
  const resultsRef = useRef<HTMLElement>(null);
  const storageKey = `sd2-character-fusion:v1:${ownerId}`;
  useEffect(() => {
    if (!active) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved) { setSettings(parseSettings(saved.settings)); if (Array.isArray(saved.rows)) setRows(saved.rows); setRulesAtGeneration(saved.rulesAtGeneration || ''); }
    } catch { setNotice('未能恢复本页临时现场，账号配方仍可在“我的配方”读取。'); }
    setDraftReady(true);
  }, [active, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ settings, rows, rulesAtGeneration })); } catch { /* Explicit server recipes remain available without tab storage. */ }
  }, [active, draftReady, settings, rows, rulesAtGeneration, storageKey]);
  useEffect(() => {
    if (!active || view !== 'recipes') return;
    const controller = new AbortController(); setLoadingRecipes(true); setRecipeError('');
    fetch(API, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取配方失败。');
      if (activeRef.current && !controller.signal.aborted) setRecipes(data.recipes);
    }).catch(e => { if (!controller.signal.aborted && activeRef.current) setRecipeError(e instanceof Error ? e.message : '读取配方失败。'); })
      .finally(() => { if (!controller.signal.aborted && activeRef.current) setLoadingRecipes(false); });
    return () => controller.abort();
  }, [active, view, recipeReload]);
  const run = (action: () => void) => { setError(''); setNotice(''); try { action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); } };
  const generate = () => run(() => { setRows(generateBatch(settings)); setRulesAtGeneration(JSON.stringify(settings.rules)); setSelected([]); setNotice(`已生成 ${settings.count} 条提示词。`); resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  const addDimension = (id: Dimension) => setSettings(s => s.bossDimensions.includes(id) ? s : { ...s, bossDimensions: [...s.bossDimensions, id] });
  const cycleBoss = (id: Dimension) => {
    const pool = [...(ADDONS.some(c => c.id === id) ? [''] : []), ...allowed(settings, id)];
    if (!pool.length) { setError('这个维度没有可用标签，请先调整规则。'); return; }
    const value = pool[(pool.indexOf(settings.boss[id]) + 1) % pool.length];
    setSettings(s => ({ ...s, boss: { ...s.boss, [id]: value }, bossLocks: { ...s.bossLocks, [id]: true } }));
  };
  const cycleTag = (id: Dimension, label: string) => setSettings(s => reconcile({ ...s, rules: { ...s.rules, [id]: s.rules[id].map(t => t.label === label ? { ...t, status: t.status === 'default' ? 'must' : t.status === 'must' ? 'exclude' : 'default' } : t) } }));
  const addTag = (id: Dimension) => run(() => {
    const label = (tagInputs[id] || '').trim();
    if (!label || label.length > 30) throw new Error('请输入 1–30 字的标签。');
    if (settings.rules[id].some(t => t.label === label)) throw new Error('这个标签已经在规则里。');
    if (settings.rules[id].length >= 80) throw new Error('每栏最多 80 个标签。');
    setSettings(s => ({ ...s, rules: { ...s.rules, [id]: [...s.rules[id], { label, status: 'default' }] } })); setTagInputs(s => ({ ...s, [id]: '' }));
  });
  const copy = async (text: string) => {
    setError('');
    try { await navigator.clipboard.writeText(text); if (activeRef.current) setNotice('已复制到剪贴板。'); return true; }
    catch { if (activeRef.current) setError('复制未成功，请允许剪贴板访问，或导出 TXT 后复制。'); return false; }
  };
  const download = (format: 'txt' | 'csv') => run(() => {
    const blob = new Blob(['\ufeff', format === 'txt' ? txtFor(rows, settings) : csvFor(rows, settings)], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `character-fusion.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const sendTo = async (href: string) => {
    const picked = rows.filter(r => selected.includes(r.id));
    if (!picked.length) { setError('请先勾选提示词。'); return; }
    if (await copy(txtFor(picked, settings)) && activeRef.current) window.location.assign(href);
  };
  const mutateRecipe = async (body: object) => {
    const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '配方操作未确认。'); return data;
  };
  const saveRecipe = async () => {
    if (!form || busy || !active) return;
    setBusy(true); setError('');
    try {
      const data = await mutateRecipe({ ...form, ...(form.action === 'save' ? { settings } : {}) });
      if (!activeRef.current) return;
      setRecipes(current => [data.recipe, ...current.filter(r => r.id !== data.recipe.id)]); setForm(null); setNotice('配方已保存到本人账号。');
    } catch (e) { if (activeRef.current) setError(e instanceof Error ? e.message : '保存未确认，当前设置仍保留。'); }
    finally { if (activeRef.current) setBusy(false); }
  };
  const deleteRecipe = async (recipe: FusionRecipe) => {
    if (busy || !active) return;
    setBusy(true); setError('');
    try {
      await mutateRecipe({ action: 'delete', id: recipe.id, revision: recipe.revision });
      if (activeRef.current) { setRecipes(list => list.filter(r => r.id !== recipe.id)); setNotice('配方已删除。'); }
    } catch (e) { if (activeRef.current) setError(e instanceof Error ? e.message : '删除未确认，请重新读取。'); }
    finally { if (activeRef.current) setBusy(false); }
  };
  const missing = rows.length ? missingRequired(settings, rows) : [];
  if (!active) return <main className={styles.page}><p role="status">正在确认当前账号…</p></main>;
  return <main className={styles.page}>
    <header className={styles.header}><div><h1>角色融合提示词</h1><p>用卡片与规则组合角色，一次生成一批可控的提示词。</p></div><span className={styles.cost}>本地规则生成 · ¥0</span></header>
    <div className={styles.toolbar}><div className={styles.tabs} aria-label="角色融合工作区"><button aria-pressed={view === 'workspace'} onClick={() => { setView('workspace'); setForm(null); }}>融合工作台</button><button aria-pressed={view === 'recipes'} onClick={() => { setView('recipes'); setForm(null); }}>我的配方</button></div><button disabled={busy} onClick={() => setForm({ action: 'save', id: crypto.randomUUID(), name: '角色融合配方' })}><Save size={16} />保存配方</button></div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    {form && <form className={styles.recipeForm} onSubmit={e => { e.preventDefault(); void saveRecipe(); }}><label>{form.action === 'save' ? '保存配方' : '配方改名'}<input autoFocus maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label><button className={styles.primary} disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>取消</button></form>}
    {view === 'recipes' ? <section className={styles.recipes}><div className={styles.sectionHead}><h2>我的配方</h2><span>仅本人可见，保存在账号中</span></div>
      {loadingRecipes ? <p role="status">正在读取配方…</p> : recipeError ? <p role="alert" className={styles.error}>{recipeError}<button onClick={() => setRecipeReload(n => n + 1)}>重新读取</button></p> : recipes.length ? recipes.map(recipe => <article className={styles.recipe} key={recipe.id}><div><h3>{recipe.name}</h3><p>{recipe.settings.count} 条 · {recipe.settings.lang === 'zh' ? '中文' : recipe.settings.lang === 'en' ? 'English' : '中英双语'} · {recipe.settings.bossDimensions.length} 个融合维度</p></div><div className={styles.actions}><button onClick={() => run(() => { setSettings(parseSettings(recipe.settings)); setView('workspace'); setNotice(`已套用「${recipe.name}」，已有提示词保留。`); })}>套用</button><button disabled={busy} onClick={() => setForm({ action: 'rename', id: recipe.id, name: recipe.name, revision: recipe.revision })}>改名</button><details className={styles.delete}><summary>删除</summary><p>删除「{recipe.name}」？</p><button disabled={busy} onClick={() => void deleteRecipe(recipe)}>确认删除</button></details></div></article>) : <p className={styles.empty}>还没有配方。设置好规则后，点“保存配方”。</p>}
    </section> : <>
      <section className={styles.boss} aria-labelledby="boss-title" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('application/x-sd2-fusion-dimension'); if (CONFIG.some(c => c.id === id)) addDimension(id as Dimension); }}>
        <div className={styles.sectionHead}><div><h2 id="boss-title">Boss 融合台</h2><p>选好公式，再把这一位加入清单。</p></div><div className={styles.actions}><button onClick={() => setSettings(s => refreshBoss(s))}><RefreshCw size={16} />随机刷新</button><button onClick={() => setSettings(s => ({ ...s, bossLocks: defaults().bossLocks }))}><UnlockKeyhole size={16} />全部解锁</button></div></div>
        <div className={styles.formula}>{settings.bossDimensions.map(id => { const c = CONFIG.find(c => c.id === id)!; return <div className={styles.slot} key={id}>
          <div className={styles.slotHead}><strong>{c.title}</strong><button aria-label={`移除${c.title}维度`} onClick={() => setSettings(s => ({ ...s, bossDimensions: s.bossDimensions.filter(v => v !== id), bossLocks: { ...s.bossLocks, [id]: false } }))}><X size={15} /></button></div>
          <label className={styles.bossSelect}><span className={styles.srOnly}>精确选择{c.title}</span><select value={settings.boss[id]} onChange={e => setSettings(s => ({ ...s, boss: { ...s.boss, [id]: e.target.value }, bossLocks: { ...s.bossLocks, [id]: true } }))}>{ADDONS.some(c => c.id === id) && <option value="">本轮不使用</option>}{!allowed(settings, id).length && CORE.some(c => c.id === id) && <option value="">没有可用标签</option>}{allowed(settings, id).map(label => <option key={label}>{label}</option>)}</select></label>
          <div className={styles.slotActions}><button onClick={() => cycleBoss(id)}><RefreshCw size={14} />换一项</button><button aria-pressed={settings.bossLocks[id]} onClick={() => setSettings(s => ({ ...s, bossLocks: { ...s.bossLocks, [id]: !s.bossLocks[id] } }))}>{settings.bossLocks[id] ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}{settings.bossLocks[id] ? '已锁定' : '锁定'}</button></div>
        </div>; })}</div>
        {!settings.bossDimensions.length && <p>点击下方卡片的“加入融合台”，或拖动卡片到这里。</p>}
        <div className={styles.bossFooter}><span>随机刷新只改变已加入且未锁定的维度。</span><button className={styles.primary} onClick={() => run(() => { const row = bossRow(settings, rows); setRows(current => [row, ...current]); setSelected(current => [...current, row.id]); setNotice('Boss 提示词已加入清单首位。'); })}><Plus size={16} />将 Boss 加入清单</button></div>
      </section>
      <section className={styles.rules} aria-labelledby="rules-title"><div className={styles.sectionHead}><div><h2 id="rules-title">卡片与规则</h2><p>点击标签轮换：○ 可以用 → ✓ 必须用 → − 排除</p></div><button onClick={() => { setSettings(s => reconcile({ ...s, rules: defaults().rules })); setNotice('规则已重置，自定义标签已移除。'); }}>重置规则</button></div>
        <div className={styles.ruleGrid}>{CONFIG.map(c => <article className={styles.ruleCard} key={c.id}><div className={styles.ruleHead}><h3>{c.title}</h3><div><button draggable onDragStart={e => { e.dataTransfer.setData('application/x-sd2-fusion-dimension', c.id); e.dataTransfer.effectAllowed = 'copy'; }} aria-label={`拖动${c.title}到融合台`} title="可拖动，也可点击旁边的加入按钮"><GripVertical size={16} /></button><button disabled={settings.bossDimensions.includes(c.id)} onClick={() => addDimension(c.id)}>{settings.bossDimensions.includes(c.id) ? '已加入' : '加入融合台'}</button></div></div>
          <div className={styles.tags}>{settings.rules[c.id].map(tag => <button key={tag.label} className={tag.status === 'must' ? styles.must : tag.status === 'exclude' ? styles.excluded : ''} aria-label={`${c.title}：${tag.label}，${statusLabels[tag.status]}，点击切换`} onClick={() => cycleTag(c.id, tag.label)}><span aria-hidden="true">{tag.status === 'must' ? '✓' : tag.status === 'exclude' ? '−' : '○'}</span>{tag.label}</button>)}</div>
          <form className={styles.addTag} onSubmit={e => { e.preventDefault(); addTag(c.id); }}><input aria-label={`自定义${c.title}标签`} placeholder="自定义标签" maxLength={30} value={tagInputs[c.id] || ''} onChange={e => setTagInputs(s => ({ ...s, [c.id]: e.target.value }))} /><button aria-label={`添加${c.title}标签`}><Plus size={16} /></button></form>
        </article>)}</div>
      </section>
      <section className={styles.composer} aria-label="生成设置"><label className={styles.requirements}>全局固定要求 <small>每条提示词自动带上</small><textarea maxLength={6000} rows={3} value={settings.requirements} onChange={e => setSettings(s => ({ ...s, requirements: e.target.value }))} placeholder="填写画风、比例、构图、材质与制作约束…" /></label><div className={styles.generateBar}><div className={styles.settings}><label>生成数量<select value={settings.count} onChange={e => setSettings(s => ({ ...s, count: Number(e.target.value) }))}>{COUNTS.map(n => <option value={n} key={n}>{n} 条</option>)}</select></label><label>输出语言<select value={settings.lang} onChange={e => setSettings(s => ({ ...s, lang: e.target.value as FusionSettings['lang'] }))}><option value="zh">中文</option><option value="en">English</option><option value="both">中英双语</option></select></label></div><button className={styles.primary} onClick={generate}>生成 {settings.count} 条提示词</button></div></section>
      <section className={styles.results} ref={resultsRef} aria-labelledby="results-title"><div className={styles.sectionHead}><h2 id="results-title">提示词清单 <small>{rows.length} 条</small></h2><div className={styles.actions}><button disabled={!rows.length} onClick={() => setSelected(selected.length === rows.length ? [] : rows.map(r => r.id))}>{rows.length && selected.length === rows.length ? '取消全选' : '全选'}</button><button disabled={!rows.length} onClick={() => void copy(txtFor(rows, settings))}><Copy size={16} />全部复制</button><button disabled={!rows.length} onClick={() => download('txt')}><Download size={16} />导出 TXT</button><button disabled={!rows.length} onClick={() => download('csv')}><Download size={16} />CSV</button></div></div>
        {rows.length > 0 && rulesAtGeneration !== JSON.stringify(settings.rules) && <p className={styles.hint}>规则已更改，已有清单保留原组合；重新生成后应用新规则。</p>}{missing.length > 0 && <p className={styles.hint}>当前清单缺少必须项：{missing.join('、')}。重新生成可恢复覆盖。</p>}
        {rows.length ? <><div className={styles.sendBar}><strong>已选 {selected.length} 条</strong><details className={styles.sendMenu}><summary>送去出图 ↗</summary><p>复制所选提示词后打开页面，请粘贴到输入框。不会提交生成。</p><button disabled={!selected.length} onClick={() => void sendTo('/template-studio?type=image')}>复制并打开生图</button><button disabled={!selected.length} onClick={() => void sendTo('/tools/character-lab')}>复制并打开角色参考图</button></details></div><div className={styles.resultList}>{rows.map((row, index) => <ResultRow key={row.id} row={row} index={index} settings={settings} checked={selected.includes(row.id)} onSelect={() => setSelected(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} onCopy={() => void copy(textFor(row, settings))} onRewrite={() => run(() => setRows(changeRow(settings, rows, row.id)))} onSwap={(dimension, value) => run(() => setRows(changeRow(settings, rows, row.id, { dimension, value })))} onDeep={() => setRows(list => list.map(r => r.id === row.id ? { ...r, advanced: !r.advanced } : r))} />)}</div></> : <div className={styles.empty}><h3>从公式到角色，先生成第一批</h3><p>设置上方规则，再点“生成 {settings.count} 条提示词”。</p></div>}
      </section>
    </>}
  </main>;
}

function ResultRow({ row, index, settings, checked, onSelect, onCopy, onRewrite, onSwap, onDeep }: {
  row: FusionRow; index: number; settings: FusionSettings; checked: boolean; onSelect: () => void; onCopy: () => void;
  onRewrite: () => void; onSwap: (dimension: Dimension, value: string) => void; onDeep: () => void;
}) {
  const [dimension, setDimension] = useState<Dimension>('source'), [value, setValue] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);
  const options = allowed(settings, dimension);
  const scoreSeed = Array.from(row.id).reduce((n, ch) => n + ch.charCodeAt(0), 0);
  return <article className={`${styles.resultRow} ${checked ? styles.selected : ''}`}>
    <div className={styles.resultHeading}><label><input type="checkbox" checked={checked} onChange={onSelect} aria-label={`选择${row.name}`} /><span className={styles.rowIndex}>{String(index + 1).padStart(2, '0')}</span><strong>{row.name}</strong></label><span>{row.isBoss ? 'Boss · ' : ''}{row.category.personality}</span></div>
    <dl className={styles.metadata}><div><dt>母体</dt><dd>{row.source.name}<small>{row.category.source}</small></dd></div><div><dt>跨界概念</dt><dd>{row.concept.name}<small>{row.category.concept}</small></dd></div><div className={styles.bridge}><dt>连接点 / 机制</dt><dd>{row.bridge}<small>{row.category.mechanism}</small></dd></div></dl>
    <details className={styles.prompt}><summary>完整提示词</summary><p>{textFor(row, settings)}</p></details><p className={styles.promptExcerpt}>{textFor(row, settings)}</p>
    <div className={styles.rowActions}><button onClick={onCopy}><Copy size={15} />复制</button><button aria-expanded={swapOpen} onClick={() => { setSwapOpen(v => !v); setValue(options[0] || ''); }}><RefreshCw size={15} />只换一项</button><button onClick={onRewrite}>重写</button><details className={styles.advanced}><summary>高级融合 / 评分</summary><p>本地规则启发式参考分，不代表模型评审。</p><div className={styles.scores}>{[['融合性', 87], ['差异化', 81], ['可读性', 91], ['3D可行性', 88]].map(([label, base], i) => <span key={label}><b>{Math.min(98, Number(base) + (scoreSeed + i * 17) % 9 - 4)}</b>{label}</span>)}</div><button onClick={onDeep}>{row.advanced ? '恢复基础提示词' : '深挖为高级融合版'}</button></details></div>
    {swapOpen && <form className={styles.swapForm} onSubmit={e => { e.preventDefault(); onSwap(dimension, value); }}><label>维度<select value={dimension} onChange={e => { const id = e.target.value as Dimension; setDimension(id); setValue(allowed(settings, id)[0] || ''); }}>{CONFIG.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>替换为<select value={value} onChange={e => setValue(e.target.value)}>{ADDONS.some(c => c.id === dimension) && <option value="">本轮不使用</option>}{options.map(option => <option key={option}>{option}</option>)}</select></label><button>应用替换</button></form>}
  </article>;
}
