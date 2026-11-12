'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import type { FusionCatalogue, FusionCategory, FusionTerm } from '@/lib/character-fusion/catalogue-model';
import type { FusionCard } from '@/lib/character-fusion/cards';
import { CONFIG } from '@/lib/character-fusion/engine';
import { TRAITS } from '@/lib/character-fusion/catalogue';
import { CHARACTER_FUSION_WRITES_ENABLED } from '@/lib/character-fusion/build-mode';
import { FusionRequestError, fusionRequest, postFusion, type WorkspaceOperation, type CreationContinuation, type WorkspaceReceipt } from './workspace-client';
import styles from './studio.module.css';

type Entry = { kind: 'category' | 'term'; data: Partial<FusionCategory> | Partial<FusionTerm>; expectedVersion?: string };
type Preview = { version: string; entries: Array<{ index: number; status: 'new' | 'update' | 'duplicate' | 'error'; message?: string; entry?: Entry }>; errors: number; duplicates: number; canImport: boolean };
type MaintenanceOperation = { opId: string; body: Record<string, unknown> };
type ImportOperation = { opId: string; scope: 'private' | 'shared'; entries: Entry[]; previewVersion: string };
type Props = { ownerId: string; admin: boolean; active: boolean; catalogue: FusionCatalogue; cards: FusionCard[]; drafts: unknown[]; continuation?: CreationContinuation; onContinuation: (continuation: CreationContinuation | undefined, reply?: string) => void; onWorkspace: (receipt: Pick<WorkspaceReceipt, 'workspace' | 'rowChanges' | 'rowsPage'>) => void; onPreparePlan: () => Promise<boolean>; onCatalogue: (catalogue: FusionCatalogue) => void; onJoin: (categoryId: string, termId?: string) => void; onOpenCardChat: () => void };
const API = '/api/character-fusion/catalogue';
const blankForm = () => ({ kind: 'term' as 'category' | 'term', id: '', version: '', categoryId: '', nameZh: '', nameEn: '', descriptionZh: '', descriptionEn: '', aliases: '', tags: '', group: 'extra' as FusionCategory['group'], multi: true, semanticGroup: '', shape: '', shapeEn: '', anchor: '', anchorEn: '', root: '', prop: '', propEn: '', mood: '', moodEn: '', suffix: '', bodyTrait: '', bodyZh: '', bodyEn: '', semanticJson: '' });
function csvRows(source: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && source[i + 1] === '\n') i++; row.push(field); if (row.some(value => value.trim())) rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请修正后预览。');
  row.push(field); if (row.some(value => value.trim())) rows.push(row); return rows;
}
function importedEntries(source: string): Entry[] {
  if (source.trim().startsWith('[') || source.trim().startsWith('{')) {
    const parsed = JSON.parse(source.trim());
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.entries)) return parsed.entries;
    return [...(parsed.categories || []).map((data: Partial<FusionCategory>) => ({ kind: 'category', data })), ...(parsed.terms || []).map((data: Partial<FusionTerm>) => ({ kind: 'term', data }))];
  }
  const [header, ...rows] = csvRows(source.replace(/^\uFEFF/, ''));
  if (!header || !header.includes('kind') || !header.includes('nameZh') || !header.includes('nameEn')) throw new Error('CSV 需含 kind、nameZh、nameEn 列；词条还需 categoryId。');
  return rows.map(values => {
    const record = Object.fromEntries(header.map((key, index) => [key.trim(), values[index] || '']));
    const { kind, expectedVersion, ...fields } = record;
    if (kind !== 'category' && kind !== 'term') throw new Error('CSV 的 kind 只能填写 category 或 term。');
    const data = { ...fields, ...(fields.data ? { data: JSON.parse(fields.data) } : {}), aliases: fields.aliases ? fields.aliases.split('|') : [], tags: fields.tags ? fields.tags.split('|') : [], ...(fields.multi ? { multi: fields.multi === 'true' } : {}), ...(fields.randomMax ? { randomMax: Number(fields.randomMax) } : {}) };
    return { kind, data, ...(expectedVersion ? { expectedVersion } : {}) } as Entry;
  });
}
export default function LibraryManager({ ownerId, admin, active, catalogue, cards, drafts, continuation, onContinuation, onWorkspace, onPreparePlan, onCatalogue, onJoin, onOpenCardChat }: Props) {
  const [scope, setScope] = useState<'private' | 'shared'>('private'), [query, setQuery] = useState(''), [categoryId, setCategoryId] = useState('');
  const [results, setResults] = useState<FusionTerm[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [total, setTotal] = useState(0), [loading, setLoading] = useState(false);
  const [form, setForm] = useState(blankForm), [source, setSource] = useState(''), [entries, setEntries] = useState<Entry[]>([]), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [maintenance, setMaintenance] = useState<MaintenanceOperation | null>(null);
  const [pending, setPending] = useState<ImportOperation | null>(null), [reload, setReload] = useState(0);
  const editor = useRef<HTMLDetailsElement>(null);
  const [assistantEntries, setAssistantEntries] = useState<Entry[]>([]), [assistantPreview, setAssistantPreview] = useState<Preview | null>(null), [assistantSubmitted, setAssistantSubmitted] = useState(false);
  const [assistantCanContinue, setAssistantCanContinue] = useState(false);
  const [assistantCatalogueSaved, setAssistantCatalogueSaved] = useState(false), [assistantPairs, setAssistantPairs] = useState<Record<number, [string, string]>>({});
  const alive = useRef(active); alive.current = active;
  useEffect(() => { alive.current = active; return () => { alive.current = false; }; }, [active]);
  const key = `sd2-fusion-library:${ownerId}`;
  useEffect(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (saved) { if (Array.isArray(saved.entries)) setEntries(saved.entries); if (typeof saved.source === 'string') setSource(saved.source); if (saved.form && typeof saved.form.nameZh === 'string') setForm({ ...blankForm(), ...saved.form }); if (saved.scope === 'private' || saved.scope === 'shared' && admin) setScope(saved.scope); if (saved.pending?.opId) setPending(saved.pending); if (saved.maintenance?.opId) setMaintenance(saved.maintenance); } } catch { /* Draft controls remain available. */ }
  }, [key, admin]);
  useEffect(() => { if (active) { try { sessionStorage.setItem(key, JSON.stringify({ entries, source, pending, maintenance, form, scope })); } catch { /* Visible drafts remain available. */ } } }, [active, entries, source, pending, maintenance, form, scope, key]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams({ q: query, categoryId, limit: '100', includeDisabled: '1' });
    fusionRequest<{ catalogue: FusionCatalogue; nextCursor: string | null; total: number }>(`${API}?${params}`, { signal: controller.signal }).then(data => { if (alive.current && !controller.signal.aborted) { setResults(data.catalogue.terms); setNextCursor(data.nextCursor); setTotal(data.total); } }).catch(e => { if (alive.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '词库读取失败。'); }).finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, query, categoryId, reload]);
  const appendPage = async () => {
    if (!nextCursor || loading) return; setLoading(true); setError('');
    try { const params = new URLSearchParams({ q: query, categoryId, cursor: nextCursor, limit: '100', includeDisabled: '1' }); const data = await fusionRequest<{ catalogue: FusionCatalogue; nextCursor: string | null; total: number }>(`${API}?${params}`); if (alive.current) { setResults(current => [...current, ...data.catalogue.terms.filter(term => !current.some(item => item.id === term.id))]); setNextCursor(data.nextCursor); setTotal(data.total); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '下一页读取失败，已显示词条保留。'); }
    finally { if (alive.current) setLoading(false); }
  };
  const refresh = async () => { setLoading(true); setError(''); try { const data = await fusionRequest<{ catalogue: FusionCatalogue }>(API); if (alive.current) { onCatalogue(data.catalogue); setReload(value => value + 1); setNotice('当前目录已更新，已有结果保持原快照。'); } } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '目录更新失败，当前选择保留。'); } finally { if (alive.current) setLoading(false); } };
  const stage = (next: Entry[]) => { if (next.some(entry => !entry || !['category', 'term'].includes(entry.kind) || !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data))) { setError('草稿每项需有类别或词条类型及对应字段，请用模板修正后再预览。'); return; } const normalized = next.map(entry => ({ ...entry, data: { ...entry.data, id: entry.data.id || crypto.randomUUID() } })); setEntries(current => [...current, ...normalized]); setPreview(null); setError(''); setNotice('已加入待入库草稿，请先预览。'); };
  useEffect(() => {
    if (!continuation || !drafts.length) return;
    const savedKey = `${key}:plan:${continuation.sourceOpId}`;
    let restored: { entries?: Entry[]; submitted?: boolean; catalogueSaved?: boolean; pairs?: Record<number, [string, string]> } | null = null;
    try { restored = JSON.parse(sessionStorage.getItem(savedKey) || 'null'); } catch { /* Server plan and original drafts remain available. */ }
    setAssistantEntries(restored?.entries || drafts as Entry[]); setAssistantPairs(restored?.pairs || {}); setAssistantSubmitted(Boolean(restored?.submitted) || continuation.phase === 'awaiting_generation'); setAssistantCatalogueSaved(Boolean(restored?.catalogueSaved) || continuation.phase === 'awaiting_generation'); setAssistantPreview(null); setAssistantCanContinue(false);
  }, [continuation?.sourceOpId, drafts, key]);
  useEffect(() => {
    if (!continuation || !assistantEntries.length) return;
    try { sessionStorage.setItem(`${key}:plan:${continuation.sourceOpId}`, JSON.stringify({ entries: assistantEntries, submitted: assistantSubmitted, catalogueSaved: assistantCatalogueSaved, pairs: assistantPairs })); } catch { /* Editable preview remains on screen. */ }
  }, [continuation, assistantEntries, assistantSubmitted, assistantCatalogueSaved, assistantPairs, key]);
  const editAssistantEntry = (index: number, update: Record<string, unknown>) => { setAssistantEntries(current => current.map((entry, i) => i === index ? { ...entry, data: { ...entry.data, ...update } } : entry)); setAssistantPreview(null); };
  const previewAssistant = async () => {
    if (!continuation || busy || assistantSubmitted) return; setBusy(true); setError('');
    try { const result = await postFusion<{ preview: Preview }>('/api/character-fusion/assistant', { action: 'previewCatalogue', workspaceId: continuation.workspaceId, opId: continuation.sourceOpId, entries: assistantEntries }); if (alive.current) setAssistantPreview(result.preview); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '预览未完成，编辑草稿保留。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const confirmAssistant = async (continuing = false) => {
    if (!continuation || busy || !CHARACTER_FUSION_WRITES_ENABLED || (continuing ? !assistantCanContinue : !assistantPreview?.canImport || assistantSubmitted)) return;
    setBusy(true); setError(''); setAssistantSubmitted(true); setAssistantCanContinue(false);
    try {
      if (!await onPreparePlan()) { if (alive.current) { setAssistantSubmitted(false); setError('当前调整尚未保存，未继续入库或生成。编辑稿已保留。'); } return; }
      const result = await postFusion<Partial<WorkspaceReceipt> & { catalogue?: FusionCatalogue; continuation?: CreationContinuation; catalogueStatus?: string; generationStatus?: string; reply?: string }>('/api/character-fusion/assistant', { action: 'confirmCatalogue', workspaceId: continuation.workspaceId, opId: continuation.sourceOpId, ...(!continuing ? { entries: assistantEntries, previewVersion: assistantPreview?.version } : {}) });
      if (!alive.current) return;
      if (result.catalogue) { onCatalogue(result.catalogue); setReload(value => value + 1); }
      if (result.workspace) onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage });
      setAssistantCatalogueSaved(result.catalogueStatus === 'committed');
      setNotice(result.reply || (result.catalogueStatus === 'committed' ? result.generationStatus === 'committed' ? '词条已入库，原批次已生成。' : result.generationStatus === 'not_requested' ? '词条已入库。' : '词条已入库，生成尚未完成，原计划保留。' : '操作结果仍待核对，原计划与编辑稿保留。'));
      if (result.catalogueStatus === 'committed' && (result.generationStatus === 'committed' || result.generationStatus === 'not_requested')) { try { sessionStorage.removeItem(`${key}:plan:${continuation.sourceOpId}`); } catch { /* Durable receipts are authoritative. */ } onContinuation(undefined); }
      else if (result.continuation) onContinuation(result.continuation);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '入库与生成结果待核对，原计划保留。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const checkAssistant = async () => {
    if (!continuation || busy) return; setBusy(true); setError('');
    try {
      const result = await postFusion<Partial<WorkspaceReceipt> & { catalogue?: FusionCatalogue; catalogueStatus?: string; generationStatus?: string; reply?: string; canContinue?: boolean }>('/api/character-fusion/assistant', { action: 'catalogueStatus', workspaceId: continuation.workspaceId, opId: continuation.sourceOpId });
      if (!alive.current) return;
      setAssistantCatalogueSaved(result.catalogueStatus === 'committed'); setAssistantCanContinue(Boolean(result.canContinue));
      if (result.catalogue) { onCatalogue(result.catalogue); setReload(value => value + 1); }
      if (result.workspace) onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage });
      if (result.catalogueStatus === 'committed' && (result.generationStatus === 'committed' || result.generationStatus === 'not_requested')) { onContinuation(undefined); setNotice(result.reply || '原计划结果已确认。'); }
      else setNotice(result.reply || (result.catalogueStatus === 'committed' ? '词条已入库，生成结果尚未确认。原计划保留。' : '原计划尚未确认，编辑稿保留。'));

    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '原计划暂时无法核对。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const cancelAssistantPlan = async () => {
    if (!continuation || busy) return; setBusy(true); setError('');
    try {
      const result = await postFusion<{ status: string; workspace?: WorkspaceReceipt['workspace']; rowsPage?: WorkspaceReceipt['rowsPage']; rowChanges?: WorkspaceReceipt['rowChanges']; error?: string }>('/api/character-fusion/assistant', { action: 'cancel', workspaceId: continuation.workspaceId, opId: continuation.sourceOpId });
      if (!alive.current) return;
      if (result.workspace) onWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage });
      if (result.status === 'cancelled') { const reply = result.error || (assistantCatalogueSaved ? '后续计划已取消，已入库词条保留。' : '本次计划已取消，未入库或生成。'); onContinuation(undefined, reply); setNotice(reply); }
      else setNotice(result.error || '取消状态仍需核对，原计划保留。');
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '取消状态待核对，原计划保留。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const assistantCategory = (entry: Entry) => catalogue.categories.find(category => category.id === (entry.data as Partial<FusionTerm>).categoryId) || assistantEntries.find(item => item.kind === 'category' && item.data.id === (entry.data as Partial<FusionTerm>).categoryId)?.data as Partial<FusionCategory> | undefined;
  const assistantTerms = (categoryId?: string) => Array.from(new Map([...catalogue.terms, ...assistantEntries.filter(entry => entry.kind === 'term').map(entry => entry.data as FusionTerm)].filter(term => term.categoryId === categoryId).map(term => [term.id, term])).values());
  const editAssistantSemantic = (index: number, update: Partial<NonNullable<FusionTerm['data']>>) => { const entry = assistantEntries[index]; editAssistantEntry(index, { data: { ...(entry.data as Partial<FusionTerm>).data, ...update } }); };
  const assistantRules = (entry: Entry, index: number) => {
    if (entry.kind === 'category') {
      const category = entry.data as Partial<FusionCategory>, terms = assistantTerms(category.id), pair = assistantPairs[index] || ['', ''];
      const name = (id: string) => terms.find(term => term.id === id)?.nameZh || '原词条不可用';
      return <details><summary>互斥规则</summary><fieldset className={styles.assistantRules}><legend>所选词条不能同时出现</legend>{terms.map(term => <label key={term.id}><input type="checkbox" checked={Boolean(category.exclusive?.includes(term.id))} onChange={event => editAssistantEntry(index, { exclusive: event.target.checked ? [...(category.exclusive || []), term.id] : (category.exclusive || []).filter(id => id !== term.id) })} />{term.nameZh}</label>)}{!terms.length && <small>此类别暂无词条，入库后仍可维护规则。</small>}</fieldset><div className={styles.assistantPairs}>{(category.incompatible || []).map(([a, b], pairIndex) => <div key={pairIndex}><span>{name(a)} 与 {name(b)} 不能同时出现</span><button type="button" aria-label={`移除${name(a)}与${name(b)}的互斥规则`} onClick={() => editAssistantEntry(index, { incompatible: category.incompatible!.filter((_, i) => i !== pairIndex) })}>移除</button></div>)}<div>{([0, 1] as const).map(position => <select key={position} aria-label={position === 0 ? '互斥组合的第一个词' : '互斥组合的第二个词'} value={pair[position]} onChange={event => setAssistantPairs(current => ({ ...current, [index]: position === 0 ? [event.target.value, pair[1]] : [pair[0], event.target.value] }))}><option value="">选择词条</option>{terms.map(term => <option key={term.id} value={term.id}>{term.nameZh}</option>)}</select>)}<button type="button" disabled={!pair[0] || !pair[1] || pair[0] === pair[1]} onClick={() => { editAssistantEntry(index, { incompatible: [...(category.incompatible || []), pair] }); setAssistantPairs(current => ({ ...current, [index]: ['', ''] })); }}>加入互斥组合</button></div></div></details>;
    }
    const category = assistantCategory(entry), semantic = (entry.data as Partial<FusionTerm>).data || {};
    if (!category || category.generationKind === 'trait') return null;
    const group = <label>原类别范围<select value={semantic.group || ''} onChange={event => editAssistantSemantic(index, { group: event.target.value })}><option value="">选择范围</option>{CONFIG.find(dimension => dimension.id === category.generationKind)?.tags.map(group => <option key={group}>{group}</option>)}</select></label>;
    return <fieldset className={styles.semanticFields}><legend>生成时采用的具体含义</legend>{category.generationKind !== 'body-card' && group}{category.generationKind === 'source' && ([['shape', '形态描述'], ['shapeEn', '形态英文'], ['anchor', '识别锚点'], ['anchorEn', '锚点英文'], ['root', '命名词根']] as const).map(([field, title]) => <label key={field}>{title}<input value={semantic.source?.[field] || ''} onChange={event => editAssistantSemantic(index, { source: { shape: '', shapeEn: '', anchor: '', anchorEn: '', root: '', ...semantic.source, [field]: event.target.value } })} /></label>)}{category.generationKind === 'concept' && ([['prop', '代表道具'], ['propEn', '道具英文'], ['mood', '情绪与氛围'], ['moodEn', '情绪英文'], ['suffix', '命名后缀']] as const).map(([field, title]) => <label key={field}>{title}<input value={semantic.concept?.[field] || ''} onChange={event => editAssistantSemantic(index, { concept: { prop: '', propEn: '', mood: '', moodEn: '', suffix: '', ...semantic.concept, [field]: event.target.value } })} /></label>)}{category.generationKind === 'body-card' && (semantic.bodyTraits?.length ? semantic.bodyTraits : [{ id: '', zh: '', en: '' }]).map((trait, traitIndex, traits) => <div className={styles.assistantBodyTrait} key={traitIndex}><label>身形属性<select value={trait.id} onChange={event => editAssistantSemantic(index, { bodyTraits: traits.map((value, i) => i === traitIndex ? { ...value, id: event.target.value } : value) })}><option value="">选择属性</option>{TRAITS.filter(trait => trait.group === 'body').map(trait => <option key={trait.id} value={trait.id}>{trait.title}</option>)}</select></label><label>中文描述<input value={trait.zh} onChange={event => editAssistantSemantic(index, { bodyTraits: traits.map((value, i) => i === traitIndex ? { ...value, zh: event.target.value } : value) })} /></label><label>英文描述<input lang="en" value={trait.en} onChange={event => editAssistantSemantic(index, { bodyTraits: traits.map((value, i) => i === traitIndex ? { ...value, en: event.target.value } : value) })} /></label></div>)}</fieldset>;
  };
  const selectedCategory = catalogue.categories.find(category => category.id === form.categoryId);
  const addForm = () => {
    if (!form.nameZh.trim() || !form.nameEn.trim() || !form.descriptionZh.trim() || !form.descriptionEn.trim() || form.kind === 'term' && !form.categoryId) { setError('请补齐中英名称、生成描述和所属类别。'); return; }
    let semantic: FusionTerm['data'];
    try {
      semantic = form.semanticJson.trim() ? JSON.parse(form.semanticJson) : undefined;
      if (selectedCategory?.generationKind === 'source') semantic = { group: form.semanticGroup, source: { shape: form.shape, shapeEn: form.shapeEn, anchor: form.anchor, anchorEn: form.anchorEn, root: form.root } };
      else if (selectedCategory?.generationKind === 'concept') semantic = { group: form.semanticGroup, concept: { prop: form.prop, propEn: form.propEn, mood: form.mood, moodEn: form.moodEn, suffix: form.suffix } };
      else if (selectedCategory?.generationKind === 'body-card' && form.bodyTrait) semantic = { bodyTraits: [{ id: form.bodyTrait, zh: form.bodyZh, en: form.bodyEn }, ...(semantic?.bodyTraits?.slice(1) || [])] };
      else if (selectedCategory && selectedCategory.generationKind !== 'trait' && selectedCategory.generationKind !== 'body-card') semantic = { group: form.semanticGroup };
    } catch { setError('高级语义字段不是有效 JSON，请修正后加入草稿。'); return; }
    const data = { id: form.id || crypto.randomUUID(), nameZh: form.nameZh.trim(), nameEn: form.nameEn.trim(), descriptionZh: form.descriptionZh.trim(), descriptionEn: form.descriptionEn.trim(), aliases: form.aliases.split(/[,，]/).map(item => item.trim()).filter(Boolean), tags: form.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean), ...(form.kind === 'term' ? { categoryId: form.categoryId, ...(semantic ? { data: semantic } : {}) } : { generationKind: 'trait' as const, group: form.group, multi: form.multi, randomMax: form.multi ? 3 : 1 }) };
    stage([{ kind: form.kind, data, ...(form.version ? { expectedVersion: form.version } : {}) }]); setForm(blankForm());
  };
  const collect = (card: FusionCard) => { const id = crypto.randomUUID(); stage([{ kind: 'category', data: { id, nameZh: card.title, nameEn: card.titleEn, descriptionZh: card.title, descriptionEn: card.titleEn, generationKind: 'trait', group: 'extra', multi: Boolean(card.multi), randomMax: card.multi ? 3 : 1 } }, ...card.tags.map(tag => ({ kind: 'term' as const, data: { id: crypto.randomUUID(), categoryId: id, nameZh: tag.label, nameEn: tag.en, descriptionZh: tag.label, descriptionEn: tag.en } }))]); };
  const previewEntries = async () => {
    if (!entries.length || busy) return; setBusy(true); setError('');
    try { const data = await postFusion<{ preview: Preview }>(`${API}/manage`, { action: 'preview', scope, entries }); if (alive.current) setPreview(data.preview); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '预览未完成，草稿保留。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const confirm = async (operation = pending) => {
    if (busy || !CHARACTER_FUSION_WRITES_ENABLED || !active) return;
    const next = operation || (preview?.canImport ? { opId: crypto.randomUUID(), scope, entries, previewVersion: preview.version } : null); if (!next) return;
    setPending(next); setBusy(true); setError('');
    try { const data = await postFusion<{ catalogue: FusionCatalogue; operation: WorkspaceOperation; changedIds: string[] }>(`${API}/manage`, { action: 'import', ...next }); if (!alive.current) return; onCatalogue(data.catalogue); setPending(null); setEntries([]); setPreview(null); setReload(value => value + 1); setNotice(`已确认入库 ${data.changedIds.length} 项，可加入当前卡片。`); }
    catch (e) { if (alive.current) { if (e instanceof FusionRequestError && e.status < 500) setPending(null); setError(e instanceof Error ? e.message : '入库结果待确认，请核对原操作。'); } }
    finally { if (alive.current) setBusy(false); }
  };
  const checkPending = async () => { if (!pending || busy) return; setBusy(true); try { const data = await fusionRequest<{ status: 'committed' | 'unknown' }>(`${API}/manage?opId=${encodeURIComponent(pending.opId)}`); if (!alive.current) return; if (data.status === 'committed') { setPending(null); setEntries([]); setPreview(null); await refresh(); setNotice('原入库操作已确认。'); } else setError('尚未查到原操作回执。可继续核对或按原编号重试，不会另建入库编号。'); } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '原操作暂无法核对。'); } finally { if (alive.current) setBusy(false); } };
  const sendMaintenance = async (operation: MaintenanceOperation) => {
    if (busy || !CHARACTER_FUSION_WRITES_ENABLED) return; setBusy(true); setError(''); setMaintenance(operation);
    try { const data = await postFusion<{ catalogue: FusionCatalogue }>(`${API}/manage`, operation.body); if (alive.current) { setMaintenance(null); onCatalogue(data.catalogue); setReload(value => value + 1); setNotice('目录维护已确认，历史结果不变。'); } }
    catch (e) { if (alive.current) { if (e instanceof FusionRequestError && e.status < 500) setMaintenance(null); setError(e instanceof Error ? e.message : '维护结果待确认，请核对或重试原操作。'); } }
    finally { if (alive.current) setBusy(false); }
  };
  const maintain = (item: FusionCategory | FusionTerm, kind: Entry['kind'], enabled: boolean) => { const opId = crypto.randomUUID(); void sendMaintenance({ opId, body: { action: 'disable', scope: item.scope === 'shared' || item.scope === 'builtin' ? 'shared' : 'private', kind, id: item.id, expectedVersion: item.version, enabled, opId } }); };
  const checkMaintenance = async () => {
    if (!maintenance || busy) return; setBusy(true); setError('');
    try { const result = await fusionRequest<{ status: 'committed' | 'unknown' }>(`${API}/manage?opId=${encodeURIComponent(maintenance.opId)}`); if (!alive.current) return; if (result.status === 'committed') { setMaintenance(null); await refresh(); setNotice('原目录维护已确认。'); } else setError('原操作尚未确认，可继续核对或重试这次操作。'); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '原操作暂时无法核对。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const edit = (item: FusionCategory | FusionTerm, kind: Entry['kind']) => { const data = 'categoryId' in item ? item.data : undefined; setForm({ ...blankForm(), ...item, kind, version: item.version, aliases: item.aliases.join('，'), tags: item.tags.join('，'), categoryId: 'categoryId' in item ? item.categoryId : '', semanticGroup: data?.group || '', ...data?.source, ...data?.concept, bodyTrait: data?.bodyTraits?.[0]?.id || '', bodyZh: data?.bodyTraits?.[0]?.zh || '', bodyEn: data?.bodyTraits?.[0]?.en || '', semanticJson: data ? JSON.stringify(data, null, 2) : '' }); if (editor.current) { editor.current.open = true; editor.current.scrollIntoView({ block: 'start', behavior: 'smooth' }); } setScope(item.scope === 'private' ? 'private' : 'shared'); };
  const template = (): Entry[] => {
    const existingId = categoryId || form.categoryId, id = existingId || crypto.randomUUID();
    return [...(!existingId ? [{ kind: 'category' as const, data: { id, nameZh: '所属阵营', nameEn: 'Faction', descriptionZh: '角色所属阵营', descriptionEn: 'The faction this character belongs to', generationKind: 'trait' as const, group: 'extra' as const, multi: false, randomMax: 1 } }] : []), { kind: 'term', data: { id: crypto.randomUUID(), categoryId: id, nameZh: '探索者', nameEn: 'Explorer', descriptionZh: '热衷探索未知的角色', descriptionEn: 'A character devoted to exploring the unknown' } }];
  };
  const downloadTemplate = (format: 'json' | 'csv') => {
    const sample = template(), headers = ['kind', 'id', 'categoryId', 'nameZh', 'nameEn', 'descriptionZh', 'descriptionEn', 'group', 'multi', 'randomMax'];
    const content = format === 'json' ? JSON.stringify(sample, null, 2) : [headers.join(','), ...sample.map(entry => headers.map(key => { const value = key === 'kind' ? entry.kind : (entry.data as Record<string, unknown>)[key]; return '"' + String(value ?? '').replaceAll('"', '""') + '"'; }).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `角色融合词库模板.${format}`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const canEdit = (item: FusionCategory | FusionTerm) => item.scope === 'private' ? item.ownerId === ownerId : admin;
  return <section className={styles.library} aria-labelledby="fusion-library-title">
    <div className={styles.sectionHead}><div><h2 id="fusion-library-title">词库管理</h2><p>个人内容仅本人可见。入库后可加入当前工作台，已有提示词按原快照保留。</p></div><button disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} />{loading ? '读取中…' : '更新目录'}</button></div>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
    {!CHARACTER_FUSION_WRITES_ENABLED && <p className={styles.hint}>词库当前只读，草稿与已保存目录仍可查看。</p>}
    {continuation && <section className={styles.assistantLibraryPlan} aria-labelledby="fusion-assistant-plan-title"><div className={styles.sectionHead}><h3 id="fusion-assistant-plan-title">{assistantCatalogueSaved ? '词条已入库，原生成计划保留' : '创作对话中的新词草稿'}</h3><small>本人私有</small></div><div className={styles.assistantEntryList}>{assistantEntries.map((entry, index) => <fieldset key={entry.data.id || index} disabled={assistantSubmitted || busy}><legend>{entry.kind === 'category' ? '新类别' : '词条'} · {entry.data.nameZh || index + 1}</legend><div className={styles.libraryForm}><label>中文名称<input value={entry.data.nameZh || ''} onChange={event => editAssistantEntry(index, { nameZh: event.target.value })} /></label><label>英文名称<input lang="en" value={entry.data.nameEn || ''} onChange={event => editAssistantEntry(index, { nameEn: event.target.value })} /></label><label>中文含义<textarea rows={2} value={entry.data.descriptionZh || ''} onChange={event => editAssistantEntry(index, { descriptionZh: event.target.value })} /></label><label>英文含义<textarea rows={2} lang="en" value={entry.data.descriptionEn || ''} onChange={event => editAssistantEntry(index, { descriptionEn: event.target.value })} /></label>{entry.kind === 'term' ? <label>所属类别<select value={(entry.data as Partial<FusionTerm>).categoryId || ''} onChange={event => editAssistantEntry(index, { categoryId: event.target.value })}>{[...catalogue.categories, ...assistantEntries.filter(item => item.kind === 'category').map(item => item.data as FusionCategory)].map(category => <option key={category.id} value={category.id}>{category.nameZh}</option>)}</select></label> : <><label>设置分组<select value={(entry.data as Partial<FusionCategory>).group || 'extra'} onChange={event => editAssistantEntry(index, { group: event.target.value })}><option value="fusion">融合设定</option><option value="body">身形比例</option><option value="extra">扩展设定</option></select></label><label><input type="checkbox" checked={Boolean((entry.data as Partial<FusionCategory>).multi)} onChange={event => editAssistantEntry(index, { multi: event.target.checked, randomMax: event.target.checked ? 3 : 1 })} />多选组合共同生效</label></>}</div>{assistantRules(entry, index)}{assistantPreview?.entries.find(item => item.index === index)?.message && <p className={styles.error}>{assistantPreview.entries.find(item => item.index === index)?.message}</p>}</fieldset>)}</div><div className={styles.actions}>{assistantSubmitted ? <><button disabled={busy} type="button" onClick={() => void checkAssistant()}>核对原计划结果</button>{assistantCanContinue && <button className={styles.primary} disabled={busy || !CHARACTER_FUSION_WRITES_ENABLED} type="button" onClick={() => void confirmAssistant(true)}>继续原计划</button>}</> : <><button disabled={busy || !assistantEntries.length} type="button" onClick={() => void previewAssistant()}>校验并预览</button><button className={styles.primary} disabled={busy || !assistantPreview?.canImport || !CHARACTER_FUSION_WRITES_ENABLED} type="button" onClick={() => void confirmAssistant()}>{busy ? '正在处理…' : continuation.mode === 'generate' ? '确认入库并继续生成' : '确认入库'}</button></>}<button disabled={busy} type="button" onClick={() => void cancelAssistantPlan()}>取消后续计划</button></div>{assistantPreview && !assistantPreview.canImport && <p className={styles.hint}>请修改提示的问题后重新预览。</p>}</section>}
    <div className={styles.librarySearch}><label><Search size={15} /><input aria-label="搜索词库名称、别名、标签" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、别名、标签" /></label><select aria-label="筛选词库类别" value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">全部类别</option>{catalogue.categories.map(category => <option key={category.id} value={category.id}>{category.nameZh}{!category.enabled ? '（已停用）' : ''}</option>)}</select></div>
    <details ref={editor} className={styles.libraryEditor}><summary>新增、导入与助手草稿</summary><div className={styles.libraryScope}><label>入库范围<select value={scope} disabled={!admin || Boolean(pending) || Boolean(maintenance)} onChange={event => { setScope(event.target.value as 'private' | 'shared'); setPreview(null); }}><option value="private">本人私有</option>{admin && <option value="shared">共享给现有授权同事</option>}</select></label>{scope === 'shared' && <small>确认入库后，此批词条会进入共享目录。</small>}</div>
      <form className={styles.libraryForm} onSubmit={event => { event.preventDefault(); addForm(); }}><label>类型<select value={form.kind} onChange={event => setForm({ ...blankForm(), kind: event.target.value as 'category' | 'term' })}><option value="term">词条</option><option value="category">普通描述类别</option></select></label>{form.kind === 'term' ? <label>所属类别<select required value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><option value="">选择类别</option>{catalogue.categories.filter(category => category.enabled).map(category => <option key={category.id} value={category.id}>{category.nameZh}</option>)}</select></label> : <><label>分组<select value={form.group} onChange={event => setForm({ ...form, group: event.target.value as FusionCategory['group'] })}><option value="fusion">融合设定</option><option value="body">身形比例</option><option value="extra">扩展设定</option></select></label><label><input type="checkbox" checked={form.multi} onChange={event => setForm({ ...form, multi: event.target.checked })} />允许多选组合</label></>}
        <label>中文名称<input required maxLength={100} value={form.nameZh} onChange={event => setForm({ ...form, nameZh: event.target.value })} /></label><label>英文名称<input required lang="en" maxLength={180} value={form.nameEn} onChange={event => setForm({ ...form, nameEn: event.target.value })} /></label><label>中文生成描述<textarea required rows={2} maxLength={2000} value={form.descriptionZh} onChange={event => setForm({ ...form, descriptionZh: event.target.value })} /></label><label>英文生成描述<textarea required rows={2} lang="en" maxLength={4000} value={form.descriptionEn} onChange={event => setForm({ ...form, descriptionEn: event.target.value })} /></label>{form.kind === 'term' && selectedCategory && selectedCategory.generationKind !== 'trait' && <fieldset className={styles.semanticFields}><legend>生成时采用的具体含义</legend>{selectedCategory.generationKind !== 'body-card' && <label>原类别范围<select value={form.semanticGroup} onChange={event => setForm({ ...form, semanticGroup: event.target.value })}><option value="">选择范围</option>{CONFIG.find(dimension => dimension.id === selectedCategory.generationKind)?.tags.map(group => <option key={group}>{group}</option>)}</select></label>}{selectedCategory.generationKind === 'source' && ([['shape', '形态描述'], ['shapeEn', '形态英文'], ['anchor', '识别锚点'], ['anchorEn', '锚点英文'], ['root', '命名词根']] as const).map(([key, title]) => <label key={key}>{title}<input value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}{selectedCategory.generationKind === 'concept' && ([['prop', '代表道具'], ['propEn', '道具英文'], ['mood', '情绪与氛围'], ['moodEn', '情绪英文'], ['suffix', '命名后缀']] as const).map(([key, title]) => <label key={key}>{title}<input value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}{selectedCategory.generationKind === 'body-card' && <><label>作用于身形属性<select value={form.bodyTrait} onChange={event => setForm({ ...form, bodyTrait: event.target.value })}><option value="">选择属性</option>{TRAITS.filter(trait => trait.group === 'body').map(trait => <option key={trait.id} value={trait.id}>{trait.title}</option>)}</select></label><label>身形实际描述<input value={form.bodyZh} onChange={event => setForm({ ...form, bodyZh: event.target.value })} /></label><label>身形英文描述<input value={form.bodyEn} onChange={event => setForm({ ...form, bodyEn: event.target.value })} /></label></>}<details><summary>高级语义数据</summary><textarea rows={4} aria-label="专属词条语义 JSON" value={form.semanticJson} onChange={event => setForm({ ...form, semanticJson: event.target.value })} /><small>多属性映射可用 JSON；表单中填写的具体含义优先。</small></details></fieldset>}
        <label>别名，逗号分隔<input value={form.aliases} onChange={event => setForm({ ...form, aliases: event.target.value })} /></label><label>标签，逗号分隔<input value={form.tags} onChange={event => setForm({ ...form, tags: event.target.value })} /></label><div className={styles.actions}><button disabled={Boolean(pending)}><Plus size={15} />{form.id ? '加入修改草稿' : '加入待入库草稿'}</button>{form.id && <button type="button" onClick={() => setForm(blankForm())}>取消修改</button>}</div></form>
      <details className={styles.libraryImport}><summary>导入 JSON / CSV</summary><p className={styles.hint}>先下载模板或载入示例，再填写内容。已选择类别时，模板会带入该类别；每批最多 100 项。</p><div className={styles.actions}><button type="button" onClick={() => downloadTemplate('json')}>下载 JSON 模板</button><button type="button" onClick={() => downloadTemplate('csv')}>下载 CSV 模板</button><button type="button" onClick={() => setSource(JSON.stringify(template(), null, 2))}>载入可复制示例</button></div><details><summary>导入字段说明</summary><p className={styles.hint}>JSON 使用 entries 数组（kind、data、expectedVersion）；CSV 需 kind、nameZh、nameEn、descriptionZh、descriptionEn，词条还需 categoryId。别名与标签用 | 分隔；专属语义 data 列使用 JSON。修改已有内容必须保留原 ID 与版本。</p></details><label className={styles.fileImport}>读取文件<input type="file" accept=".json,.csv,application/json,text/csv" onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 1_000_000) { setError('文件超过 1MB，请拆成不超过 100 项的批次。'); return; } void file.text().then(text => { if (alive.current) setSource(text); }); event.target.value = ''; }} /></label><textarea rows={6} aria-label="JSON 或 CSV 入库草稿" value={source} onChange={event => setSource(event.target.value)} /><button disabled={Boolean(pending) || !source.trim()} onClick={() => { try { const next = importedEntries(source); if (!next.length || next.length > 100) throw new Error('每批需有 1–100 项，请拆批后再预览。'); stage(next); } catch (e) { setError(e instanceof Error ? e.message : '导入格式无法读取。'); } }}>解析到草稿</button></details>
      <details><summary>从现有自定义卡片或 LLM 草稿收录</summary><p className={styles.hint}>先用原卡片助手形成中英草稿，再显式收录到本页预览。</p><button onClick={onOpenCardChat}>打开卡片助手</button>{cards.map(card => <div className={styles.libraryLine} key={card.id}><span>{card.title} · {card.tags.length} 个词条</span><button disabled={Boolean(pending)} onClick={() => collect(card)}>收录为词库草稿</button></div>)}{drafts.length > 0 && <button onClick={() => setSource(JSON.stringify(drafts, null, 2))}>载入创作助手建议（{drafts.length} 项）</button>}</details>
      {entries.length > 0 && <div className={styles.libraryPreview}><div className={styles.sectionHead}><h3>待入库 {entries.length} 项</h3><button disabled={Boolean(pending)} onClick={() => { setEntries([]); setPreview(null); }}>清空草稿</button></div>{entries.map((entry, index) => <div key={index} className={styles.libraryLine}><span>{entry.kind === 'category' ? '类别' : '词条'} · {typeof entry.data.nameZh === 'string' ? entry.data.nameZh : `第 ${index + 1} 项`} <small>{typeof entry.data.nameEn === 'string' ? entry.data.nameEn : ''}</small></span><span>{preview?.entries.find(item => item.index === index)?.message || (preview?.entries.find(item => item.index === index)?.status === 'duplicate' ? '重复，请移除此项后预览' : '')}</span><button aria-label={`移除第${index + 1}项入库草稿`} disabled={Boolean(pending)} onClick={() => { setEntries(current => current.filter((_, i) => i !== index)); setPreview(null); }}>移除</button></div>)}<div className={styles.actions}><button disabled={busy || Boolean(pending) || entries.length > 100} onClick={() => void previewEntries()}>校验并预览</button><button className={styles.primary} disabled={busy || Boolean(pending) || !CHARACTER_FUSION_WRITES_ENABLED || Boolean(maintenance) || !preview?.canImport} onClick={() => void confirm()}>{busy ? '处理中…' : scope === 'shared' ? '确认入共享词库' : '确认入本人词库'}</button></div>{preview && <p className={styles.hint}>{preview.errors} 项错误，{preview.duplicates} 项重复。{preview.canImport ? '预览可提交。' : '请修改或移除问题项后重新预览。'}</p>}</div>}
      {maintenance && <div className={styles.actions}><small>目录维护结果待确认</small><details><summary>操作详情</summary><small>{maintenance.opId}</small></details><button disabled={busy} onClick={() => void checkMaintenance()}>核对原操作</button><button disabled={busy || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void sendMaintenance(maintenance)}>重试这次操作</button></div>}
      {pending && <div className={styles.actions}><small>入库结果待确认</small><details><summary>操作详情</summary><small>{pending.opId}</small></details><button disabled={busy} onClick={() => void checkPending()}>核对原入库</button><button disabled={busy || Boolean(maintenance) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void confirm(pending)}>按原编号重试</button></div>}
    </details>
    <div className={styles.libraryCategories}>{catalogue.categories.filter(category => !query || [category.nameZh, category.nameEn, ...category.aliases].some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).filter(category => !categoryId || category.id === categoryId).map(category => <details key={category.id}><summary>{category.nameZh} <small>{category.nameEn} · {category.scope === 'builtin' ? '内置' : category.scope === 'private' ? '本人私有' : '共享'}{!category.enabled ? ' · 已停用' : ''}</small></summary><p>{category.descriptionZh}</p><p lang="en">{category.descriptionEn}</p><div className={styles.actions}><button disabled={!category.enabled} onClick={() => onJoin(category.id)}>加入当前工作台</button>{canEdit(category) && <><button disabled={busy || Boolean(pending) || Boolean(maintenance) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => edit(category, 'category')}>修改类别</button><button disabled={busy || Boolean(pending) || Boolean(maintenance) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void maintain(category, 'category', !category.enabled)}>{category.enabled ? '停用' : '恢复'}</button></>}</div></details>)}</div>
    <p className={styles.hint}>{loading ? '正在读取词条…' : `已显示 ${results.length} / ${total} 个匹配词条`}</p>
    <div className={styles.libraryTerms}>{results.map(term => <article className={styles.libraryTerm} key={term.id}><div><strong>{term.nameZh}</strong><small>{term.nameEn} · {catalogue.categories.find(category => category.id === term.categoryId)?.nameZh}{!term.enabled ? ' · 已停用' : ''}</small><p>{term.descriptionZh}</p><details><summary>英文、别名与版本</summary><p lang="en">{term.descriptionEn}</p><small>{[...term.aliases, ...term.tags].join(' · ') || '无别名与标签'} · {term.version}</small></details></div><div className={styles.actions}><button disabled={!term.enabled} onClick={() => onJoin(term.categoryId, term.id)}>手选到当前卡片</button>{canEdit(term) && <><button disabled={busy || Boolean(pending) || Boolean(maintenance) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => edit(term, 'term')}>修改</button><button disabled={busy || Boolean(pending) || Boolean(maintenance) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void maintain(term, 'term', !term.enabled)}>{term.enabled ? '停用' : '恢复'}</button></>}</div></article>)}</div>{!loading && !results.length && <p className={styles.empty}>没有匹配词条。可换关键词或新增草稿，当前选择保留。</p>}{nextCursor && <button disabled={loading} onClick={() => void appendPage()}>继续读取下一页</button>}
  </section>;
}
