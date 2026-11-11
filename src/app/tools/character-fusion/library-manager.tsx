'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import type { FusionCatalogue, FusionCategory, FusionTerm } from '@/lib/character-fusion/catalogue-model';
import type { FusionCard } from '@/lib/character-fusion/cards';
import { CONFIG } from '@/lib/character-fusion/engine';
import { TRAITS } from '@/lib/character-fusion/catalogue';
import { CHARACTER_FUSION_WRITES_ENABLED } from '@/lib/character-fusion/build-mode';
import { FusionRequestError, fusionRequest, postFusion, type WorkspaceOperation } from './workspace-client';
import styles from './studio.module.css';

type Entry = { kind: 'category' | 'term'; data: Partial<FusionCategory> | Partial<FusionTerm>; expectedVersion?: string };
type Preview = { version: string; entries: Array<{ index: number; status: 'new' | 'update' | 'duplicate' | 'error'; message?: string; entry?: Entry }>; errors: number; duplicates: number; canImport: boolean };
type MaintenanceOperation = { opId: string; body: Record<string, unknown> };
type ImportOperation = { opId: string; scope: 'private' | 'shared'; entries: Entry[]; previewVersion: string };
type Props = { ownerId: string; admin: boolean; active: boolean; catalogue: FusionCatalogue; cards: FusionCard[]; drafts: unknown[]; onCatalogue: (catalogue: FusionCatalogue) => void; onJoin: (categoryId: string, termId?: string) => void; onOpenCardChat: () => void };
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
export default function LibraryManager({ ownerId, admin, active, catalogue, cards, drafts, onCatalogue, onJoin, onOpenCardChat }: Props) {
  const [scope, setScope] = useState<'private' | 'shared'>('private'), [query, setQuery] = useState(''), [categoryId, setCategoryId] = useState('');
  const [results, setResults] = useState<FusionTerm[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [total, setTotal] = useState(0), [loading, setLoading] = useState(false);
  const [form, setForm] = useState(blankForm), [source, setSource] = useState(''), [entries, setEntries] = useState<Entry[]>([]), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [maintenance, setMaintenance] = useState<MaintenanceOperation | null>(null);
  const [pending, setPending] = useState<ImportOperation | null>(null), [reload, setReload] = useState(0);
  const editor = useRef<HTMLDetailsElement>(null);
  const alive = useRef(active); alive.current = active;
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
