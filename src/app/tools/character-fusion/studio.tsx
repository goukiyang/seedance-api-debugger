'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, LockKeyhole, Plus, RefreshCw, Save, Trash2, Undo2, UnlockKeyhole, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { ADDONS, CONFIG, CORE, COUNTS, allowed, bossRow, changeRow, csvFor, defaults, generateBatch, missingRequired, parseSettings, reconcile, refreshBoss, textFor, txtFor, validateGeneration, type Dimension, type FusionRow, type FusionSettings, type Tag } from '@/lib/character-fusion/engine';
import RuleCard from './rule-card';
import CardChat, { emptyConversation, type CardConversation } from './card-chat';
import { parseCardDraft, type CardDraft } from '@/lib/character-fusion/cards';
import { fusionAssistant } from '@/lib/character-fusion/assistant';
import { usePricingModelAvailability } from '@/lib/pricing/use-model-availability';
import type { FusionRecipe } from '@/lib/character-fusion/recipes';
import styles from './studio.module.css';
const API = '/api/character-fusion/recipes';
const LANGUAGE_LABELS = { zh: '中文', en: '英文', both: '中英双语' };
const untranslated = (s: FusionSettings, rows: FusionRow[] = []) => {
  const tags = CONFIG.filter(c => s.bossDimensions.includes(c.id)).flatMap(c => s.rules[c.id].filter(t => t.status !== 'exclude' && !(c.tags as readonly string[]).includes(t.label) && !t.en).map(t => ({ dimension: c.id, label: t.label })));
  for (const row of rows) for (const c of CONFIG) {
    const label = row.category[c.id];
    if (label && !(c.tags as readonly string[]).includes(label) && !s.rules[c.id].some(t => t.label === label && t.en) && !row.translations?.some(t => t.dimension === c.id && t.label === label && t.en)) tags.push({ dimension: c.id, label });
  }
  return tags.filter((tag, i) => tags.findIndex(t => t.dimension === tag.dimension && t.label === tag.label) === i);
};
const missingEnglish = (s: FusionSettings) => untranslated(s).length > 0 || s.requirementsEnabled && s.requirements !== defaults().requirements && /[\u3400-\u9fff]/.test(s.requirements) && !s.requirementsEn.trim();
type RecipeForm = { action: 'save' | 'rename'; id: string; name: string; revision?: string };
type UndoAction = { label: string; restore: () => void };

export default function CharacterFusionStudio({ ownerId }: { ownerId: string }) {
  const { user, hasLoadedUser, sessionChanged } = useAppSession();
  const active = hasLoadedUser && user?.id === ownerId && !sessionChanged;
  const activeRef = useRef(active); activeRef.current = active;
  const modelAvailability = usePricingModelAvailability();
  const [apiModel, setApiModel] = useState('');
  const [apiModels, setApiModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loadingModels, setLoadingModels] = useState(false), [modelError, setModelError] = useState('');
  const modelController = useRef<AbortController | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]), [cardOrder, setCardOrder] = useState<string[]>([]);
  const [chatOpen, setChatOpen] = useState(false), [conversation, setConversation] = useState<CardConversation>(emptyConversation);
  const [translating, setTranslating] = useState(false);
  const [translationOpen, setTranslationOpen] = useState(false);
  const translationResult = useRef<HTMLDetailsElement>(null);
  const translationController = useRef<AbortController | null>(null);
  useEffect(() => () => translationController.current?.abort(), []);
  const [settings, setSettings] = useState<FusionSettings>(defaults);
  const [rows, setRows] = useState<FusionRow[]>([]);
  const [batchMode, setBatchMode] = useState<'replace' | 'append'>('replace');
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const modelSettings = useRef<HTMLDetailsElement>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
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
  const batchBarRef = useRef<HTMLElement>(null);
  const storageKey = `sd2-character-fusion:v1:${ownerId}`;
  const showResults = () => {
    if (!resultsRef.current) return;
    const bar = batchBarRef.current, offset = bar ? Number.parseFloat(getComputedStyle(bar).top) + bar.getBoundingClientRect().height + 16 : 80;
    window.scrollTo({ top: window.scrollY + resultsRef.current.getBoundingClientRect().top - offset, behavior: 'smooth' });
  };
  const loadModels = useCallback(async (force = false) => {
    if (!activeRef.current) return;
    modelController.current?.abort();
    const controller = new AbortController(); modelController.current = controller;
    setLoadingModels(true); setModelError('');
    try {
      const response = await fetch(`/api/llm/models${force ? '?refresh=1' : ''}`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.models) || typeof data.default !== 'string') throw new Error(data.error || '读取模型列表失败，原选择已保留。');
      if (!controller.signal.aborted && activeRef.current) {
        setApiModels(data.models); setApiModel(current => current || data.default);
        if (force) setNotice(data.models.length ? '模型列表已更新，请选择当前可用型号。' : '模型列表已更新，当前没有可选型号。');
      }
    } catch (e) { if (!controller.signal.aborted && activeRef.current) setModelError(e instanceof Error ? e.message : '模型列表更新失败，原选择已保留。'); }
    finally { if (!controller.signal.aborted && activeRef.current) setLoadingModels(false); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void loadModels();
    const refresh = () => { if (document.visibilityState !== 'hidden') void loadModels(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { modelController.current?.abort(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [active, loadModels]);
  useEffect(() => {
    if (!active) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved) {
        const restored = parseSettings(saved.settings);
        setSettings(restored);
        setTranslationOpen(Boolean(restored.requirementsEn) || Object.values(restored.rules).some(tags => tags.some(tag => tag.en)));
        if (Array.isArray(saved.rows)) { setRows(saved.rows); if (Array.isArray(saved.selected)) setSelected(saved.selected.filter((id: unknown) => typeof id === 'string' && saved.rows.some((row: FusionRow) => row.id === id))); }
        if (saved.batchMode === 'append') setBatchMode('append');
        setRulesAtGeneration(saved.rulesAtGeneration || '');
        if (saved.conversation?.messages?.length <= 38 && typeof saved.conversation.input === 'string') setConversation({ ...saved.conversation, draft: saved.conversation.draft ? parseCardDraft(saved.conversation.draft) : null });
      }
      const ui = JSON.parse(localStorage.getItem(storageKey + ':ui') || '{}');
      if (Array.isArray(ui.expanded)) setExpanded(ui.expanded.filter((id: unknown) => typeof id === 'string'));
      if (Array.isArray(ui.cardOrder)) setCardOrder(ui.cardOrder.filter((id: unknown) => typeof id === 'string'));
      if (typeof ui.apiModel === 'string') setApiModel(ui.apiModel);
    } catch { setNotice('未能恢复本页临时现场，账号配方仍可在“我的配方”读取。'); }
    setDraftReady(true);
  }, [active, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ settings, rows, selected, batchMode, rulesAtGeneration, conversation })); } catch { /* Explicit server recipes remain available without tab storage. */ }
  }, [active, draftReady, settings, rows, selected, batchMode, rulesAtGeneration, conversation, storageKey]);
  useEffect(() => { if (active && draftReady) { try { localStorage.setItem(storageKey + ':ui', JSON.stringify({ expanded, cardOrder, apiModel })); } catch { /* The current controls remain usable. */ } } }, [active, draftReady, expanded, cardOrder, apiModel, storageKey]);
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
  const replaceResults = (next: FusionRow[], label: string, nextSelected = selected, nextRules = rulesAtGeneration) => {
    setUndo({ label, restore: () => { setRows(rows); setSelected(selected); setRulesAtGeneration(rulesAtGeneration); } });
    setRows(next); setSelected(nextSelected); setRulesAtGeneration(nextRules);
  };
  const generate = () => run(() => {
    const generated = generateBatch(settings), kept = batchMode === 'append' ? rows : rows.filter(row => selected.includes(row.id));
    const names = new Set(kept.map(row => row.name));
    for (const row of generated) { const base = row.name; let n = 2; while (names.has(row.name)) row.name = `${base} ${n++}`; names.add(row.name); }
    const currentRules = JSON.stringify({ rules: settings.rules, cards: settings.cards });
    replaceResults([...kept, ...generated], '生成候选', selected.filter(id => kept.some(row => row.id === id)), kept.length && rulesAtGeneration !== currentRules ? rulesAtGeneration : currentRules);
    setNotice(`已生成 ${generated.length} 条${kept.length ? `，保留 ${kept.length} 条` : ''}。`);
    requestAnimationFrame(() => { if (activeRef.current) showResults(); });
  });
  const openModelSettings = () => { if (modelSettings.current) modelSettings.current.open = true; modelSettings.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); document.getElementById('fusion-api-model')?.focus({ preventScroll: true }); };
  const addDimension = (id: string) => setSettings(s => CONFIG.some(c => c.id === id) ? s.bossDimensions.includes(id as Dimension) ? s : { ...s, bossDimensions: [...s.bossDimensions, id as Dimension] } : { ...s, cards: s.cards.map(c => c.id === id ? { ...c, joined: true } : c) });
  const toggleDimension = (id: Dimension) => setSettings(s => s.bossDimensions.includes(id) ? { ...s, bossDimensions: s.bossDimensions.filter(v => v !== id), bossLocks: { ...s.bossLocks, [id]: false } } : { ...s, bossDimensions: [...s.bossDimensions, id] });
  const cycleBoss = (id: Dimension) => {
    const pool = [...(ADDONS.some(c => c.id === id) ? [''] : []), ...allowed(settings, id)];
    if (!pool.length) { setError('这个维度没有可用标签，请先调整规则。'); return; }
    const value = pool[(pool.indexOf(settings.boss[id]) + 1) % pool.length];
    setSettings(s => ({ ...s, boss: { ...s.boss, [id]: value }, bossLocks: { ...s.bossLocks, [id]: true } }));
  };
  const setTagStatus = (id: Dimension, label: string, status: Tag['status']) => setSettings(s => reconcile({ ...s, rules: { ...s.rules, [id]: s.rules[id].map(t => t.label === label ? { ...t, status } : t) } }));
  const setCustomTagStatus = (id: string, label: string, status: Tag['status']) => setSettings(s => ({ ...s, cards: s.cards.map(c => {
    if (c.id !== id) return c;
    const tags = c.tags.map(t => t.label === label ? { ...t, status } : t);
    const valid = tags.some(t => t.label === c.value && t.status !== 'exclude');
    return { ...c, tags, value: valid || c.locked ? c.value : tags.find(t => t.status !== 'exclude')?.label || c.value };
  }) }));
  const addTag = (id: Dimension) => run(() => {
    const label = (tagInputs[id] || '').trim();
    if (!label || label.length > 30) throw new Error('请输入 1–30 字的标签。');
    if (settings.rules[id].some(t => t.label === label)) throw new Error('这个标签已经在规则里。');
    if (settings.rules[id].length >= 80) throw new Error('每栏最多 80 个标签。');
    setSettings(s => ({ ...s, rules: { ...s.rules, [id]: [...s.rules[id], { label, status: 'default' }] } })); setTagInputs(s => ({ ...s, [id]: '' }));
  });
  const copy = async (text: string) => {
    setError('');
    try { if (text.includes('英文尚待补齐')) throw new Error('英文尚待补齐'); await navigator.clipboard.writeText(text); if (activeRef.current) setNotice('已复制' + LANGUAGE_LABELS[settings.lang] + '提示词。'); return true; }
    catch (e) { if (activeRef.current) setError(e instanceof Error && e.message === '英文尚待补齐' ? '请先补齐英文，再复制。' : '复制未成功，请允许剪贴板访问，或导出 TXT 后复制。'); return false; }
  };
  const copyRows = (items: FusionRow[]) => copy(items.map(row => textFor(row, settings)).join('\n\n'));
  const download = (format: 'txt' | 'csv' | 'prompts') => run(() => {
    const content = format === 'prompts' ? rows.map(row => textFor(row, settings)).join('\n\n') : format === 'txt' ? txtFor(rows, settings) : csvFor(rows, settings);
    if (content.includes('英文尚待补齐')) throw new Error('请先补齐英文，再导出。');
    const blob = new Blob(['\ufeff', content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `character-fusion-${settings.lang}${format === 'prompts' ? '-prompts.txt' : `.${format}`}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const sendTo = async (href: string) => {
    const picked = rows.filter(r => selected.includes(r.id));
    if (!picked.length) { setError('请先勾选提示词。'); return; }
    if (await copyRows(picked) && activeRef.current) window.location.assign(href);
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
      setRecipes(current => [data.recipe, ...current.filter(r => r.id !== data.recipe.id)]); setForm(null); setNotice('规则配方已保存到本人账号，结果清单可另行导出。');
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
  const orderedIds = Array.from(new Set([...cardOrder, ...allCards.map(c => c.id)])).filter(id => allCards.some(c => c.id === id));
  const moveCard = (source: string, target: string) => { if (!orderedIds.includes(source) || source === target) return; const order = orderedIds.filter(id => id !== source); order.splice(order.indexOf(target), 0, source); setCardOrder(order); };
  const moveBy = (id: string, direction: number) => { const index = orderedIds.indexOf(id), target = index + direction; if (target < 0 || target >= orderedIds.length) return; const order = [...orderedIds]; [order[index], order[target]] = [order[target], order[index]]; setCardOrder(order); };
  const confirmCard = (draft: CardDraft) => run(() => {
    if (settings.cards.length >= 16) throw new Error('最多添加 16 张扩展卡片。');
    const c = parseCardDraft(draft), id = `card-${crypto.randomUUID()}`;
    if (allCards.some(item => item.title === c.title)) throw new Error('已有同名卡片，请继续对话换一个明确名称。');
    setSettings(s => ({ ...s, cards: [...s.cards, { ...c, id, joined: true, value: c.tags[0].label, locked: false }] }));
    setUndo({ label: '新增卡片', restore: () => setSettings(current => ({ ...current, cards: current.cards.filter(card => card.id !== id) })) });
    setConversation(emptyConversation()); setChatOpen(false); setNotice(`「${c.title}」已加入规则与当前组合。`);
  });
  const translate = async () => {
    if (translating) return;
    if (!modelReady) { openModelSettings(); setError('选择 API 模型后即可补齐英文，当前内容保留。'); return; }
    setTranslating(true); setError('');
    const snapshot = JSON.stringify({ rules: settings.rules, requirements: settings.requirements, requirementsEn: settings.requirementsEn, requirementsEnabled: settings.requirementsEnabled });
    const controller = new AbortController(); translationController.current = controller;
    try {
      const input = { requirements: settings.requirementsEnabled ? settings.requirements : '', tags: untranslated(settings, rows) };
      const raw = await fusionAssistant('Translate the supplied art direction and tags into accurate English, preserving all meaning without adding constraints. Return JSON only: {"requirementsEn":"...","tags":[{"dimension":"original dimension","label":"original label","en":"English equivalent"}]}. All English fields must contain no Chinese.', [{ role: 'user', content: JSON.stringify(input) }], controller.signal, apiModel) as { requirementsEn?: unknown; tags?: unknown };
      if (!activeRef.current || controller.signal.aborted) return;
      if (snapshot !== JSON.stringify({ rules: settingsRef.current.rules, requirements: settingsRef.current.requirements, requirementsEn: settingsRef.current.requirementsEn, requirementsEnabled: settingsRef.current.requirementsEnabled })) { setNotice('内容已变化，未套用旧翻译，请按当前内容重新补齐。'); return; }
      if (!raw || typeof raw.requirementsEn !== 'string' || !Array.isArray(raw.tags)) throw new Error('英文回复不完整，请重新补齐。');
      const translated = raw.tags as Array<{ dimension: string; label: string; en: string }>;
      if (translated.some(t => !t || typeof t.dimension !== 'string' || typeof t.label !== 'string' || typeof t.en !== 'string' || !t.en.trim() || t.en.length > 180 || /[\u3400-\u9fff]/.test(t.en)) || input.tags.some(tag => !translated.some(t => t.dimension === tag.dimension && t.label === tag.label))) throw new Error('部分标签英文尚未补齐，原内容保留。');
      const next = parseSettings({ ...settingsRef.current, requirementsEn: settingsRef.current.requirementsEnabled ? raw.requirementsEn : settingsRef.current.requirementsEn, rules: Object.fromEntries(CONFIG.map(c => [c.id, settingsRef.current.rules[c.id].map(t => { const found = translated.find(v => v.dimension === c.id && v.label === t.label); return found ? { ...t, en: found.en } : t; })])) });
      if (untranslated(next).length || next.requirementsEnabled && next.requirements.trim() && !next.requirementsEn.trim()) throw new Error('部分英文尚未补齐，本轮翻译未覆盖当前设置。');
      const priorRules = JSON.stringify({ rules: settingsRef.current.rules, cards: settingsRef.current.cards });
      setRulesAtGeneration(current => current === priorRules ? JSON.stringify({ rules: next.rules, cards: next.cards }) : current);
      setRows(current => current.map(row => ({ ...row, translations: CONFIG.flatMap(c => {
        const label = row.category[c.id], translatedTag = translated.find(t => t.dimension === c.id && t.label === label);
        const en = translatedTag?.en.trim() || row.translations?.find(t => t.dimension === c.id && t.label === label)?.en;
        return en ? [{ dimension: c.id, label, en }] : [];
      }) })));
      setSettings(next); setTranslationOpen(true);
      setNotice('英文补齐结果已展开。清单当前预览与复制语言：' + LANGUAGE_LABELS[next.lang] + '。');
      requestAnimationFrame(() => { if (activeRef.current) translationResult.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    } catch (e) { if (!controller.signal.aborted && activeRef.current) setError(e instanceof Error ? e.message : '英文未补齐，原输入保留。'); }
    finally { if (!controller.signal.aborted && activeRef.current) setTranslating(false); }
  };
  const missing = rows.length ? missingRequired(settings, rows) : [];
  const outputLanguage = LANGUAGE_LABELS[settings.lang];
  const translatedTags = [
    ...CONFIG.flatMap(c => settings.rules[c.id].flatMap(tag => tag.en ? [{ dimension: c.title, label: tag.label, en: tag.en }] : [])),
    ...rows.flatMap(row => (row.translations || []).map(tag => ({ dimension: CONFIG.find(c => c.id === tag.dimension)?.title || tag.dimension, label: tag.label, en: tag.en }))),
  ].filter((tag, i, tags) => tags.findIndex(t => t.dimension === tag.dimension && t.label === tag.label) === i);
  const modelOptions = apiModels.filter(model => modelAvailability.isAvailable('text', model.id));
  const modelReady = modelOptions.some(model => model.id === apiModel);
  const picked = rows.filter(row => selected.includes(row.id));
  const generationProblem = validateGeneration(settings);
  const missingCore = CORE.filter(c => !settings.bossDimensions.includes(c.id));
  const manualReady = !missingCore.length && settings.bossDimensions.every(id => allowed(settings, id).includes(settings.boss[id]) || ADDONS.some(c => c.id === id) && settings.boss[id] === '') && settings.cards.filter(c => c.joined).every(c => c.tags.some(t => t.label === c.value && t.status !== 'exclude'));
  const fixedCount = settings.bossDimensions.filter(id => settings.bossLocks[id]).length + settings.cards.filter(c => c.joined && c.locked).length;
  const needsEnglish = missingEnglish(settings) || rows.some(row => textFor(row, { ...settings, lang: 'en' }).includes('英文尚待补齐'));
  const modelStatus = modelError || modelAvailability.reason || (!loadingModels && !modelReady ? '请选择已开放的 API 模型，当前选择和输入已保留。' : '');
  if (!active) return <main className={styles.page}><p role="status">正在确认当前账号…</p></main>;
  return <main className={styles.page}>
    <header className={styles.header}><h1>角色融合提示词</h1></header>
    <div className={styles.toolbar}><div className={styles.tabs} aria-label="角色融合工作区"><button aria-pressed={view === 'workspace'} onClick={() => { setView('workspace'); setForm(null); }}>融合工作台</button><button aria-pressed={view === 'recipes'} onClick={() => { setView('recipes'); setForm(null); }}>我的配方</button></div><button disabled={busy} onClick={() => setForm({ action: 'save', id: crypto.randomUUID(), name: '角色融合配方' })}><Save size={16} />保存规则配方</button></div>
    <details ref={modelSettings} className={styles.pageSettings}><summary>页面设置</summary><div className={styles.modelPicker}><label htmlFor="fusion-api-model">API 模型</label><select id="fusion-api-model" value={modelReady ? apiModel : ''} title={modelReady ? apiModel : undefined} onChange={e => setApiModel(e.target.value)}><option value="" disabled>{loadingModels && !apiModels.length ? '正在读取模型…' : '请选择已开放模型'}</option>{modelOptions.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}</select><button type="button" disabled={loadingModels} aria-busy={loadingModels} onClick={() => { void loadModels(true); void modelAvailability.refresh(); }}><RefreshCw size={15} />{loadingModels ? '更新中…' : '更新'}</button></div><small>用于对话新增卡片和补齐英文，选择后自动记住。</small>{modelStatus && <p role={modelError ? 'alert' : 'status'} className={styles.hint}>{modelStatus}</p>}</details>
    {view === 'recipes' && (error || notice) && <p role={error ? 'alert' : 'status'} className={error ? styles.error : styles.notice}>{error || notice}</p>}
    {form && <form className={styles.recipeForm} onSubmit={e => { e.preventDefault(); void saveRecipe(); }}><label>{form.action === 'save' ? '保存规则配方' : '配方改名'}<input autoFocus maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /><small>保存组合与规则，结果清单请单独导出。</small></label><button className={styles.primary} disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>取消</button></form>}
    {view === 'recipes' ? <section className={styles.recipes}><div className={styles.sectionHead}><h2>我的配方</h2><span>仅本人可见，保存在账号中</span></div>
      {loadingRecipes ? <p role="status">正在读取配方…</p> : recipeError ? <p role="alert" className={styles.error}>{recipeError}<button onClick={() => setRecipeReload(n => n + 1)}>重新读取</button></p> : recipes.length ? recipes.map(recipe => <article className={styles.recipe} key={recipe.id}><div><h3>{recipe.name}</h3><p>{recipe.settings.count} 条 · {recipe.settings.lang === 'zh' ? '中文' : recipe.settings.lang === 'en' ? 'English' : '中英双语'} · {recipe.settings.bossDimensions.length + (recipe.settings.cards || []).filter(c => c.joined).length} 个融合维度</p></div><div className={styles.actions}><button onClick={() => run(() => { setSettings(parseSettings(recipe.settings)); setView('workspace'); setNotice(`已套用「${recipe.name}」，已有提示词保留。`); })}>套用</button><button disabled={busy} onClick={() => setForm({ action: 'rename', id: recipe.id, name: recipe.name, revision: recipe.revision })}>改名</button><details className={styles.delete}><summary>删除</summary><p>删除「{recipe.name}」？</p><button disabled={busy} onClick={() => void deleteRecipe(recipe)}>确认删除</button></details></div></article>) : <p className={styles.empty}>还没有配方。设置好规则后，点“保存规则配方”。</p>}
    </section> : <>
      <section ref={batchBarRef} className={styles.batchBar} aria-label="批量生成">
        <label>生成数量<select aria-label="生成数量" value={settings.count} onChange={e => setSettings(s => ({ ...s, count: Number(e.target.value) }))}>{COUNTS.map(n => <option value={n} key={n}>{n} 条</option>)}</select></label>
        {rows.length > 0 && <label className={styles.batchMode}>生成方式<select aria-label="批量生成方式" value={batchMode} onChange={e => setBatchMode(e.target.value as typeof batchMode)}><option value="replace">保留已选，换一批</option><option value="append">追加到清单</option></select></label>}
        <button className={styles.primary} disabled={Boolean(generationProblem)} aria-describedby={generationProblem ? 'fusion-generation-problem' : undefined} onClick={generate}>生成 {settings.count} 条</button>
        {rows.length > 0 && <button className={styles.quietButton} onClick={showResults}>清单 {rows.length} 条</button>}
        {undo && <button className={styles.quietButton} onClick={() => { undo.restore(); setUndo(null); setError(''); setNotice(`已撤销${undo.label}。`); }}><Undo2 size={15} />撤销{undo.label}</button>}
        <small className={styles.batchSummary}>{fixedCount ? `${fixedCount} 个固定项，其余随机` : '未锁定维度随机'}{picked.length > 0 && batchMode === 'replace' ? ` · 保留已选 ${picked.length} 条` : ''} · 本地组合免费</small>
        {generationProblem && <div id="fusion-generation-problem" role="status" className={styles.batchFeedback}>{generationProblem}{missingCore.length > 0 && <button onClick={() => setSettings(s => ({ ...s, bossDimensions: Array.from(new Set([...s.bossDimensions, ...CORE.map(c => c.id)])) }))}>加入缺少的基础维度</button>}</div>}
        {(error || notice) && <p role={error ? 'alert' : 'status'} className={`${styles.batchFeedback} ${error ? styles.error : styles.notice}`}>{error || notice}</p>}
      </section>
      <section className={styles.boss} aria-labelledby="boss-title" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('application/x-sd2-fusion-dimension'); if (allCards.some(c => c.id === id)) addDimension(id); }}>
        <div className={styles.sectionHead}><div><h2 id="boss-title">当前组合与固定项</h2><p>锁定后每条都用；未锁定项按规则随机。</p></div><details className={styles.utilities} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>组合操作</summary><div><button onClick={() => setSettings(s => refreshBoss(s))}><RefreshCw size={16} />随机刷新</button><button onClick={() => setSettings(s => ({ ...s, bossLocks: defaults().bossLocks, cards: s.cards.map(c => ({ ...c, locked: false })) }))}><UnlockKeyhole size={16} />全部解锁</button></div></details></div>
        <label className={styles.roleSelect}>角色定位<select value={settings.role} onChange={e => setSettings(s => ({ ...s, role: e.target.value }))}><option value="">不限定位</option>{['主角', '配角', '伙伴', '反派', 'Boss', '路人'].map(role => <option key={role}>{role}</option>)}</select></label>
        <div className={styles.formula}>{settings.bossDimensions.map(id => { const c = CONFIG.find(c => c.id === id)!; return <div className={styles.slot} key={id}>
          <div className={styles.slotHead}><strong>{c.title}</strong><button aria-label={`移除${c.title}维度`} onClick={() => setSettings(s => ({ ...s, bossDimensions: s.bossDimensions.filter(v => v !== id), bossLocks: { ...s.bossLocks, [id]: false } }))}><X size={15} /></button></div>
          <label className={styles.bossSelect}><span className={styles.srOnly}>精确选择{c.title}</span><select value={settings.boss[id]} onChange={e => setSettings(s => ({ ...s, boss: { ...s.boss, [id]: e.target.value }, bossLocks: { ...s.bossLocks, [id]: true } }))}>{ADDONS.some(c => c.id === id) && <option value="">本轮不使用</option>}{settings.boss[id] && !allowed(settings, id).includes(settings.boss[id]) && <option value={settings.boss[id]} disabled>{settings.boss[id]}（不可用）</option>}{!allowed(settings, id).length && CORE.some(c => c.id === id) && <option value="">没有可用标签</option>}{allowed(settings, id).map(label => <option key={label}>{label}</option>)}</select></label>
          <div className={styles.slotActions}><button onClick={() => cycleBoss(id)}><RefreshCw size={14} />换一项</button><button aria-pressed={settings.bossLocks[id]} onClick={() => setSettings(s => ({ ...s, bossLocks: { ...s.bossLocks, [id]: !s.bossLocks[id] } }))}>{settings.bossLocks[id] ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}{settings.bossLocks[id] ? '已锁定' : '锁定'}</button></div>
        </div>; })}{settings.cards.filter(c => c.joined).map(c => <div className={styles.slot} key={c.id}><div className={styles.slotHead}><strong>{c.title}</strong><button aria-label={`移除${c.title}维度`} onClick={() => setSettings(s => ({ ...s, cards: s.cards.map(v => v.id === c.id ? { ...v, joined: false, locked: false } : v) }))}><X size={15} /></button></div><label className={styles.bossSelect}><span className={styles.srOnly}>选择{c.title}</span><select value={c.value} onChange={e => setSettings(s => ({ ...s, cards: s.cards.map(v => v.id === c.id ? { ...v, value: e.target.value, locked: true } : v) }))}>{!c.tags.some(t => t.label === c.value && t.status !== 'exclude') && <option value={c.value} disabled>{c.value}（不可用）</option>}{c.tags.filter(t => t.status !== 'exclude').map(t => <option key={t.label}>{t.label}</option>)}</select></label><button aria-pressed={c.locked} onClick={() => setSettings(s => ({ ...s, cards: s.cards.map(v => v.id === c.id ? { ...v, locked: !v.locked } : v) }))}>{c.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}{c.locked ? '已锁定' : '锁定'}</button></div>)}</div>
        {!settings.bossDimensions.length && <p>点击下方卡片的“未加入”，或展开后拖动顶部到这里。</p>}
        <div className={styles.bossFooter}><button disabled={!manualReady} title={manualReady ? undefined : '请先为当前组合选择可用标签，并加入基础维度'} onClick={() => run(() => { const row = bossRow(settings, rows); replaceResults([row, ...rows], '加入当前组合', [...selected, row.id], rows.length ? rulesAtGeneration : JSON.stringify({ rules: settings.rules, cards: settings.cards })); setNotice('当前组合已加入清单首位。'); })}><Plus size={16} />单独加入当前组合</button></div>
      </section>
      <section className={styles.rules} aria-labelledby="rules-title"><div className={styles.sectionHead}><h2 id="rules-title">卡片与规则</h2><div className={styles.actions}><button aria-expanded={chatOpen} onClick={() => setChatOpen(v => !v)}><Plus size={16} />增加卡片</button><details className={styles.utilities} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>规则操作</summary><div><button onClick={() => { const previous = settings; setUndo({ label: '规则重置', restore: () => setSettings(current => ({ ...current, rules: previous.rules, boss: previous.boss, bossLocks: previous.bossLocks })) }); setSettings(s => reconcile({ ...s, rules: defaults().rules })); setNotice('内置规则已重置，扩展卡片保留。'); }}>重置内置规则</button><button onClick={() => { const previousExpanded = expanded, previousOrder = cardOrder; setUndo({ label: '布局重置', restore: () => { setExpanded(previousExpanded); setCardOrder(previousOrder); } }); setExpanded([]); setCardOrder([]); }}>恢复卡片布局</button></div></details></div></div>
        {chatOpen && <CardChat value={conversation} onChange={setConversation} onConfirm={confirmCard} onClose={() => setChatOpen(false)} model={apiModel} modelReady={modelReady} onChooseModel={openModelSettings} />}
        <div className={styles.ruleGrid}>{orderedIds.map(id => {
          const builtin = CONFIG.find(c => c.id === id), custom = settings.cards.find(c => c.id === id);
          const title = builtin?.title || custom!.title, tags = builtin ? settings.rules[builtin.id] : custom!.tags;
          const joined = builtin ? settings.bossDimensions.includes(builtin.id) : custom!.joined;
          return <RuleCard key={id} id={id} title={title} tags={tags} joined={joined} required={CORE.some(c => c.id === id)} expanded={expanded.includes(id)} onToggle={() => setExpanded(list => list.includes(id) ? list.filter(v => v !== id) : [...list, id])}
            onJoin={() => builtin ? toggleDimension(builtin.id) : setSettings(s => ({ ...s, cards: s.cards.map(c => c.id === id ? { ...c, joined: !c.joined } : c) }))}
            onTag={(label, status) => builtin ? setTagStatus(builtin.id, label, status) : setCustomTagStatus(id, label, status)}
            onDrop={source => moveCard(source, id)} onMove={direction => moveBy(id, direction)}>
            {builtin ? <form className={styles.addTag} onSubmit={e => { e.preventDefault(); addTag(builtin.id); }}><input aria-label={`自定义${title}标签`} placeholder="自定义标签" maxLength={30} value={tagInputs[builtin.id] || ''} onChange={e => setTagInputs(s => ({ ...s, [builtin.id]: e.target.value }))} /><button aria-label={`添加${title}标签`}><Plus size={16} /></button></form> : <div className={styles.cardTools}><button onClick={() => { const card = custom!, index = settings.cards.indexOf(card); setUndo({ label: '卡片移除', restore: () => setSettings(current => ({ ...current, cards: [...current.cards.slice(0, index), card, ...current.cards.slice(index)] })) }); setSettings(s => ({ ...s, cards: s.cards.filter(c => c.id !== id) })); setNotice('卡片已移除，已有提示词保留。'); }}>移除此卡片</button></div>}
          </RuleCard>;
        })}</div>
      </section>
      <section className={styles.composer} aria-label="生成设置">
        <div className={styles.requirementsHead}><button type="button" role="switch" aria-checked={settings.requirementsEnabled} aria-controls="fusion-requirements" className={styles.switch} onClick={() => setSettings(s => ({ ...s, requirementsEnabled: !s.requirementsEnabled }))}><span /> <span className={styles.srOnly}>启用全局固定要求</span></button><strong>全局固定要求</strong><small>{settings.requirementsEnabled ? '已启用，每条中英提示词都会带入' : '未启用，原内容保留'}</small></div>
        {settings.requirementsEnabled && <div id="fusion-requirements"><label className={styles.requirements}>中文要求<textarea maxLength={6000} rows={3} value={settings.requirements} onChange={e => setSettings(s => ({ ...s, requirements: e.target.value, requirementsEn: '' }))} placeholder="填写画风、比例、构图、材质与制作约束…" /></label>{rows.length > 0 && <small>改动会应用到当前清单的每条中英提示词。</small>}</div>}
      </section>
      <section className={styles.results} ref={resultsRef} aria-labelledby="results-title">
        <div className={styles.sectionHead}><h2 id="results-title">提示词清单 <small>{rows.length} 条{picked.length > 0 && ` · 已选 ${picked.length} 条`}</small></h2><div className={styles.actions}>
          <label className={styles.outputLanguage}>预览 / 复制<select aria-label="提示词预览与复制语言" value={settings.lang} onChange={e => setSettings(s => ({ ...s, lang: e.target.value as FusionSettings['lang'] }))}><option value="zh">中文</option><option value="en">英文 English</option><option value="both">中英双语</option></select></label>
          {rows.length > 0 && <><button onClick={() => setSelected(picked.length === rows.length ? [] : rows.map(r => r.id))}>{picked.length === rows.length ? '取消全选' : '全选'}</button><button className={styles.primary} onClick={() => void copyRows(picked.length ? picked : rows)}><Copy size={16} />{picked.length ? `复制所选 ${picked.length} 条` : '复制全部'}{outputLanguage}</button></>}
          <details className={styles.utilities} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; setClearConfirm(false); } }}><summary>导出与清单</summary><div>
            {picked.length > 0 && <button onClick={() => void copyRows(rows)}>复制全部 {rows.length} 条{outputLanguage}</button>}
            <button disabled={!rows.length} onClick={() => download('prompts')}><Download size={15} />导出纯{outputLanguage}提示词 TXT</button><button disabled={!rows.length} onClick={() => download('txt')}>导出资料 TXT</button><button disabled={!rows.length} onClick={() => download('csv')}>导出资料 CSV</button>
            <small>资料含中文名称、维度和当前语言提示词。清单仅在本标签页保留，长期保存请导出。</small>
            <button type="button" className={styles.clearButton} disabled={!rows.length} aria-label={clearConfirm ? '确认清除本次提示词清单' : '清除本次提示词清单'} onBlur={() => setClearConfirm(false)} onKeyDown={e => { if (e.key === 'Escape') setClearConfirm(false); }} onClick={e => { if (!clearConfirm) { e.currentTarget.focus(); setClearConfirm(true); return; } run(() => { replaceResults([], '清单清除', [], ''); setClearConfirm(false); setNotice('清单已清除，规则与设置保留。'); }); }}><Trash2 size={15} />{clearConfirm ? `确认清除 ${rows.length} 条` : '清除清单'}</button>
          </div></details>
        </div></div>
        {settings.lang !== 'zh' && needsEnglish && <div className={styles.translationNeeded} role="status"><span>自定义内容尚需英文，中文结果可继续使用。</span><button disabled={translating} onClick={() => void translate()}>{translating ? '正在补齐…' : modelReady ? '补齐英文' : '选择模型补齐'}</button></div>}
        <details ref={translationResult} className={styles.englishEditor} open={translationOpen} onToggle={e => setTranslationOpen(e.currentTarget.open)}>
          <summary>英文设置与译文{(settings.requirementsEn || translatedTags.length > 0) && <small> · 已有译文</small>}</summary>
          <div className={styles.actions}><button disabled={translating} onClick={() => void translate()}>{translating ? '正在补齐…' : modelReady ? '补齐英文' : '选择模型补齐'}</button>{!modelReady && <small>英文补齐需要选择 API 模型。</small>}</div>
          {(settings.requirementsEnabled || settings.requirementsEn) && <label className={styles.requirements}>英文固定要求{!settings.requirementsEnabled && <small>固定要求未启用，不会带入提示词</small>}<textarea lang="en" aria-label="英文固定要求" maxLength={10000} rows={3} value={settings.requirementsEn} onChange={e => setSettings(s => ({ ...s, requirementsEn: e.target.value }))} placeholder="默认要求已有内置英文；自定义要求可补齐英文，也可在此填写。" /></label>}
          {translatedTags.length > 0 && <dl className={styles.translatedTags}>{translatedTags.map(tag => <div key={tag.dimension + ':' + tag.label}><dt>{tag.dimension} · {tag.label}</dt><dd lang="en">{tag.en}</dd></div>)}</dl>}
          {!settings.requirementsEn && !translatedTags.length && <p className={styles.languageNote}>内置内容已有英文，自定义内容补齐后在这里查看。</p>}
          {rows.length > 0 && <button type="button" onClick={() => { setSettings(s => ({ ...s, lang: 'en' })); showResults(); }}>查看英文提示词</button>}
        </details>
        {rows.length > 0 && rulesAtGeneration !== JSON.stringify({ rules: settings.rules, cards: settings.cards }) && <p className={styles.hint}>规则已改，保留的组合不变；新候选使用当前规则。</p>}{missing.length > 0 && <p className={styles.hint}>本批尚未覆盖：{missing.join('、')}。</p>}
        {rows.length ? <><div className={styles.sendBar}><details className={styles.sendMenu}><summary>用于出图 ↗</summary><p>复制所选的{outputLanguage}提示词后打开页面，请粘贴到输入框。不会提交生成。</p><button disabled={!selected.length} onClick={() => void sendTo('/template-studio?type=image')}>复制并打开生图</button><button disabled={!selected.length} onClick={() => void sendTo('/tools/character-lab')}>复制并打开角色参考图</button></details></div><div className={styles.resultList}>{rows.map((row, index) => <ResultRow key={row.id} row={row} index={index} settings={settings} checked={selected.includes(row.id)} onSelect={() => setSelected(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} onCopy={() => void copy(textFor(row, settings))} onRewrite={() => run(() => replaceResults(changeRow(settings, rows, row.id), '随机重组'))} onSwap={(dimension, value) => run(() => replaceResults(changeRow(settings, rows, row.id, { dimension, value }), '单项替换'))} onDeep={() => replaceResults(rows.map(r => r.id === row.id ? { ...r, advanced: !r.advanced } : r), '结构扩写')} />)}</div></> : <div className={styles.empty}><h3>先生成一批候选</h3><p>可直接用默认规则，再挑选和调整。</p></div>}
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
  const previewLanguages: FusionSettings['lang'][] = settings.lang === 'both' ? ['zh', 'en'] : [settings.lang];
  const englishReady = !textFor(row, { ...settings, lang: 'en' }).includes('英文尚待补齐');
  const excludedCount = CONFIG.filter(c => row.category[c.id] && settings.rules[c.id].some(t => t.label === row.category[c.id] && t.status === 'exclude')).length
    + (row.cards || []).filter(c => settings.cards.find(card => card.id === c.id)?.tags.some(t => t.label === c.label && t.status === 'exclude')).length;
  return <article className={`${styles.resultRow} ${checked ? styles.selected : ''}`}>
    <div className={styles.resultHeading}><label><input type="checkbox" checked={checked} onChange={onSelect} aria-label={`选择${row.name}`} /><span className={styles.rowIndex}>{String(index + 1).padStart(2, '0')}</span><strong>{row.name}</strong></label><span>{row.role ? `${row.role} · ` : ''}{row.category.personality}</span></div>
    <dl className={styles.metadata}><div><dt>母体</dt><dd>{row.source.name}</dd></div><div><dt>跨界概念</dt><dd>{row.concept.name}</dd></div><div className={styles.bridge}><dt>连接点 / 机制</dt><dd>{row.bridge}</dd></div>{row.cards?.map(c => <div key={c.id}><dt>{c.title}</dt><dd>{c.label}</dd></div>)}</dl>
    <details className={styles.prompt}><summary>完整{LANGUAGE_LABELS[settings.lang]}提示词</summary><p>{textFor(row, settings)}</p></details><div className={styles.languagePreviews}>{previewLanguages.map(language => <div key={language}><small>{LANGUAGE_LABELS[language]}预览</small><p lang={language === 'en' ? 'en' : 'zh-CN'} className={styles.promptExcerpt}>{textFor(row, { ...settings, lang: language })}</p></div>)}</div>
    <div className={styles.rowActions}><button onClick={onCopy}><Copy size={15} />复制{LANGUAGE_LABELS[settings.lang]}</button><details className={styles.advanced} onToggle={e => { if (!e.currentTarget.open) setSwapOpen(false); }}><summary>调整、检查与扩写</summary>
      <div className={styles.actions}><button aria-expanded={swapOpen} onClick={() => { setSwapOpen(v => !v); setValue(options[0] || ''); }}><RefreshCw size={15} />只换一项</button><button onClick={onRewrite}>随机重组</button><button onClick={onDeep}>{row.advanced ? '恢复基础提示词' : '扩写三阶段结构'}</button></div>
      <dl className={styles.ruleChecks}><div><dt>英文</dt><dd>{englishReady ? '可复制' : '待补齐'}</dd></div><div><dt>当前排除规则</dt><dd>{excludedCount ? `${excludedCount} 项冲突` : '无冲突'}</dd></div><div><dt>扩写状态</dt><dd>{row.advanced ? '收纳 / 启动 / 释放三阶段' : '基础提示词'}</dd></div></dl>
      <p className={styles.dimensionSummary}>{CONFIG.filter(c => row.category[c.id]).map(c => `${c.title}：${row.category[c.id]}`).join(' · ')}</p>
    </details></div>
    {swapOpen && <form className={styles.swapForm} onSubmit={e => { e.preventDefault(); onSwap(dimension, value); }}><label>维度<select value={dimension} onChange={e => { const id = e.target.value as Dimension; setDimension(id); setValue(allowed(settings, id)[0] || ''); }}>{CONFIG.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>替换为<select value={value} onChange={e => setValue(e.target.value)}>{ADDONS.some(c => c.id === dimension) && <option value="">本轮不使用</option>}{options.map(option => <option key={option}>{option}</option>)}</select></label><button>应用替换</button></form>}
  </article>;
}
