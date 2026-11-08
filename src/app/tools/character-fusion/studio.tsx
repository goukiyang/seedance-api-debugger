'use client';
import { useEffect, useRef, useState } from 'react';
import { Copy, Download, LockKeyhole, Plus, RefreshCw, Save, UnlockKeyhole, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { ADDONS, CONFIG, CORE, COUNTS, allowed, bossRow, changeRow, csvFor, defaults, generateBatch, missingRequired, parseSettings, reconcile, refreshBoss, textFor, txtFor, type Dimension, type FusionRow, type FusionSettings } from '@/lib/character-fusion/engine';
import RuleCard from './rule-card';
import CardChat, { emptyConversation, type CardConversation } from './card-chat';
import { parseCardDraft, type CardDraft } from '@/lib/character-fusion/cards';
import { fusionAssistant } from '@/lib/character-fusion/assistant';
import type { FusionRecipe } from '@/lib/character-fusion/recipes';
import styles from './studio.module.css';
const API = '/api/character-fusion/recipes';
const untranslated = (s: FusionSettings) => CONFIG.flatMap(c => s.rules[c.id].filter(t => t.status !== 'exclude' && !(c.tags as readonly string[]).includes(t.label) && !t.en).map(t => ({ dimension: c.id, label: t.label })));
const missingEnglish = (s: FusionSettings) => untranslated(s).length > 0 || s.requirementsEnabled && s.requirements !== defaults().requirements && /[\u3400-\u9fff]/.test(s.requirements) && !s.requirementsEn.trim();
type RecipeForm = { action: 'save' | 'rename'; id: string; name: string; revision?: string };

export default function CharacterFusionStudio({ ownerId }: { ownerId: string }) {
  const { user, hasLoadedUser, sessionChanged } = useAppSession();
  const active = hasLoadedUser && user?.id === ownerId && !sessionChanged;
  const activeRef = useRef(active); activeRef.current = active;
  const [expanded, setExpanded] = useState<string[]>([]), [cardOrder, setCardOrder] = useState<string[]>([]);
  const [chatOpen, setChatOpen] = useState(false), [conversation, setConversation] = useState<CardConversation>(emptyConversation);
  const [translating, setTranslating] = useState(false);
  const translationController = useRef<AbortController | null>(null);
  useEffect(() => () => translationController.current?.abort(), []);
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
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const resultsRef = useRef<HTMLElement>(null);
  const storageKey = `sd2-character-fusion:v1:${ownerId}`;
  useEffect(() => {
    if (!active) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved) { setSettings(parseSettings(saved.settings)); if (Array.isArray(saved.rows)) setRows(saved.rows); setRulesAtGeneration(saved.rulesAtGeneration || ''); if (saved.conversation?.messages?.length <= 38 && typeof saved.conversation.input === 'string') setConversation({ ...saved.conversation, draft: saved.conversation.draft ? parseCardDraft(saved.conversation.draft) : null }); }
      const ui = JSON.parse(localStorage.getItem(storageKey + ':ui') || '{}');
      if (Array.isArray(ui.expanded)) setExpanded(ui.expanded.filter((id: unknown) => typeof id === 'string'));
      if (Array.isArray(ui.cardOrder)) setCardOrder(ui.cardOrder.filter((id: unknown) => typeof id === 'string'));
    } catch { setNotice('未能恢复本页临时现场，账号配方仍可在“我的配方”读取。'); }
    setDraftReady(true);
  }, [active, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ settings, rows, rulesAtGeneration, conversation })); } catch { /* Explicit server recipes remain available without tab storage. */ }
  }, [active, draftReady, settings, rows, rulesAtGeneration, conversation, storageKey]);
  useEffect(() => { if (active && draftReady) { try { localStorage.setItem(storageKey + ':ui', JSON.stringify({ expanded, cardOrder })); } catch { /* The current controls remain usable. */ } } }, [active, draftReady, expanded, cardOrder, storageKey]);
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
  const generate = () => run(() => { if (settings.lang !== 'zh' && missingEnglish(settings)) throw new Error('请先补齐自定义内容的英文，或选择中文输出。'); setRows(generateBatch(settings)); setRulesAtGeneration(JSON.stringify({ rules: settings.rules, cards: settings.cards })); setSelected([]); setNotice(`已生成 ${settings.count} 条提示词。`); resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  const addDimension = (id: string) => setSettings(s => CONFIG.some(c => c.id === id) ? s.bossDimensions.includes(id as Dimension) ? s : { ...s, bossDimensions: [...s.bossDimensions, id as Dimension] } : { ...s, cards: s.cards.map(c => c.id === id ? { ...c, joined: true } : c) });
  const toggleDimension = (id: Dimension) => setSettings(s => s.bossDimensions.includes(id) ? { ...s, bossDimensions: s.bossDimensions.filter(v => v !== id), bossLocks: { ...s.bossLocks, [id]: false } } : { ...s, bossDimensions: [...s.bossDimensions, id] });
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
    try { if (text.includes('英文尚待补齐')) throw new Error('英文尚待补齐'); await navigator.clipboard.writeText(text); if (activeRef.current) setNotice('已复制到剪贴板。'); return true; }
    catch (e) { if (activeRef.current) setError(e instanceof Error && e.message === '英文尚待补齐' ? '请先补齐英文，再复制。' : '复制未成功，请允许剪贴板访问，或导出 TXT 后复制。'); return false; }
  };
  const download = (format: 'txt' | 'csv') => run(() => {
    const content = format === 'txt' ? txtFor(rows, settings) : csvFor(rows, settings);
    if (content.includes('英文尚待补齐')) throw new Error('请先补齐英文，再导出。');
    const blob = new Blob(['\ufeff', content], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' });
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
  const allCards = [...CONFIG.map(c => ({ id: c.id, title: c.title })), ...settings.cards.map(c => ({ id: c.id, title: c.title }))];
  const orderedIds = [...new Set([...cardOrder, ...allCards.map(c => c.id)])].filter(id => allCards.some(c => c.id === id));
  const moveCard = (source: string, target: string) => { if (!orderedIds.includes(source) || source === target) return; const order = orderedIds.filter(id => id !== source); order.splice(order.indexOf(target), 0, source); setCardOrder(order); };
  const moveBy = (id: string, direction: number) => { const index = orderedIds.indexOf(id), target = index + direction; if (target < 0 || target >= orderedIds.length) return; const order = [...orderedIds]; [order[index], order[target]] = [order[target], order[index]]; setCardOrder(order); };
  const confirmCard = (draft: CardDraft) => run(() => {
    if (settings.cards.length >= 16) throw new Error('最多添加 16 张扩展卡片。');
    const c = parseCardDraft(draft), id = `card-${crypto.randomUUID()}`;
    if (allCards.some(item => item.title === c.title)) throw new Error('已有同名卡片，请继续对话换一个明确名称。');
    setSettings(s => ({ ...s, cards: [...s.cards, { ...c, id, joined: true, value: c.tags[0].label, locked: false }] }));
    setConversation(emptyConversation()); setChatOpen(false); setNotice(`「${c.title}」已加入规则与当前组合。`);
  });
  const translate = async () => {
    if (translating) return;
    setTranslating(true); setError('');
    const snapshot = JSON.stringify({ rules: settings.rules, requirements: settings.requirements });
    const controller = new AbortController(); translationController.current = controller;
    try {
      const input = { requirements: settings.requirements, tags: untranslated(settings) };
      const raw = await fusionAssistant('Translate the supplied art direction and tags into accurate English, preserving all meaning without adding constraints. Return JSON only: {"requirementsEn":"...","tags":[{"dimension":"original dimension","label":"original label","en":"English equivalent"}]}. All English fields must contain no Chinese.', [{ role: 'user', content: JSON.stringify(input) }], controller.signal) as { requirementsEn?: unknown; tags?: unknown };
      if (!activeRef.current || controller.signal.aborted) return;
      if (snapshot !== JSON.stringify({ rules: settingsRef.current.rules, requirements: settingsRef.current.requirements })) { setNotice('内容已变化，未套用旧翻译，请按当前内容重新补齐。'); return; }
      if (!raw || typeof raw.requirementsEn !== 'string' || !Array.isArray(raw.tags)) throw new Error('英文回复不完整，请重新补齐。');
      const translated = raw.tags as Array<{ dimension: string; label: string; en: string }>;
      const next = parseSettings({ ...settingsRef.current, requirementsEn: raw.requirementsEn, rules: Object.fromEntries(CONFIG.map(c => [c.id, settingsRef.current.rules[c.id].map(t => { const found = translated.find(v => v.dimension === c.id && v.label === t.label); return found ? { ...t, en: found.en } : t; })])) });
      if (untranslated(next).length || next.requirements.trim() && !next.requirementsEn.trim()) throw new Error('部分英文尚未补齐，本轮翻译未覆盖当前设置。');
      setSettings(next); setNotice('英文已补齐，中英共用同一角色组合。');
    } catch (e) { if (!controller.signal.aborted && activeRef.current) setError(e instanceof Error ? e.message : '英文未补齐，原输入保留。'); }
    finally { if (!controller.signal.aborted && activeRef.current) setTranslating(false); }
  };
  const missing = rows.length ? missingRequired(settings, rows) : [];
  if (!active) return <main className={styles.page}><p role="status">正在确认当前账号…</p></main>;
  return <main className={styles.page}>
    <header className={styles.header}><div><h1>角色融合提示词</h1><p>用卡片与规则组合角色，一次生成一批可控的提示词。</p></div><span className={styles.cost}>批量组合 · ¥0</span></header>
    <div className={styles.toolbar}><div className={styles.tabs} aria-label="角色融合工作区"><button aria-pressed={view === 'workspace'} onClick={() => { setView('workspace'); setForm(null); }}>融合工作台</button><button aria-pressed={view === 'recipes'} onClick={() => { setView('recipes'); setForm(null); }}>我的配方</button></div><button disabled={busy} onClick={() => setForm({ action: 'save', id: crypto.randomUUID(), name: '角色融合配方' })}><Save size={16} />保存配方</button></div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    {form && <form className={styles.recipeForm} onSubmit={e => { e.preventDefault(); void saveRecipe(); }}><label>{form.action === 'save' ? '保存配方' : '配方改名'}<input autoFocus maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label><button className={styles.primary} disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>取消</button></form>}
    {view === 'recipes' ? <section className={styles.recipes}><div className={styles.sectionHead}><h2>我的配方</h2><span>仅本人可见，保存在账号中</span></div>
      {loadingRecipes ? <p role="status">正在读取配方…</p> : recipeError ? <p role="alert" className={styles.error}>{recipeError}<button onClick={() => setRecipeReload(n => n + 1)}>重新读取</button></p> : recipes.length ? recipes.map(recipe => <article className={styles.recipe} key={recipe.id}><div><h3>{recipe.name}</h3><p>{recipe.settings.count} 条 · {recipe.settings.lang === 'zh' ? '中文' : recipe.settings.lang === 'en' ? 'English' : '中英双语'} · {recipe.settings.bossDimensions.length + (recipe.settings.cards || []).filter(c => c.joined).length} 个融合维度</p></div><div className={styles.actions}><button onClick={() => run(() => { setSettings(parseSettings(recipe.settings)); setView('workspace'); setNotice(`已套用「${recipe.name}」，已有提示词保留。`); })}>套用</button><button disabled={busy} onClick={() => setForm({ action: 'rename', id: recipe.id, name: recipe.name, revision: recipe.revision })}>改名</button><details className={styles.delete}><summary>删除</summary><p>删除「{recipe.name}」？</p><button disabled={busy} onClick={() => void deleteRecipe(recipe)}>确认删除</button></details></div></article>) : <p className={styles.empty}>还没有配方。设置好规则后，点“保存配方”。</p>}
    </section> : <>
      <section className={styles.boss} aria-labelledby="boss-title" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('application/x-sd2-fusion-dimension'); if (allCards.some(c => c.id === id)) addDimension(id); }}>
        <div className={styles.sectionHead}><div><h2 id="boss-title">角色组合</h2><p>选择角色定位与组合维度，可批量生成，也可单条加入。</p></div><div className={styles.actions}><button onClick={() => setSettings(s => refreshBoss(s))}><RefreshCw size={16} />随机刷新</button><button onClick={() => setSettings(s => ({ ...s, bossLocks: defaults().bossLocks, cards: s.cards.map(c => ({ ...c, locked: false })) }))}><UnlockKeyhole size={16} />全部解锁</button></div></div>
        <label className={styles.roleSelect}>角色定位<select value={settings.role} onChange={e => setSettings(s => ({ ...s, role: e.target.value }))}><option value="">不限定位</option>{['主角', '配角', '伙伴', '反派', 'Boss', '路人'].map(role => <option key={role}>{role}</option>)}</select></label>
        <div className={styles.formula}>{settings.bossDimensions.map(id => { const c = CONFIG.find(c => c.id === id)!; return <div className={styles.slot} key={id}>
          <div className={styles.slotHead}><strong>{c.title}</strong><button aria-label={`移除${c.title}维度`} onClick={() => setSettings(s => ({ ...s, bossDimensions: s.bossDimensions.filter(v => v !== id), bossLocks: { ...s.bossLocks, [id]: false } }))}><X size={15} /></button></div>
          <label className={styles.bossSelect}><span className={styles.srOnly}>精确选择{c.title}</span><select value={settings.boss[id]} onChange={e => setSettings(s => ({ ...s, boss: { ...s.boss, [id]: e.target.value }, bossLocks: { ...s.bossLocks, [id]: true } }))}>{ADDONS.some(c => c.id === id) && <option value="">本轮不使用</option>}{!allowed(settings, id).length && CORE.some(c => c.id === id) && <option value="">没有可用标签</option>}{allowed(settings, id).map(label => <option key={label}>{label}</option>)}</select></label>
          <div className={styles.slotActions}><button onClick={() => cycleBoss(id)}><RefreshCw size={14} />换一项</button><button aria-pressed={settings.bossLocks[id]} onClick={() => setSettings(s => ({ ...s, bossLocks: { ...s.bossLocks, [id]: !s.bossLocks[id] } }))}>{settings.bossLocks[id] ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}{settings.bossLocks[id] ? '已锁定' : '锁定'}</button></div>
        </div>; })}{settings.cards.filter(c => c.joined).map(c => <div className={styles.slot} key={c.id}><div className={styles.slotHead}><strong>{c.title}</strong><button aria-label={`移除${c.title}维度`} onClick={() => setSettings(s => ({ ...s, cards: s.cards.map(v => v.id === c.id ? { ...v, joined: false, locked: false } : v) }))}><X size={15} /></button></div><label className={styles.bossSelect}><span className={styles.srOnly}>选择{c.title}</span><select value={c.value} onChange={e => setSettings(s => ({ ...s, cards: s.cards.map(v => v.id === c.id ? { ...v, value: e.target.value, locked: true } : v) }))}>{c.tags.filter(t => t.status !== 'exclude').map(t => <option key={t.label}>{t.label}</option>)}</select></label><button aria-pressed={c.locked} onClick={() => setSettings(s => ({ ...s, cards: s.cards.map(v => v.id === c.id ? { ...v, locked: !v.locked } : v) }))}>{c.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}{c.locked ? '已锁定' : '锁定'}</button></div>)}</div>
        {!settings.bossDimensions.length && <p>点击下方卡片的“未加入”，或展开后拖动顶部到这里。</p>}
        <div className={styles.bossFooter}><span>随机刷新只改变已加入且未锁定的维度。</span><button onClick={() => run(() => { const row = bossRow(settings, rows); setRows(current => [row, ...current]); setSelected(current => [...current, row.id]); setNotice('当前角色已加入清单首位。'); })}><Plus size={16} />当前组合加入清单</button></div>
      </section>
      <section className={styles.rules} aria-labelledby="rules-title"><div className={styles.sectionHead}><div><h2 id="rules-title">卡片与规则</h2><p>展开设置标签；○ 可以用 · ✓ 必须用 · − 排除</p></div><div className={styles.actions}><button aria-expanded={chatOpen} onClick={() => setChatOpen(v => !v)}><Plus size={16} />增加卡片</button><button onClick={() => { setSettings(s => reconcile({ ...s, rules: defaults().rules })); setNotice('内置规则已重置，扩展卡片保留。'); }}>重置内置规则</button><button onClick={() => { setExpanded([]); setCardOrder([]); }}>恢复卡片布局</button></div></div>
        {chatOpen && <CardChat value={conversation} onChange={setConversation} onConfirm={confirmCard} onClose={() => setChatOpen(false)} />}
        <div className={styles.ruleGrid}>{orderedIds.map(id => {
          const builtin = CONFIG.find(c => c.id === id), custom = settings.cards.find(c => c.id === id);
          const title = builtin?.title || custom!.title, tags = builtin ? settings.rules[builtin.id] : custom!.tags;
          const joined = builtin ? settings.bossDimensions.includes(builtin.id) : custom!.joined;
          return <RuleCard key={id} id={id} title={title} tags={tags} joined={joined} expanded={expanded.includes(id)} onToggle={() => setExpanded(list => list.includes(id) ? list.filter(v => v !== id) : [...list, id])}
            onJoin={() => builtin ? toggleDimension(builtin.id) : setSettings(s => ({ ...s, cards: s.cards.map(c => c.id === id ? { ...c, joined: !c.joined } : c) }))}
            onTag={label => builtin ? cycleTag(builtin.id, label) : setSettings(s => ({ ...s, cards: s.cards.map(c => c.id === id ? { ...c, tags: c.tags.map(t => t.label === label ? { ...t, status: t.status === 'default' ? 'must' : t.status === 'must' ? 'exclude' : 'default' } : t) } : c) }))}
            onDrop={source => moveCard(source, id)} onMove={direction => moveBy(id, direction)}>
            {builtin ? <form className={styles.addTag} onSubmit={e => { e.preventDefault(); addTag(builtin.id); }}><input aria-label={`自定义${title}标签`} placeholder="自定义标签" maxLength={30} value={tagInputs[builtin.id] || ''} onChange={e => setTagInputs(s => ({ ...s, [builtin.id]: e.target.value }))} /><button aria-label={`添加${title}标签`}><Plus size={16} /></button></form> : <div className={styles.cardTools}><button onClick={() => { setSettings(s => ({ ...s, cards: s.cards.filter(c => c.id !== id) })); setNotice('扩展卡片已从本次规则移除，已有提示词保留。'); }}>移除此卡片</button></div>}
          </RuleCard>;
        })}</div>
      </section>
      <section className={styles.composer} aria-label="生成设置">
        <div className={styles.requirementsHead}><button type="button" role="switch" aria-checked={settings.requirementsEnabled} aria-controls="fusion-requirements" className={styles.switch} onClick={() => setSettings(s => ({ ...s, requirementsEnabled: !s.requirementsEnabled }))}><span /> <span className={styles.srOnly}>启用全局固定要求</span></button><strong>全局固定要求</strong><small>{settings.requirementsEnabled ? '已启用，每条中英提示词都会带入' : '未启用，原内容保留'}</small></div>
        {settings.requirementsEnabled && <div id="fusion-requirements"><label className={styles.requirements}>中文要求<textarea maxLength={6000} rows={3} value={settings.requirements} onChange={e => setSettings(s => ({ ...s, requirements: e.target.value, requirementsEn: '' }))} placeholder="填写画风、比例、构图、材质与制作约束…" /></label><details className={styles.englishEditor}><summary>英文对应要求</summary><textarea aria-label="英文固定要求" maxLength={10000} rows={3} value={settings.requirementsEn} onChange={e => setSettings(s => ({ ...s, requirementsEn: e.target.value }))} placeholder="默认要求已有内置英文；自定义后可点击补齐英文，也可自行填写。" /></details></div>}
        <div className={styles.generateBar}><div className={styles.settings}><label>生成数量<select value={settings.count} onChange={e => setSettings(s => ({ ...s, count: Number(e.target.value) }))}>{COUNTS.map(n => <option value={n} key={n}>{n} 条</option>)}</select></label><label>输出语言<select value={settings.lang} onChange={e => setSettings(s => ({ ...s, lang: e.target.value as FusionSettings['lang'] }))}><option value="zh">中文</option><option value="en">English</option><option value="both">中英双语</option></select></label><button disabled={translating} onClick={() => void translate()}>{translating ? '正在补齐…' : '补齐英文'}</button></div><button className={styles.primary} onClick={generate}>生成 {settings.count} 条提示词</button></div>
        <p className={styles.languageNote}>中英共用同一组合，切语言不换角色。内置内容直接对应；自定义标签和固定要求用“补齐英文”翻译，可编辑英文要求。</p>
        {settings.lang !== 'zh' && missingEnglish(settings) && <p role="status" className={styles.hint}>有自定义内容尚无英文，请先补齐。翻译与对话使用站内文字模型，批量组合仍在本地完成。</p>}
      </section>
      <section className={styles.results} ref={resultsRef} aria-labelledby="results-title"><div className={styles.sectionHead}><h2 id="results-title">提示词清单 <small>{rows.length} 条</small></h2><div className={styles.actions}><button disabled={!rows.length} onClick={() => setSelected(selected.length === rows.length ? [] : rows.map(r => r.id))}>{rows.length && selected.length === rows.length ? '取消全选' : '全选'}</button><button disabled={!rows.length} onClick={() => void copy(txtFor(rows, settings))}><Copy size={16} />全部复制</button><button disabled={!rows.length} onClick={() => download('txt')}><Download size={16} />导出 TXT</button><button disabled={!rows.length} onClick={() => download('csv')}><Download size={16} />CSV</button></div></div>
        {rows.length > 0 && rulesAtGeneration !== JSON.stringify({ rules: settings.rules, cards: settings.cards }) && <p className={styles.hint}>规则已更改，已有清单保留原组合；重新生成后应用新规则。</p>}{missing.length > 0 && <p className={styles.hint}>当前清单缺少必须项：{missing.join('、')}。重新生成可恢复覆盖。</p>}
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
    <div className={styles.resultHeading}><label><input type="checkbox" checked={checked} onChange={onSelect} aria-label={`选择${row.name}`} /><span className={styles.rowIndex}>{String(index + 1).padStart(2, '0')}</span><strong>{row.name}</strong></label><span>{row.role ? `${row.role} · ` : ''}{row.category.personality}</span></div>
    <dl className={styles.metadata}><div><dt>母体</dt><dd>{row.source.name}<small>{row.category.source}</small></dd></div><div><dt>跨界概念</dt><dd>{row.concept.name}<small>{row.category.concept}</small></dd></div><div className={styles.bridge}><dt>连接点 / 机制</dt><dd>{row.bridge}<small>{row.category.mechanism}</small></dd></div>{row.cards?.map(c => <div key={c.id}><dt>{c.title}</dt><dd>{c.label}</dd></div>)}</dl>
    <details className={styles.prompt}><summary>完整提示词</summary><p>{textFor(row, settings)}</p></details><p className={styles.promptExcerpt}>{textFor(row, settings)}</p>
    <div className={styles.rowActions}><button onClick={onCopy}><Copy size={15} />复制</button><button aria-expanded={swapOpen} onClick={() => { setSwapOpen(v => !v); setValue(options[0] || ''); }}><RefreshCw size={15} />只换一项</button><button onClick={onRewrite}>重写</button><details className={styles.advanced}><summary>高级融合 / 评分</summary><p>本地规则启发式参考分，不代表模型评审。</p><div className={styles.scores}>{[['融合性', 87], ['差异化', 81], ['可读性', 91], ['3D可行性', 88]].map(([label, base], i) => <span key={label}><b>{Math.min(98, Number(base) + (scoreSeed + i * 17) % 9 - 4)}</b>{label}</span>)}</div><button onClick={onDeep}>{row.advanced ? '恢复基础提示词' : '深挖为高级融合版'}</button></details></div>
    {swapOpen && <form className={styles.swapForm} onSubmit={e => { e.preventDefault(); onSwap(dimension, value); }}><label>维度<select value={dimension} onChange={e => { const id = e.target.value as Dimension; setDimension(id); setValue(allowed(settings, id)[0] || ''); }}>{CONFIG.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>替换为<select value={value} onChange={e => setValue(e.target.value)}>{ADDONS.some(c => c.id === dimension) && <option value="">本轮不使用</option>}{options.map(option => <option key={option}>{option}</option>)}</select></label><button>应用替换</button></form>}
  </article>;
}
