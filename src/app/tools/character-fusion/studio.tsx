'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Plus, RefreshCw, Save, Trash2, Undo2, UnlockKeyhole } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { ADDONS, CONFIG, CORE, COUNTS, allowed, bossRow, csvFor, defaults, missingRequired, parseSettings, reconcile, refreshBoss, settingsForRow, textFor, txtFor, validateGeneration, type Dimension, type FusionRow, type FusionSettings, type Tag } from '@/lib/character-fusion/engine';
import RuleCard from './rule-card';
import { RelativeTime } from '@/components/RelativeTime';
import CatalogueEditor, { defaultCatalogueView, toggleCategoryLock, joinCatalogueCard, type CatalogueView } from './catalogue-editor';
import { artDirectionPair } from '@/lib/character-fusion/design';
import { TRAITS, concreteOptions, emptyCatalogue, builtinCatalogue, dynamicPolicy } from '@/lib/character-fusion/catalogue';
import CardChat, { emptyConversation, type CardConversation } from './card-chat';
import { parseCardDraft, cardValues, type CardDraft, type FusionCard } from '@/lib/character-fusion/cards';
import { toggleChoice } from '@/lib/character-fusion/selection';
import ChoicePills from './choice-pills';
import { BODY_CARDS, catalogueCards, updateCard } from '@/lib/character-fusion/body-cards';
import { fusionAssistant } from '@/lib/character-fusion/assistant';
import { usePricingModelAvailability } from '@/lib/pricing/use-model-availability';
import type { FusionRecipe } from '@/lib/character-fusion/recipes';
import type { FusionCatalogue } from '@/lib/character-fusion/catalogue-model';
import { CHARACTER_FUSION_WRITES_ENABLED } from '@/lib/character-fusion/build-mode';
import { settingsFingerprint, type FusionCommand, type FusionWorkspaceState, type FusionWorkspaceRow } from '@/lib/character-fusion/actions';
import LibraryManager from './library-manager';
import CreationChat from './creation-chat';
import { WORKSPACE_API, FusionRequestError, fusionRequest, postFusion, lookupOperation, stateCommands, workspaceConflicts, mergeWorkspaceState, mergeWorkspaceRows, type FusionWorkspace, type WorkspaceReceipt, type RowsPage } from './workspace-client';
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
type UndoAction = { label: string; remote?: boolean; restore: () => void };

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
  const [focusGroup, setFocusGroup] = useState<'fusion' | 'body' | 'extra'>('fusion');
  const [catalogueView, setCatalogueView] = useState<CatalogueView>(defaultCatalogueView);
  const [chatOpen, setChatOpen] = useState(false), [conversation, setConversation] = useState<CardConversation>(emptyConversation);
  const [translating, setTranslating] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  const [translationOpen, setTranslationOpen] = useState(false);
  const translationResult = useRef<HTMLDetailsElement>(null);
  const translationController = useRef<AbortController | null>(null);
  useEffect(() => () => translationController.current?.abort(), []);
  const [settings, setSettings] = useState<FusionSettings>(defaults);
  const [rows, setRows] = useState<FusionRow[]>([]);
  const [batchMode, setBatchMode] = useState<'replace' | 'append'>('replace');
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const modelSettings = useRef<HTMLDetailsElement>(null);
  const legacyCards = useRef<HTMLDetailsElement>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [retained, setRetained] = useState<string[]>([]);
  const [idea, setIdea] = useState(''), [summary, setSummary] = useState('');
  const [catalogue, setCatalogue] = useState<FusionCatalogue>(builtinCatalogue);
  const [workspace, setWorkspace] = useState<FusionWorkspace | null>(null), [documents, setDocuments] = useState<FusionWorkspace[]>([]);
  const [documentQuery, setDocumentQuery] = useState(''), [showArchived, setShowArchived] = useState(false), [documentName, setDocumentName] = useState('');
  const [pendingCreation, setPendingCreation] = useState<{ opId: string; name: string; carry: boolean; automatic?: boolean; baseState?: FusionWorkspaceState; state?: FusionWorkspaceState } | null>(null);
  const initialDocument = useRef(false);
  const documentTransition = useRef<'create' | 'load' | null>(null), documentList = useRef<HTMLDetailsElement>(null);
  const [loadingDocument, setLoadingDocument] = useState(false), [savingDocument, setSavingDocument] = useState(false), [syncError, setSyncError] = useState('');
  const [conflicts, setConflicts] = useState<Array<{ path: string[]; draft: unknown; remote: unknown }>>([]);
  const [legacyDraft, setLegacyDraft] = useState(false), [assistantDrafts, setAssistantDrafts] = useState<unknown[]>([]);
  const [rowsPage, setRowsPage] = useState<RowsPage>({ nextCursor: null, total: 0 });
  const [pendingOperation, setPendingOperation] = useState<{ workspaceId: string; opId: string; baseVersion: number; commands: FusionCommand[]; acknowledged?: FusionWorkspaceState } | null>(null);
  const workspaceRef = useRef<FusionWorkspace | null>(null), rowsRef = useRef<FusionRow[]>([]), savedDraftRef = useRef<Record<string, unknown> | null>(null);
  const stateRef = useRef<FusionWorkspaceState>({ settings, idea: '', summary: '', messages: [], selectedIds: [], retainedIds: [] });
  stateRef.current = { settings, idea, summary, messages: workspace?.state.messages || [], selectedIds: selected, retainedIds: retained }; rowsRef.current = rows;
  const flight = useRef<Promise<boolean> | null>(null), pendingRef = useRef(pendingOperation); pendingRef.current = pendingOperation;
  const syncBlocked = useRef(false);
  const [view, setView] = useState<'workspace' | 'recipes' | 'library'>('workspace');
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
  const showResults = () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        savedDraftRef.current = saved;
        setLegacyDraft(!saved.workspaceId && (saved.rows?.length > 0 || JSON.stringify(saved.settings) !== JSON.stringify(defaults())));
        if (typeof saved.idea === 'string') setIdea(saved.idea); if (typeof saved.summary === 'string') setSummary(saved.summary);
        if (saved.pendingOperation?.opId) setPendingOperation(saved.pendingOperation);
        const creation = JSON.parse(sessionStorage.getItem(storageKey + ':creation') || 'null'); if (creation?.opId) setPendingCreation(creation);
        const restored = parseSettings(saved.settings);
        setSettings(restored);
        setTranslationOpen(Boolean(restored.requirementsEn) || Object.values(restored.rules).some(tags => tags.some(tag => tag.en)));
        if (Array.isArray(saved.rows)) { setRows(saved.rows); if (Array.isArray(saved.selected)) setSelected(saved.selected.filter((id: unknown) => typeof id === 'string' && saved.rows.some((row: FusionRow) => row.id === id))); setRetained((Array.isArray(saved.retained) ? saved.retained : saved.selected || []).filter((id: unknown) => typeof id === 'string' && saved.rows.some((row: FusionRow) => row.id === id))); }
        if (saved.batchMode === 'append') setBatchMode('append');
        setRulesAtGeneration(saved.rulesAtGeneration || '');
        if (saved.conversation?.messages?.length <= 38 && typeof saved.conversation.input === 'string') setConversation({ ...saved.conversation, draft: saved.conversation.draft ? parseCardDraft(saved.conversation.draft) : null });
      }
      const ui = JSON.parse(localStorage.getItem(storageKey + ':ui') || '{}');
      if (Array.isArray(ui.expanded)) setExpanded(ui.expanded.filter((id: unknown) => typeof id === 'string'));
      if (Array.isArray(ui.cardOrder)) setCardOrder(ui.cardOrder.filter((id: unknown) => typeof id === 'string'));
      if (typeof ui.apiModel === 'string') setApiModel(ui.apiModel);
      if (ui.catalogueView?.presentation === 'cards' || ui.catalogueView?.presentation === 'groups') setCatalogueView({ presentation: ui.catalogueView.presentation, expanded: Array.isArray(ui.catalogueView.expanded) ? ui.catalogueView.expanded.filter((id: unknown) => typeof id === 'string') : [], order: Array.isArray(ui.catalogueView.order) ? ui.catalogueView.order.filter((id: unknown) => typeof id === 'string') : [] });
    } catch { setNotice('未能恢复本页临时现场，账号配方仍可在“我的配方”读取。'); }
    setDraftReady(true);
  }, [active, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    try { const draft = { settings, rows, selected, retained, idea, summary, workspaceId: workspace?.id, remoteBase: workspace?.state, pendingOperation, batchMode, rulesAtGeneration, conversation }; sessionStorage.setItem(workspace ? storageKey + ':doc:' + workspace.id : storageKey, JSON.stringify(draft)); if (!workspace) savedDraftRef.current = draft; } catch { /* Explicit server recipes remain available without tab storage. */ }
  }, [active, draftReady, settings, rows, selected, retained, idea, summary, workspace, pendingOperation, batchMode, rulesAtGeneration, conversation, storageKey]);
  useEffect(() => { if (active && draftReady) { try { localStorage.setItem(storageKey + ':ui', JSON.stringify({ expanded, cardOrder, apiModel, catalogueView })); } catch { /* The current controls remain usable. */ } } }, [active, draftReady, expanded, cardOrder, apiModel, catalogueView, storageKey]);
  useEffect(() => {
    if (!active || view !== 'recipes') return;
    const controller = new AbortController(); setLoadingRecipes(true); setRecipeError('');
    fetch(API, { cache: 'no-store', signal: controller.signal, headers: { 'X-Character-Fusion-Format': '2' } }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取配方失败。');
      if (activeRef.current && !controller.signal.aborted) setRecipes(data.recipes);
    }).catch(e => { if (!controller.signal.aborted && activeRef.current) setRecipeError(e instanceof Error ? e.message : '读取配方失败。'); })
      .finally(() => { if (!controller.signal.aborted && activeRef.current) setLoadingRecipes(false); });
    return () => controller.abort();
  }, [active, view, recipeReload]);
  const applyWorkspace = (receipt: Pick<WorkspaceReceipt, 'workspace' | 'rowChanges' | 'rowsPage'>, replace = false, acknowledged?: FusionWorkspaceState, appendPage = false) => {
    if (!activeRef.current) return;
    const previous = workspaceRef.current;
    if (!replace && previous && (receipt.workspace.id !== previous.id || receipt.workspace.version < previous.version)) return;
    const detected = !replace && previous ? workspaceConflicts(acknowledged || previous.state, stateRef.current, receipt.workspace.state) : [];
    if (detected.length) { setConflicts(detected); syncBlocked.current = true; setSyncError('远端与当前草稿修改了相同内容。当前输入保留，请核对差异后保存。'); }
    const nextState = replace ? receipt.workspace.state : mergeWorkspaceState(acknowledged || previous?.state || receipt.workspace.state, stateRef.current, receipt.workspace.state);
    const nextRows = mergeWorkspaceRows(rowsRef.current, receipt, replace, appendPage);
    workspaceRef.current = receipt.workspace; stateRef.current = nextState; rowsRef.current = nextRows;
    setWorkspace(receipt.workspace); setSettings(nextState.settings); setIdea(nextState.idea); setSummary(nextState.summary); setSelected(nextState.selectedIds); setRetained(nextState.retainedIds); setRows(nextRows); setDocumentName(receipt.workspace.name);
    if (receipt.rowsPage) setRowsPage(receipt.rowsPage);
    try { localStorage.setItem(storageKey + ':workspace', receipt.workspace.id); const url = new URL(window.location.href); url.searchParams.set('doc', receipt.workspace.id); window.history.replaceState(null, '', url); } catch { /* Current document remains open. */ }
  };
  const commit = async (commands: FusionCommand[], label = '', acknowledged?: FusionWorkspaceState, retry?: NonNullable<typeof pendingOperation>): Promise<boolean> => {
    const current = workspaceRef.current;
    if (!current || !activeRef.current || !CHARACTER_FUSION_WRITES_ENABLED || current.archived && !commands.every(command => command.type === 'archive' && !command.archived)) { setSyncError('请先保存为本人工作文档，或恢复归档文档后继续。'); return false; }
    if (pendingRef.current && !retry) { setSyncError('上次操作仍待核对，请先核对原操作。'); return false; }
    const operation = retry || { workspaceId: current.id, opId: crypto.randomUUID(), baseVersion: current.version, commands, acknowledged };
    if (operation.workspaceId !== current.id) return false;
    pendingRef.current = operation; setPendingOperation(operation); setSavingDocument(true); setSyncError('');
    try {
      const receipt = await postFusion<WorkspaceReceipt>(`${WORKSPACE_API}/${encodeURIComponent(current.id)}/actions`, operation);
      if (!activeRef.current || workspaceRef.current?.id !== current.id) return false;
      applyWorkspace(receipt, false, operation.acknowledged); setPendingOperation(null); pendingRef.current = null; if (!workspaceConflicts(operation.acknowledged || current.state, stateRef.current, receipt.workspace.state).length) { syncBlocked.current = false; setConflicts([]); }
      if (label && receipt.operation.reversible) setUndo({ label, remote: true, restore: () => { void commit([{ type: 'undo', operationId: receipt.operation.opId }], ''); } });
      if (label) setNotice(`${label}已保存。`); return true;
    } catch (e) {
      if (!activeRef.current || workspaceRef.current?.id !== current.id) return false;
      if (e instanceof FusionRequestError && e.status < 500) { pendingRef.current = null; setPendingOperation(null); syncBlocked.current = true; }
      if (e instanceof FusionRequestError && e.status === 409 && e.details && typeof e.details === 'object' && 'path' in e.details) { const detail = e.details as { path: string[]; expected?: unknown; current?: unknown }; let draft: unknown = stateRef.current; for (const key of detail.path) draft = draft && typeof draft === 'object' ? (draft as Record<string, unknown>)[key] : undefined; setConflicts([{ path: detail.path, draft, remote: detail.current }]); }
      setSyncError(e instanceof Error ? e.message : '保存结果待确认，草稿与原操作编号保留。'); return false;
    } finally { if (activeRef.current && workspaceRef.current?.id === current.id) setSavingDocument(false); }
  };
  const synchronize = (): Promise<boolean> => {
    if (flight.current) return flight.current.then(ok => ok ? synchronize() : false);
    const current = workspaceRef.current; if (!current) return Promise.resolve(false);
    const local = stateRef.current, commands = stateCommands(current.state, local);
    if (!commands.length) return Promise.resolve(true);
    const request = commit(commands, '', local); flight.current = request;
    void request.finally(() => { if (flight.current === request) flight.current = null; }); return request;
  };
  const execute = async (commands: FusionCommand[], label: string) => {
    if (savingDocument || pendingRef.current) { setSyncError('当前操作正在保存或待核对，请稍后继续。'); return false; }
    if (!await synchronize()) return false;
    return commit(commands, label);
  };
  const loadDocument = async (id: string, initial = false) => {
    if (!activeRef.current || documentTransition.current) return;
    documentTransition.current = 'load'; setLoadingDocument(true); setSyncError(''); syncBlocked.current = false; setConflicts([]);
    try {
      if (!initial && workspaceRef.current && !await synchronize()) return;
      const data = await fusionRequest<{ workspace: FusionWorkspace; rowsPage?: RowsPage; nextCursor?: string | null; total?: number }>(`${WORKSPACE_API}/${encodeURIComponent(id)}`);
      if (!activeRef.current) return;
      let draft = savedDraftRef.current; try { draft = JSON.parse(sessionStorage.getItem(storageKey + ':doc:' + id) || 'null') || draft; } catch { /* Existing draft remains in memory. */ }
      const beforeLoad = stateRef.current, previousDoc = workspaceRef.current;
      applyWorkspace({ workspace: data.workspace, rowsPage: data.rowsPage || { nextCursor: data.nextCursor || null, total: data.total || data.workspace.rows.length } }, true);
      if (initial && previousDoc?.id === id) { const restored = mergeWorkspaceState(previousDoc.state, beforeLoad, data.workspace.state); stateRef.current = restored; setSettings(restored.settings); setIdea(restored.idea); setSummary(restored.summary); setSelected(restored.selectedIds); setRetained(restored.retainedIds); const detected = workspaceConflicts(previousDoc.state, beforeLoad, data.workspace.state); setConflicts(detected); syncBlocked.current = true; setSyncError('已读取远端，未同步草稿保留。请核对后点击保存现场。'); }
      else if (draft?.workspaceId === id && draft.remoteBase) {
        const savedState: FusionWorkspaceState = { settings: parseSettings(draft.settings), idea: typeof draft.idea === 'string' ? draft.idea : '', summary: typeof draft.summary === 'string' ? draft.summary : '', messages: data.workspace.state.messages, selectedIds: Array.isArray(draft.selected) ? draft.selected as string[] : [], retainedIds: Array.isArray(draft.retained) ? draft.retained as string[] : [] };
        const restored = mergeWorkspaceState(draft.remoteBase as FusionWorkspaceState, savedState, data.workspace.state); const detected = workspaceConflicts(draft.remoteBase as FusionWorkspaceState, savedState, data.workspace.state); setConflicts(detected); if (detected.length) { syncBlocked.current = true; setSyncError('已恢复浏览器草稿，远端有同字段修改。请核对差异后保存。'); }
        stateRef.current = restored; setSettings(restored.settings); setIdea(restored.idea); setSummary(restored.summary); setSelected(restored.selectedIds); setRetained(restored.retainedIds);
      }
      if (draft?.pendingOperation && (draft.pendingOperation as { workspaceId?: string }).workspaceId === id) { pendingRef.current = draft.pendingOperation as NonNullable<typeof pendingOperation>; setPendingOperation(pendingRef.current); } else { pendingRef.current = null; setPendingOperation(null); }
      setView('workspace'); setUndo(null); if (documentList.current) documentList.current.open = false;
    } catch (e) { if (activeRef.current) setSyncError(e instanceof Error ? e.message : '文档读取失败，浏览器现场保留。'); }
    finally { documentTransition.current = null; if (activeRef.current) setLoadingDocument(false); }
  };
  useEffect(() => {
    if (!active || !draftReady) return;
    let cancelled = false;
    void fusionRequest<{ catalogue: FusionCatalogue }>('/api/character-fusion/catalogue').then(data => { if (!cancelled && activeRef.current) setCatalogue(data.catalogue); }).catch(e => { if (!cancelled && activeRef.current) setSyncError(e instanceof Error ? e.message : '词库读取失败，当前目录保留。'); });
    if (initialDocument.current) return; initialDocument.current = true;
    const explicit = new URL(window.location.href).searchParams.get('doc'), saved = savedDraftRef.current;
    let recent = explicit || (typeof saved?.workspaceId === 'string' ? saved.workspaceId : ''); try { recent ||= localStorage.getItem(storageKey + ':workspace') || ''; } catch { /* The saved tab draft still works. */ }
    const oldDraft = saved && !saved.workspaceId && (Array.isArray(saved.rows) && saved.rows.length > 0 || JSON.stringify(saved.settings) !== JSON.stringify(defaults()));
    if (recent && (explicit || !oldDraft)) void loadDocument(recent, true);
    else if (!oldDraft) void fusionRequest<{ workspaces: FusionWorkspace[] }>(`${WORKSPACE_API}?limit=1&archived=0`).then(data => { if (!cancelled && activeRef.current) { if (data.workspaces[0]) void loadDocument(data.workspaces[0].id, true); else void createDocument(false, pendingCreation, true); } }).catch(e => { if (!cancelled && activeRef.current) setSyncError(e instanceof Error ? e.message : '最近文档暂时无法读取。'); });
    return () => { cancelled = true; };
    // Document restoration runs once per account after local draft recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draftReady, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    const controller = new AbortController(), params = new URLSearchParams({ q: documentQuery, archived: showArchived ? '1' : '0', limit: '100' });
    fusionRequest<{ workspaces: FusionWorkspace[] }>(`${WORKSPACE_API}?${params}`, { signal: controller.signal }).then(data => { if (activeRef.current && !controller.signal.aborted) setDocuments(data.workspaces); }).catch(e => { if (activeRef.current && !controller.signal.aborted) setSyncError(e instanceof Error ? e.message : '文档列表读取失败。'); });
    return () => controller.abort();
  }, [active, draftReady, documentQuery, showArchived, workspace?.id, workspace?.name, workspace?.archived]);
  useEffect(() => {
    if (!active || !draftReady || !workspace || workspace.archived || pendingOperation || savingDocument || syncBlocked.current || !CHARACTER_FUSION_WRITES_ENABLED) return;
    const timer = window.setTimeout(() => { void synchronize(); }, 700); return () => window.clearTimeout(timer);
    // Input changes are combined into field-level commands; UI preferences stay local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draftReady, workspace, settings, selected, retained, idea, summary, pendingOperation, savingDocument]);
  const createDocument = async (carry: boolean, retry = pendingCreation, automatic = false) => {
    if (!activeRef.current || documentTransition.current || savingDocument || !CHARACTER_FUSION_WRITES_ENABLED) return;
    documentTransition.current = 'create'; setLoadingDocument(true); setSyncError('');
    try {
      if (workspaceRef.current && !await synchronize()) return;
      let currentState = stateRef.current, currentRows = rowsRef.current;
      if (carry && legacyDraft && workspaceRef.current && savedDraftRef.current) { const draft = savedDraftRef.current; currentState = { settings: parseSettings(draft.settings), idea: typeof draft.idea === 'string' ? draft.idea : '', summary: typeof draft.summary === 'string' ? draft.summary : '', messages: [], selectedIds: Array.isArray(draft.selected) ? draft.selected as string[] : [], retainedIds: Array.isArray(draft.retained) ? draft.retained as string[] : Array.isArray(draft.selected) ? draft.selected as string[] : [] }; currentRows = Array.isArray(draft.rows) ? draft.rows as FusionRow[] : []; }
      const creation: NonNullable<typeof pendingCreation> = retry || { opId: crypto.randomUUID(), name: carry ? '继续角色融合创作' : '新的角色融合创作', carry, automatic, ...(automatic ? { baseState: currentState } : !carry ? { state: { settings: structuredClone(currentState.settings), idea: '', summary: '', messages: [], selectedIds: [], retainedIds: [] } } : {}) }; setPendingCreation(creation); try { sessionStorage.setItem(storageKey + ':creation', JSON.stringify(creation)); } catch { /* The original ID stays in memory. */ }
      const receipt = await postFusion<WorkspaceReceipt>(WORKSPACE_API, { opId: creation.opId, name: creation.name, ...(creation.state ? { state: creation.state } : {}) });
      if (!activeRef.current) return;
      const continued = creation.automatic ? mergeWorkspaceState(creation.baseState || currentState, stateRef.current, receipt.workspace.state) : null;
      applyWorkspace(receipt, true);
      if (continued) { stateRef.current = continued; setSettings(continued.settings); setIdea(continued.idea); setSummary(continued.summary); setSelected(continued.selectedIds); setRetained(continued.retainedIds); }
      setPendingCreation(null); try { sessionStorage.removeItem(storageKey + ':creation'); } catch { /* Saved receipt is already known. */ } setLegacyDraft(false); setView('workspace'); if (documentList.current) documentList.current.open = false;
      if (continued) await synchronize();
      if (creation.carry) { const imported = await commit([{ type: 'importDraft', state: currentState, rows: currentRows }], '当前现场'); if (!imported) { stateRef.current = currentState; rowsRef.current = currentRows; setSettings(currentState.settings); setRows(currentRows); setIdea(currentState.idea); setSummary(currentState.summary); setSelected(currentState.selectedIds); setRetained(currentState.retainedIds); setLegacyDraft(true); } else { const migrated = { ...savedDraftRef.current, workspaceId: receipt.workspace.id }; savedDraftRef.current = migrated; try { sessionStorage.setItem(storageKey, JSON.stringify(migrated)); } catch { /* The old draft remains stored. */ } } }
    } catch (e) { if (activeRef.current) setSyncError(e instanceof Error ? e.message : '新文档创建未确认，当前现场保留。'); }
    finally { documentTransition.current = null; if (activeRef.current) setLoadingDocument(false); }
  };
  const checkPending = async () => {
    const pending = pendingRef.current; if (!pending || savingDocument) return; setSavingDocument(true); setSyncError('');
    try {
      const result = await lookupOperation(pending.workspaceId, pending.opId); if (!activeRef.current || workspaceRef.current?.id !== pending.workspaceId) return;
      if (result.status === 'committed' && result.workspace) {
        const detected = workspaceConflicts(pending.acknowledged || workspaceRef.current.state, stateRef.current, result.workspace.state);
        applyWorkspace({ workspace: result.workspace, rowsPage: result.rowsPage, rowChanges: result.rowChanges }, false, pending.acknowledged); setPendingOperation(null); pendingRef.current = null;
        if (!detected.length) { syncBlocked.current = false; setConflicts([]); } setNotice('原操作已确认。');
      } else if (result.status === 'rejected' || result.status === 'cancelled') { setPendingOperation(null); pendingRef.current = null; syncBlocked.current = true; setSyncError('原操作已结束，未应用新内容。当前草稿保留，可调整后保存。'); }
      else setSyncError('原操作尚未确认，草稿和原编号保留。可继续核对或重试这次操作。');
    } catch (e) { if (activeRef.current) setSyncError(e instanceof Error ? e.message : '暂时无法核对原操作。'); }
    finally { if (activeRef.current) setSavingDocument(false); }
  };
  const loadMoreRows = async () => { if (!workspace || !rowsPage.nextCursor || loadingDocument) return; setLoadingDocument(true); try { const data = await fusionRequest<{ workspace: FusionWorkspace; rowsPage?: RowsPage; nextCursor?: string | null; total?: number }>(`${WORKSPACE_API}/${workspace.id}?cursor=${encodeURIComponent(rowsPage.nextCursor)}`); if (activeRef.current && workspaceRef.current?.id === workspace.id) applyWorkspace({ workspace: data.workspace, rowsPage: data.rowsPage || { nextCursor: data.nextCursor || null, total: data.total || rowsPage.total } }, false, undefined, true); } catch (e) { if (activeRef.current) setSyncError(e instanceof Error ? e.message : '后续结果读取失败，已显示结果保留。'); } finally { if (activeRef.current) setLoadingDocument(false); } };
  const useCatalogue = (next: FusionCatalogue) => {
    setCatalogue(next); setSettings(current => {
      const dynamic = current.catalogue?.dynamic; if (!dynamic) return current;
      const ids = Object.keys(dynamic.selections), old = dynamic.snapshot;
      const categories = ids.flatMap(id => { const found = next.categories.find(category => category.id === id) || old.categories.find(category => category.id === id); return found ? [{ ...found, enabled: next.categories.some(category => category.id === id) && found.enabled }] : []; });
      const selectedTerms = new Map(old.terms.filter(term => ids.includes(term.categoryId)).map(term => [term.id, { ...term, enabled: false }]));
      for (const term of next.terms.filter(term => ids.includes(term.categoryId))) selectedTerms.set(term.id, term);
      return { ...current, catalogue: { ...current.catalogue!, dynamic: { ...dynamic, snapshot: { version: next.version, categories, terms: Array.from(selectedTerms.values()) } } } };
    });
  };
  const joinTerm = (categoryId: string, termId?: string) => {
    const category = catalogue.categories.find(item => item.id === categoryId); if (!category) return;
    setSettings(current => {
      const base = current.catalogue || emptyCatalogue(), old = base.dynamic?.selections[categoryId], legacy = base.traits[categoryId];
      const terms = catalogue.terms.filter(term => term.categoryId === categoryId), ids = (values: string[]) => values.flatMap(value => { const term = terms.find(item => (item.legacyValue || item.nameZh) === value); return term ? [term.id] : []; });
      const selection = old || (legacy ? { ...legacy, values: ids(legacy.values), excluded: ids(legacy.excluded), must: ids(legacy.must) } : { enabled: true, locked: false, values: [], excluded: [], must: [] });
      const selections = { ...base.dynamic?.selections, [categoryId]: { ...selection, enabled: true, ...(termId ? { locked: true, values: toggleChoice(selection.locked ? selection.values : [], termId, dynamicPolicy(category, terms)), excluded: selection.excluded.filter(id => id !== termId) } : {}) } };
      const categoryIds = Object.keys(selections);
      return { ...current, catalogue: { ...base, dynamic: { formatVersion: 1, selections, snapshot: { version: catalogue.version, categories: catalogue.categories.filter(item => categoryIds.includes(item.id)), terms: catalogue.terms.filter(term => categoryIds.includes(term.categoryId)) } } } };

    }); setFocusGroup(category.group); setCatalogueView(current => ({ ...current, expanded: Array.from(new Set([...current.expanded, `catalogue-${categoryId}`])) })); setView('workspace'); requestAnimationFrame(() => document.getElementById(`card-catalogue-${categoryId}-root`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); setNotice(`已加入「${category.nameZh}」，用于后续新结果。`);
  };
  const run = (action: () => void) => { setError(''); setNotice(''); try { action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); } };
  const generate = () => { void execute([{ type: 'generate', mode: batchMode, seed: Math.floor(Math.random() * 0x100000000), settingsHash: settingsFingerprint(settings) }], '生成候选').then(ok => { if (ok && activeRef.current) { setRulesAtGeneration(JSON.stringify({ rules: settingsRef.current.rules, cards: settingsRef.current.cards, catalogue: settingsRef.current.catalogue })); requestAnimationFrame(showResults); } }); };
  const openModelSettings = () => { if (modelSettings.current) modelSettings.current.open = true; modelSettings.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); document.getElementById('fusion-api-model')?.focus({ preventScroll: true }); };
  const changeCard = (id: string, update: (card: FusionCard) => FusionCard) => run(() => {
    const cards = updateCard(settings.cards, id, update);
    if (!settings.cards.some(card => card.id === id)) setUndo({ label: '身形卡片设置', restore: () => setSettings(current => ({ ...current, cards: current.cards.filter(card => card.id !== id) })) });
    setSettings(s => ({ ...s, cards }));
  });
  const addDimension = (id: string) => {
    if (CONFIG.some(c => c.id === id)) setSettings(s => s.bossDimensions.includes(id as Dimension) ? s : { ...s, bossDimensions: [...s.bossDimensions, id as Dimension] });
    else changeCard(id, card => ({ ...card, joined: true }));
  };
  const toggleDimension = (id: Dimension) => setSettings(s => s.bossDimensions.includes(id) ? { ...s, bossDimensions: s.bossDimensions.filter(v => v !== id), bossLocks: { ...s.bossLocks, [id]: false } } : { ...s, bossDimensions: [...s.bossDimensions, id] });
  const cycleBoss = (id: Dimension) => {
    const pool = [...(ADDONS.some(c => c.id === id) ? [''] : []), ...allowed(settings, id)];
    if (!pool.length) { setError('这个维度没有可用标签，请先调整规则。'); return; }
    const value = pool[(pool.indexOf(settings.boss[id]) + 1) % pool.length];
    setSettings(s => { const catalogue = s.catalogue || emptyCatalogue(), details = { ...catalogue.details }; delete details[id]; return { ...s, boss: { ...s.boss, [id]: value }, bossLocks: { ...s.bossLocks, [id]: true }, catalogue: { ...catalogue, details } }; });
  };
  const setTagStatus = (id: Dimension, label: string, status: Tag['status']) => setSettings(s => reconcile({ ...s, rules: { ...s.rules, [id]: s.rules[id].map(t => t.label === label ? { ...t, status } : t) } }));
  const setCustomTagStatus = (id: string, label: string, status: Tag['status']) => changeCard(id, card => {
    const tags = card.tags.map(t => t.label === label ? { ...t, status } : t);
    const valid = tags.some(t => t.label === card.value && t.status !== 'exclude');
    return { ...card, tags, value: valid || card.locked ? card.value : tags.find(t => t.status !== 'exclude')?.label || card.value };
  });
  const cycleBodyCard = (id: string) => changeCard(id, card => {
    const pool = card.tags.filter(tag => tag.status !== 'exclude');
    if (!pool.length) throw new Error(`${card.title}没有可用选项，请先调整规则。`);
    return { ...card, value: pool[(pool.findIndex(tag => tag.label === card.value) + 1) % pool.length].label, locked: true };
  });
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
  const collectRows = async (selectedOnly = false): Promise<FusionRow[] | null> => {
    if (exportController.current) return null;
    const documentId = workspaceRef.current?.id, ids = [...stateRef.current.selectedIds];
    if (!documentId) return selectedOnly ? rowsRef.current.filter(row => ids.includes(row.id)) : rowsRef.current;
    const controller = new AbortController(); exportController.current = controller; setExportProgress('正在读取完整结果…');
    try {
      type Page = { workspace: FusionWorkspace; rowsPage: RowsPage };
      const first = await fusionRequest<Page>(`${WORKSPACE_API}/${encodeURIComponent(documentId)}?limit=200`, { signal: controller.signal });
      const version = first.workspace.version, complete = [...first.workspace.rows]; let cursor = first.rowsPage.nextCursor;
      setExportProgress(`读取 ${complete.length} / ${first.rowsPage.total}`);
      while (cursor) {
        const page = await fusionRequest<Page>(`${WORKSPACE_API}/${encodeURIComponent(documentId)}?limit=200&cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
        if (page.workspace.version !== version) throw new Error('读取期间文档已更新，未交付不完整文件。请按当前文档重新复制或导出。');
        complete.push(...page.workspace.rows); cursor = page.rowsPage.nextCursor; setExportProgress(`读取 ${complete.length} / ${first.rowsPage.total}`);
      }
      if (controller.signal.aborted || !activeRef.current || workspaceRef.current?.id !== documentId) return null;
      if (complete.length !== first.rowsPage.total) throw new Error('结果尚未完整读取，未交付部分文件。请重新读取。');
      if (!selectedOnly) return complete;
      const chosen = complete.filter(row => ids.includes(row.id));
      if (chosen.length !== ids.length) throw new Error('部分勾选结果已变化，未复制部分内容。请读取当前文档并重新勾选。');
      return chosen;
    } catch (e) {
      if (activeRef.current) { if (controller.signal.aborted) setNotice('已取消读取，未复制或导出。'); else setError(e instanceof Error ? e.message : '完整结果读取失败，未交付部分内容。'); } return null;
    } finally { if (exportController.current === controller) { exportController.current = null; if (activeRef.current) setExportProgress(''); } }
  };
  const copyDocument = async (selectedOnly = false) => { const complete = await collectRows(selectedOnly); if (complete && activeRef.current) await copyRows(complete); };
  const selectAllRows = async () => {
    if (selected.length && selected.length === (workspace ? rowsPage.total : rows.length)) { setSelected([]); return; }
    const complete = await collectRows(); if (complete && activeRef.current) setSelected(complete.map(row => row.id));
  };
  const download = async (format: 'txt' | 'csv' | 'prompts') => {
    setError(''); const complete = await collectRows(); if (!complete || !activeRef.current) return;
    try {
      const content = format === 'prompts' ? complete.map(row => textFor(row, settings)).join('\n\n') : format === 'txt' ? txtFor(complete, settings) : csvFor(complete, settings);
      if (content.includes('英文尚待补齐')) throw new Error('请先补齐英文，再导出。');
      const blob = new Blob(['\ufeff', content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `character-fusion-${settings.lang}${format === 'prompts' ? '-prompts.txt' : `.${format}`}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出完整 ${complete.length} 条结果。`);
    } catch (e) { if (activeRef.current) setError(e instanceof Error ? e.message : '导出失败，未交付部分文件。'); }
  };
  const sendTo = async (href: string) => {
    if (!selected.length) { setError('请先勾选提示词。'); return; }
    const chosen = await collectRows(true); if (chosen && await copyRows(chosen) && activeRef.current) window.location.assign(href);
  };
  const mutateRecipe = async (body: object) => {
    const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Character-Fusion-Format': '2' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '配方操作未确认。'); return data;
  };
  const saveRecipe = async () => {
    if (!form || busy || !active) return;
    setBusy(true); setError('');
    try {
      if (form.action === 'save' && workspaceRef.current && !workspaceRef.current.archived && CHARACTER_FUSION_WRITES_ENABLED) { const saved = await execute([{ type: 'saveRecipe', id: form.id, name: form.name, settingsHash: settingsFingerprint(settingsRef.current) }], '规则配方'); if (saved && activeRef.current) { setForm(null); setRecipeReload(value => value + 1); } return; }
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
  const cardCatalogue = catalogueCards(settings.cards);
  const allCards = [...CONFIG.map(c => ({ id: c.id, title: c.title })), ...cardCatalogue.map(c => ({ id: c.id, title: c.title }))];
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
    if (legacyCards.current) legacyCards.current.open = true;
    requestAnimationFrame(() => document.getElementById(`card-${id}-root`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  });
  const translate = async () => {
    if (translating) return;
    if (!workspaceRef.current || !CHARACTER_FUSION_WRITES_ENABLED || workspaceRef.current.archived) { setError('请先保存并继续当前现场，再补齐英文。'); return; }
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
      const priorRules = JSON.stringify({ rules: settingsRef.current.rules, cards: settingsRef.current.cards, catalogue: settingsRef.current.catalogue });
      setRulesAtGeneration(current => current === priorRules ? JSON.stringify({ rules: next.rules, cards: next.cards, catalogue: next.catalogue }) : current);
      const translatedRows = rowsRef.current.map(row => ({ row, patch: { ...(row.design && artDirectionPair(next.requirements, next.requirementsEn, Boolean(row.design.traits.headRatio)).zh === row.design.requirements.zh ? { requirements: artDirectionPair(next.requirements, next.requirementsEn, Boolean(row.design.traits.headRatio)) } : {}), translations: CONFIG.flatMap(c => {
        const label = row.category[c.id], translatedTag = translated.find(value => value.dimension === c.id && value.label === label);
        const en = translatedTag?.en.trim() || row.translations?.find(value => value.dimension === c.id && value.label === label)?.en;
        return en ? [{ dimension: c.id, label, en }] : [];
      }) } }));
      setSettings(next); stateRef.current = { ...stateRef.current, settings: next }; setTranslationOpen(true);
      if (!await synchronize()) throw new Error('英文设置尚未确认保存，译文和草稿保留。');
      const translationCommands: FusionCommand[] = translatedRows.filter(({ row, patch }) => JSON.stringify(row.translations || []) !== JSON.stringify(patch.translations) || patch.requirements && JSON.stringify(row.design?.requirements) !== JSON.stringify(patch.requirements)).map(({ row, patch }) => ({ type: 'patchRow', rowId: row.id, expectedVersion: (row as FusionWorkspaceRow).version, patch }));
      for (let index = 0; index < translationCommands.length; index += 30) if (!await commit(translationCommands.slice(index, index + 30), '补齐结果英文')) throw new Error('部分结果英文保存未确认，已完成部分保留，请核对原操作。');
      const pendingDirections = Array.from(new Set(rows.filter(row => row.design && /[\u3400-\u9fff]/.test(row.design.requirements.en) && artDirectionPair(next.requirements, next.requirementsEn, Boolean(row.design.traits.headRatio)).zh !== row.design.requirements.zh).map(row => row.design!.requirements.zh)));
      for (let i = 0; i < pendingDirections.length; i++) {
        if (!activeRef.current || controller.signal.aborted) return;
        setNotice(`正在补齐已有结果的固定要求 ${i + 1}/${pendingDirections.length}；已完成部分会保留。`);
        const direction = pendingDirections[i], targets = rowsRef.current.filter(row => row.design?.requirements.zh === direction);
        const result = await fusionAssistant('Translate this art direction into equivalent English without adding constraints. Return JSON only: {"requirementsEn":"..."}.', [{ role: 'user', content: JSON.stringify({ requirements: direction }) }], controller.signal, apiModel) as { requirementsEn?: unknown };
        if (!activeRef.current || controller.signal.aborted) return;
        if (!result || typeof result.requirementsEn !== 'string' || !result.requirementsEn.trim() || result.requirementsEn.length > 10000 || /[\u3400-\u9fff]/.test(result.requirementsEn)) throw new Error('已有结果的部分英文未补齐，已完成译文与原输入保留，可主动重试。');
        const en = result.requirementsEn;
        const commands: FusionCommand[] = targets.map(row => ({ type: 'patchRow', rowId: row.id, expectedVersion: (row as FusionWorkspaceRow).version, patch: { requirements: artDirectionPair(direction, en, Boolean(row.design?.traits.headRatio)) } }));
        for (let index = 0; index < commands.length; index += 30) if (!await commit(commands.slice(index, index + 30), '补齐结果英文')) throw new Error('已有结果的英文保存未确认，已完成部分保留，请核对原操作。');
      }
      setNotice('英文补齐结果已展开。清单当前预览与复制语言：' + LANGUAGE_LABELS[next.lang] + '。');
      requestAnimationFrame(() => { if (activeRef.current) translationResult.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    } catch (e) { if (!controller.signal.aborted && activeRef.current) setError(e instanceof Error ? e.message : '英文未补齐，原输入保留。'); }
    finally { if (!controller.signal.aborted && activeRef.current) setTranslating(false); }
  };
  const copyBody = () => run(() => {
    const row = bossRow(settings, rows), traits = TRAITS.filter(t => t.group === 'body' && row.design?.traits[t.id]);
    const cn = traits.map(t => `${t.title}：${row.design!.traits[t.id].map(v => v.zh).join('、')}`).join(' × ');
    const en = traits.map(t => `${t.en}: ${row.design!.traits[t.id].map(v => v.en).join(', ')}`).join(' × ');
    if (!cn) throw new Error('请先选取或启用身形属性。');
    void copy(settings.lang === 'zh' ? cn : settings.lang === 'en' ? en : cn + '\n\n[ENGLISH]\n' + en);
  });
  const missing = rows.length ? missingRequired(settings, rows) : [];
  const outputLanguage = LANGUAGE_LABELS[settings.lang];
  const translatedTags = [
    ...CONFIG.flatMap(c => settings.rules[c.id].flatMap(tag => tag.en ? [{ dimension: c.title, label: tag.label, en: tag.en }] : [])),
    ...rows.flatMap(row => (row.translations || []).map(tag => ({ dimension: CONFIG.find(c => c.id === tag.dimension)?.title || tag.dimension, label: tag.label, en: tag.en }))),
  ].filter((tag, i, tags) => tags.findIndex(t => t.dimension === tag.dimension && t.label === tag.label) === i);
  const modelOptions = apiModels.filter(model => modelAvailability.isAvailable('text', model.id));
  const modelReady = modelOptions.some(model => model.id === apiModel);
  const generationProblem = validateGeneration(settings);
  const missingCore = CORE.filter(c => !settings.bossDimensions.includes(c.id));
  const manualReady = !missingCore.length && settings.bossDimensions.every(id => allowed(settings, id).includes(settings.boss[id]) || ADDONS.some(c => c.id === id) && settings.boss[id] === '') && settings.cards.filter(c => c.joined).every(c => !c.locked || cardValues(c).length > 0 && cardValues(c).every(value => c.tags.some(t => t.label === value && t.status !== 'exclude')));
  const needsEnglish = missingEnglish(settings) || rows.some(row => textFor(row, { ...settings, lang: 'en' }).includes('英文尚待补齐'));
  const canWrite = CHARACTER_FUSION_WRITES_ENABLED && Boolean(workspace && !workspace.archived) && !loadingDocument && !savingDocument && !pendingOperation;
  const modelStatus = modelError || modelAvailability.reason || (!loadingModels && !modelReady ? '请选择已开放的 API 模型，当前选择和输入已保留。' : '');
  if (!active) return <main className={styles.page}><p role="status">正在确认当前账号…</p></main>;
  return <main className={styles.page}>
    <header className={styles.header}><h1>角色融合提示词</h1></header>
    <div className={styles.toolbar}><div className={styles.tabs} aria-label="角色融合工作区"><button aria-pressed={view === 'workspace'} onClick={() => { setView('workspace'); setForm(null); }}>融合工作台</button><button aria-pressed={view === 'library'} onClick={() => { setView('library'); setForm(null); }}>词库管理</button><button aria-pressed={view === 'recipes'} onClick={() => { setView('recipes'); setForm(null); }}>我的配方</button></div><div className={styles.toolbarActions}><button disabled={busy} onClick={() => setForm({ action: 'save', id: crypto.randomUUID(), name: '角色融合配方' })}><Save size={16} />保存规则配方</button><details ref={modelSettings} className={styles.pageSettings} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>页面设置</summary><div className={styles.settingsPanel}><div className={styles.modelPicker}><label htmlFor="fusion-api-model">API 模型</label><select id="fusion-api-model" value={modelReady ? apiModel : ''} title={modelReady ? apiModel : undefined} onChange={e => setApiModel(e.target.value)}><option value="" disabled>{loadingModels && !apiModels.length ? '正在读取模型…' : '请选择已开放模型'}</option>{modelOptions.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}</select><button type="button" disabled={loadingModels} aria-busy={loadingModels} onClick={() => { void loadModels(true); void modelAvailability.refresh(); }}><RefreshCw size={15} />{loadingModels ? '更新中…' : '更新'}</button></div><small>用于创作助手、对话新增卡片和补齐英文，选择后自动记住。</small>{modelStatus && <p role={modelError ? 'alert' : 'status'} className={styles.hint}>{modelStatus}</p>}</div></details></div></div>
    <section className={styles.documentBar} aria-label="本人工作文档">
      <div className={styles.documentIdentity}><strong>{workspace?.name || '浏览器创作现场'}</strong><small role="status">{loadingDocument ? documentTransition.current === 'create' ? '正在新建文档…' : '正在继续文档…' : savingDocument ? '正在保存…' : pendingOperation ? '操作待核对，草稿保留' : syncError ? '未同步，草稿保留' : workspace ? workspace.archived ? '已归档，只读' : stateCommands(workspace.state, stateRef.current).length ? '有未同步修改' : '已保存到本人账号' : '尚未保存到账号'}</small></div>
      <div className={styles.actions}>{workspace && <button disabled={savingDocument || Boolean(pendingOperation) || !CHARACTER_FUSION_WRITES_ENABLED || workspace.archived} onClick={() => { syncBlocked.current = false; void synchronize(); }}>保存现场</button>}<button disabled={loadingDocument || savingDocument || !CHARACTER_FUSION_WRITES_ENABLED || Boolean(pendingOperation) || Boolean(pendingCreation)} onClick={() => void createDocument(!workspace)}> {workspace ? '新建文档' : '保存并继续当前现场'}</button><details ref={documentList} className={styles.documentList}><summary>查找与继续</summary><div><label>查找本人文档<input value={documentQuery} onChange={event => setDocumentQuery(event.target.value)} placeholder="搜索名称" /></label><label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />查看已归档</label>{documents.map(document => <div className={styles.libraryLine} key={document.id}><span className={styles.documentEntry}><strong>{document.name}{document.archived ? ' · 已归档' : ''}</strong><RelativeTime value={document.updatedAt} /></span><button disabled={document.id === workspace?.id || loadingDocument || savingDocument || Boolean(pendingOperation)} onClick={() => void loadDocument(document.id)}>{document.id === workspace?.id ? '当前文档' : '继续'}</button></div>)}{!documents.length && <p className={styles.hint}>没有匹配文档，当前浏览器现场仍保留。</p>}</div></details>{workspace && <details className={styles.documentList}><summary>文档管理</summary><div><label>文档名称<input maxLength={60} value={documentName} onChange={event => setDocumentName(event.target.value)} /></label><button disabled={!canWrite || !documentName.trim() || documentName === workspace.name} onClick={() => void execute([{ type: 'rename', name: documentName, expected: workspace.name }], '文档改名')}>保存名称</button><button disabled={savingDocument || Boolean(pendingOperation) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => { if (workspace.archived) { void commit([{ type: 'archive', archived: false, expected: true }], '恢复文档'); } else void execute([{ type: 'archive', archived: true, expected: false }], '归档文档'); }}>{workspace.archived ? '恢复文档' : '归档，可恢复'}</button></div></details>}</div>
    </section>
    {legacyDraft && <p className={styles.hint}>原浏览器现场仍保留。{workspace ? <button disabled={loadingDocument || savingDocument || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void createDocument(true)}>承接原浏览器现场为新文档</button> : '点击“保存并继续当前现场”后，才承接到本人工作文档。'}</p>}
    {pendingCreation && <p className={styles.hint}>新文档创建结果待确认，原编号与草稿保留。<button disabled={loadingDocument || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void createDocument(pendingCreation.carry, pendingCreation)}>按原编号继续创建</button></p>}
    {!CHARACTER_FUSION_WRITES_ENABLED && <p className={styles.hint}>当前为只读，可查看目录、恢复现场与复制导出。新写入暂不可用，浏览器草稿保留。</p>}
    {syncError && <p className={styles.error} role="alert">{syncError}{workspace && !pendingOperation && <button onClick={() => void loadDocument(workspace.id, true)}>读取远端并核对</button>}</p>}
    {conflicts.length > 0 && <details className={styles.conflictDetails}><summary>查看 {conflicts.length} 处差异，当前草稿保留</summary>{conflicts.map((conflict, index) => <div key={index}><strong>{conflict.path.join(' / ')}</strong><label>当前草稿<pre>{JSON.stringify(conflict.draft, null, 2)}</pre></label><label>远端内容<pre>{JSON.stringify(conflict.remote, null, 2)}</pre></label></div>)}</details>}
    {pendingOperation && <div className={styles.actions}><small>操作结果待确认</small><details><summary>操作详情</summary><small>{pendingOperation.opId}</small></details><button disabled={savingDocument} onClick={() => void checkPending()}>核对原操作</button><button disabled={savingDocument || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void commit(pendingOperation.commands, '', pendingOperation.acknowledged, pendingOperation)}>重试这次操作</button></div>}
    {view === 'recipes' && (error || notice) && <p role={error ? 'alert' : 'status'} className={error ? styles.error : styles.notice}>{error || notice}</p>}
    {form && <form className={styles.recipeForm} onSubmit={e => { e.preventDefault(); void saveRecipe(); }}><label>{form.action === 'save' ? '保存规则配方' : '配方改名'}<input autoFocus maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /><small>保存组合与规则，结果清单请单独导出。</small></label><button className={styles.primary} disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>取消</button></form>}
    <CreationChat key={workspace?.id || 'preparing'} ownerId={ownerId} workspaceId={workspace?.id || ''} documentName={workspace?.name || '当前创作'} messages={workspace?.state.messages || []} model={apiModel} modelReady={modelReady} active={active} preparing={loadingDocument || !workspace} disabled={!canWrite} onPrepare={async () => {
      const id = workspaceRef.current?.id;
      if (!id || documentTransition.current || pendingRef.current && !flight.current || !await synchronize()) return null;
      const current = workspaceRef.current;
      return current?.id === id ? { workspaceId: id, version: current.version } : null;
    }} onWorkspace={receipt => applyWorkspace(receipt)} onChooseModel={openModelSettings} onDrafts={drafts => { setAssistantDrafts(drafts); setNotice('助手建议仍为草稿，可在词库管理中预览入库。'); }} />
    {view === 'library' ? <LibraryManager ownerId={ownerId} admin={user?.role === 'admin'} active={active} catalogue={catalogue} cards={settings.cards} drafts={assistantDrafts} onCatalogue={useCatalogue} onJoin={joinTerm} onOpenCardChat={() => { setView('workspace'); setChatOpen(true); if (legacyCards.current) legacyCards.current.open = true; }} /> : view === 'recipes' ? <section className={styles.recipes}><div className={styles.sectionHead}><h2>我的配方</h2><span>仅本人可见，保存在账号中</span></div>
      {loadingRecipes ? <p role="status">正在读取配方…</p> : recipeError ? <p role="alert" className={styles.error}>{recipeError}<button onClick={() => setRecipeReload(n => n + 1)}>重新读取</button></p> : recipes.length ? recipes.map(recipe => <article className={styles.recipe} key={recipe.id}><div><h3>{recipe.name}</h3><p>{recipe.settings.count} 条 · {recipe.settings.lang === 'zh' ? '中文' : recipe.settings.lang === 'en' ? 'English' : '中英双语'} · {recipe.settings.bossDimensions.length + (recipe.settings.cards || []).filter(c => c.joined).length + Object.values(recipe.settings.catalogue?.traits || {}).filter(t => t.enabled).length} 个融合维度</p></div><div className={styles.actions}><button onClick={() => run(() => { setSettings(parseSettings(recipe.settings)); setView('workspace'); setNotice(`已套用「${recipe.name}」，已有提示词保留。`); })}>套用</button><button disabled={busy} onClick={() => setForm({ action: 'rename', id: recipe.id, name: recipe.name, revision: recipe.revision })}>改名</button><details className={styles.delete}><summary>删除</summary><p>删除「{recipe.name}」？</p><button disabled={busy} onClick={() => void deleteRecipe(recipe)}>确认删除</button></details></div></article>) : <p className={styles.empty}>还没有配方。设置好规则后，点“保存规则配方”。</p>}
    </section> : <>
      <section className={styles.creationContext} aria-label="本次创作想法"><details><summary>本次想法与创作摘要{idea || summary ? ' · 已填写' : ''}</summary><div className={styles.contextFields}><label>原始想法<textarea rows={3} maxLength={12000} value={idea} onChange={event => setIdea(event.target.value)} placeholder="保留原始想法和明确要求" /></label><label>本次摘要<textarea rows={3} maxLength={12000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="本次创作方向，可随时修改" /></label></div></details></section>
      <section className={styles.boss} aria-labelledby="boss-title" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('application/x-sd2-fusion-dimension'); if (id.startsWith('catalogue-')) setSettings(current => joinCatalogueCard(current, id) || current); else if (allCards.some(c => c.id === id)) addDimension(id); }}>
        <div className={styles.sectionHead}><h2 id="boss-title">当前组合与固定项</h2><details className={styles.utilities} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>组合操作</summary><div><button disabled={!settings.cards.some(card => card.joined && BODY_CARDS.some(preset => preset.id === card.id)) && !TRAITS.some(t => t.group === 'body' && settings.catalogue?.traits[t.id]?.enabled)} onClick={copyBody}><Copy size={16} />复制身形组合{outputLanguage}</button><button onClick={() => setSettings(s => refreshBoss(s))}><RefreshCw size={16} />随机刷新</button><button onClick={() => setSettings(s => ({ ...s, bossLocks: defaults().bossLocks, catalogue: { ...s.catalogue, ...(s.catalogue?.dynamic ? { dynamic: { ...s.catalogue.dynamic, selections: Object.fromEntries(Object.entries(s.catalogue.dynamic.selections).map(([id, value]) => [id, { ...value, locked: false }])) } } : {}), sourceFusion: s.catalogue?.sourceFusion ? { ...s.catalogue.sourceFusion, locked: false, values: [] } : undefined, details: Object.fromEntries(Object.entries(s.catalogue?.details || {}).map(([id, value]) => [id, value ? { ...value, locked: false } : value])), traits: Object.fromEntries(Object.entries(s.catalogue?.traits || {}).map(([id, value]) => [id, { ...value, locked: false }])) }, cards: s.cards.map(c => ({ ...c, locked: false })) }))}><UnlockKeyhole size={16} />全部解锁</button><button disabled={!canWrite || !manualReady || Boolean(generationProblem)} title={manualReady ? undefined : '请先为当前组合选择可用标签，并加入基础维度'} onClick={() => void execute([{ type: 'addCurrent', seed: Math.floor(Math.random() * 0x100000000) }], '加入当前组合')}><Plus size={16} />单独加入当前组合</button></div></details></div>
        <CatalogueEditor initialGroup={focusGroup} settings={settings} onChange={setSettings} view={catalogueView} onViewChange={setCatalogueView} />
        <details ref={legacyCards} className={styles.legacyRules}><summary>原有卡片与规则</summary>
        <label className={styles.roleSelect}>原角色定位<select value={settings.role} onChange={e => setSettings(s => ({ ...s, role: e.target.value }))}><option value="">不限定位</option>{['主角', '配角', '伙伴', '反派', 'Boss', '路人'].map(role => <option key={role}>{role}</option>)}</select></label>
        <div className={styles.ruleGrid}>{orderedIds.map(id => {
          const builtin = CONFIG.find(c => c.id === id), custom = cardCatalogue.find(c => c.id === id), bodyPreset = BODY_CARDS.some(c => c.id === id);
          const title = builtin?.title || custom!.title, tags = builtin ? settings.rules[builtin.id] : custom!.tags;
          const joined = builtin ? settings.bossDimensions.includes(builtin.id) : custom!.joined;
          return <RuleCard key={id} id={id} title={title} tags={tags} joined={joined} locked={builtin ? settings.bossLocks[builtin.id] || Boolean(settings.catalogue?.details[builtin.id]?.locked) : custom!.locked} expanded={expanded.includes(id)}
            selection={builtin ? <label className={styles.bossSelect}><span className={styles.srOnly}>精确选择{title}</span><select value={settings.boss[builtin.id]} onChange={e => setSettings(s => { const catalogue = s.catalogue || emptyCatalogue(), details = { ...catalogue.details }; delete details[builtin.id]; return { ...s, boss: { ...s.boss, [builtin.id]: e.target.value }, bossLocks: { ...s.bossLocks, [builtin.id]: true }, catalogue: { ...catalogue, details } }; })}>{ADDONS.some(c => c.id === id) && <option value="">本轮不使用</option>}{settings.boss[builtin.id] && !allowed(settings, builtin.id).includes(settings.boss[builtin.id]) && <option value={settings.boss[builtin.id]} disabled>{settings.boss[builtin.id]}（不可用）</option>}{!allowed(settings, builtin.id).length && CORE.some(c => c.id === id) && <option value="">没有可用标签</option>}{allowed(settings, builtin.id).map(label => <option key={label}>{label}</option>)}</select></label> : custom!.multi ? <button type="button" className={styles.catalogueChoice} aria-expanded={expanded.includes(id)} onClick={() => setExpanded(list => list.includes(id) ? list.filter(value => value !== id) : [...list, id])}>{custom!.locked ? `${cardValues(custom!).slice(0, 2).join("、")}${cardValues(custom!).length > 2 ? ` +${cardValues(custom!).length - 2}` : ""} · ${cardValues(custom!).length}项` : "随机1–3项"}</button> : <label className={styles.bossSelect}><span className={styles.srOnly}>选择{title}</span><select value={custom!.value} onChange={e => changeCard(id, card => ({ ...card, value: e.target.value, locked: true }))}>{!custom!.tags.some(t => t.label === custom!.value && t.status !== 'exclude') && <option value={custom!.value} disabled>{custom!.value}（不可用）</option>}{custom!.tags.filter(t => t.status !== 'exclude').map(t => <option key={t.label}>{t.label}</option>)}</select></label>}
            onLock={() => builtin ? setSettings(s => toggleCategoryLock(s, builtin.id)) : changeCard(id, card => ({ ...card, locked: !card.locked }))}
            onCycle={builtin ? () => cycleBoss(builtin.id) : bodyPreset && !custom?.multi ? () => cycleBodyCard(id) : undefined} onToggle={() => setExpanded(list => list.includes(id) ? list.filter(v => v !== id) : [...list, id])}
            onJoin={() => builtin ? toggleDimension(builtin.id) : changeCard(id, card => ({ ...card, joined: !card.joined }))}
            onTag={(label, status) => builtin ? setTagStatus(builtin.id, label, status) : setCustomTagStatus(id, label, status)}
            onDrop={source => moveCard(source, id)} onMove={direction => moveBy(id, direction)}>
            {!builtin && <>
              <div className={styles.choiceMeta}><span>{custom!.multi ? '可多选，所选项共同生效' : '单选'}</span>{custom!.multi && <button type="button" onClick={() => changeCard(id, card => ({ ...card, locked: false }))}>随机1–3项</button>}{!bodyPreset && <label><input type="checkbox" checked={Boolean(custom!.multi)} onChange={event => changeCard(id, card => ({ ...card, multi: event.target.checked, values: event.target.checked ? [card.value] : undefined }))} />允许多选</label>}</div>
              {custom!.multi && <ChoicePills label={title} multi options={custom!.tags.filter(tag => tag.status !== 'exclude').map(tag => ({ label: tag.label }))} values={custom!.locked ? cardValues(custom!) : []} onSelect={label => changeCard(id, card => {
                const values = toggleChoice(card.locked ? cardValues(card) : [], label, { multi: true });
                return { ...card, multi: true, values, value: values[0] || card.value, joined: values.length > 0, locked: values.length > 0 };
              })} />}
            </>}
            {builtin && concreteOptions(builtin.id, settings.boss[builtin.id]).length > 0 && <label className={styles.concretePicker}><span>具体选项</span><select value={settings.catalogue?.details[builtin.id]?.locked ? settings.catalogue.details[builtin.id]!.value : ''} onChange={e => setSettings(s => {
              const catalogue = s.catalogue || emptyCatalogue(), details = { ...catalogue.details };
              if (e.target.value) details[builtin.id] = { value: e.target.value, locked: true }; else delete details[builtin.id];
              return { ...s, catalogue: { ...catalogue, details }, bossLocks: { ...s.bossLocks, [builtin.id]: true } };
            })}><option value="">类内随机</option>{concreteOptions(builtin.id, settings.boss[builtin.id]).map(option => <option key={option.zh}>{option.zh}</option>)}</select></label>}
            {builtin ? <form className={styles.addTag} onSubmit={e => { e.preventDefault(); addTag(builtin.id); }}><input aria-label={`自定义${title}标签`} placeholder="自定义标签" maxLength={30} value={tagInputs[builtin.id] || ''} onChange={e => setTagInputs(s => ({ ...s, [builtin.id]: e.target.value }))} /><button aria-label={`添加${title}标签`}><Plus size={16} /></button></form> : <div className={styles.cardTools}><button disabled={bodyPreset && !settings.cards.some(card => card.id === id)} onClick={() => { const card = custom!, index = settings.cards.indexOf(card); setUndo({ label: bodyPreset ? '身形卡片重置' : '卡片移除', restore: () => setSettings(current => ({ ...current, cards: [...current.cards.slice(0, index), card, ...current.cards.slice(index)] })) }); setSettings(s => ({ ...s, cards: s.cards.filter(c => c.id !== id) })); setNotice(bodyPreset ? '身形卡片已恢复默认并移出组合，已有提示词保留。' : '卡片已移除，已有提示词保留。'); }}>{bodyPreset ? '恢复默认并移出' : '移除此卡片'}</button></div>}
          </RuleCard>;
        })}</div>
        </details>
        <div className={`${styles.sectionHead} ${styles.ruleFooter}`}><div className={styles.actions}><button aria-expanded={chatOpen} onClick={() => setChatOpen(v => !v)}><Plus size={16} />增加卡片</button><details className={styles.utilities} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>规则操作</summary><div><button onClick={() => { const previous = settings; setUndo({ label: '规则重置', restore: () => setSettings(current => ({ ...current, rules: previous.rules, boss: previous.boss, bossLocks: previous.bossLocks })) }); setSettings(s => reconcile({ ...s, rules: defaults().rules })); setNotice('内置规则已重置，扩展卡片保留。'); }}>重置内置规则</button><button onClick={() => { const previousExpanded = expanded, previousOrder = cardOrder, previousCatalogueView = catalogueView; setUndo({ label: '布局重置', restore: () => { setExpanded(previousExpanded); setCardOrder(previousOrder); setCatalogueView(previousCatalogueView); } }); setExpanded([]); setCardOrder([]); setCatalogueView(current => ({ ...current, expanded: [], order: [] })); }}>恢复卡片布局</button></div></details></div></div>
        {chatOpen && <CardChat value={conversation} onChange={setConversation} onConfirm={confirmCard} onClose={() => setChatOpen(false)} model={apiModel} modelReady={modelReady} onChooseModel={openModelSettings} />}
      </section>
      <section className={styles.composer} aria-label="生成设置">
        <div className={styles.composerHead}>
          <div className={styles.requirementsHead}><button type="button" role="switch" aria-checked={settings.requirementsEnabled} aria-controls="fusion-requirements" className={styles.switch} onClick={() => setSettings(s => ({ ...s, requirementsEnabled: !s.requirementsEnabled }))}><span /> <span className={styles.srOnly}>启用全局固定要求</span></button><strong>全局固定要求</strong></div>
          <section className={styles.batchBar} aria-label="批量生成">
            <label className={styles.batchMode}><span className={styles.srOnly}>生成方式</span><select aria-label="批量生成方式" value={batchMode} onChange={e => setBatchMode(e.target.value as typeof batchMode)}><option value="replace">保留标记的结果</option><option value="append">追加到清单</option></select></label>
            <label><span className={styles.srOnly}>生成数量</span><select aria-label="生成数量" value={settings.count} onChange={e => setSettings(s => ({ ...s, count: Number(e.target.value) }))}>{COUNTS.map(n => <option value={n} key={n}>{n} 条</option>)}</select></label>
            <button className={styles.primary} disabled={!canWrite || Boolean(generationProblem)} aria-describedby={generationProblem ? 'fusion-generation-problem' : undefined} onClick={generate}>抽卡生成</button>
            {undo && <button disabled={Boolean(undo.remote) && !canWrite} className={styles.quietButton} onClick={() => { undo.restore(); setUndo(null); setError(''); }}><Undo2 size={15} />撤销{undo.label}</button>}
            {generationProblem && <div id="fusion-generation-problem" role="status" className={styles.batchFeedback}>{generationProblem}{missingCore.length > 0 && <button onClick={() => setSettings(s => ({ ...s, bossDimensions: Array.from(new Set([...s.bossDimensions, ...CORE.map(c => c.id)])) }))}>加入缺少的基础维度</button>}</div>}
            {(error || notice) && <p role={error ? 'alert' : 'status'} className={`${styles.batchFeedback} ${error ? styles.error : styles.notice}`}>{error || notice}</p>}
          </section>
        </div>
        {settings.requirementsEnabled && <div id="fusion-requirements"><label className={styles.requirements}><span className={styles.srOnly}>中文固定要求</span><textarea maxLength={6000} rows={3} value={settings.requirements} onChange={e => setSettings(s => ({ ...s, requirements: e.target.value, requirementsEn: '' }))} placeholder="填写画风、构图、材质与制作约束；比例优先使用身形设置…" /></label>{rows.length > 0 && <small>{rows.some(row => !row.design) ? '清单含旧版结果，其固定要求仍按原方式同步；新结果会保留生成时设定。' : '设置用于后续生成；已有结果可在“调整具体选项与属性”中单独修改。'}</small>}</div>}
      </section>
      <section className={styles.results} ref={resultsRef} aria-labelledby="results-title">
        <div className={styles.sectionHead}><h2 id="results-title">提示词清单 <small>{rows.length} 条{selected.length > 0 && ` · 已选 ${selected.length} 条`}</small></h2><div className={styles.actions}>
          <label className={styles.outputLanguage}><span className={styles.srOnly}>预览与复制语言</span><select aria-label="提示词预览与复制语言" value={settings.lang} onChange={e => setSettings(s => ({ ...s, lang: e.target.value as FusionSettings['lang'] }))}><option value="zh">中文</option><option value="en">英文 English</option><option value="both">中英双语</option></select></label>
          <button aria-expanded={translationOpen} aria-controls="fusion-translations" onClick={() => { setTranslationOpen(v => !v); }}>译文{(settings.requirementsEn || translatedTags.length > 0) && <span className={styles.translationDot} aria-label="已有译文" />}</button>
          {rows.length > 0 && <><button className={styles.primary} disabled={Boolean(exportProgress)} onClick={() => void copyDocument(selected.length > 0)}><Copy size={16} />{selected.length ? `复制所选 ${selected.length} 条` : '复制全部'}{outputLanguage}</button></>}
          <details className={styles.utilities} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; setClearConfirm(false); } }}><summary>导出与清单</summary><div>
            {rows.length > 0 && <button disabled={Boolean(exportProgress)} onClick={() => void selectAllRows()}>{selected.length && selected.length === (workspace ? rowsPage.total : rows.length) ? '取消全选' : '全选'}</button>}
            {selected.length > 0 && <button disabled={Boolean(exportProgress)} onClick={() => void copyDocument()}>复制全部 {workspace ? rowsPage.total : rows.length} 条{outputLanguage}</button>}
            <button disabled={!rows.length || Boolean(exportProgress)} onClick={() => void download('prompts')}><Download size={15} />导出完整纯{outputLanguage}提示词 TXT</button><button disabled={!rows.length || Boolean(exportProgress)} onClick={() => void download('txt')}>导出完整资料 TXT</button><button disabled={!rows.length || Boolean(exportProgress)} onClick={() => void download('csv')}>导出完整资料 CSV</button>
            <button disabled={!selected.length || Boolean(exportProgress)} onClick={() => void sendTo('/template-studio?type=image')}>复制并打开生图 ↗</button><button disabled={!selected.length || Boolean(exportProgress)} onClick={() => void sendTo('/tools/character-lab')}>复制并打开角色参考图 ↗</button>
            <small>出图入口会复制所选的{outputLanguage}提示词，请打开后粘贴；不会提交生成。</small>
            <small>资料含中文名称、维度和当前语言提示词。工作文档保存在本人账号，未同步修改仍保留在本标签页。</small>
            <button type="button" className={styles.clearButton} disabled={!rows.length || !canWrite} aria-label={clearConfirm ? '确认清除本次提示词清单' : '清除本次提示词清单'} onBlur={() => setClearConfirm(false)} onKeyDown={e => { if (e.key === 'Escape') setClearConfirm(false); }} onClick={e => { if (!clearConfirm) { e.currentTarget.focus(); setClearConfirm(true); return; } setClearConfirm(false); void execute([{ type: 'removeRows', rowIds: rows.map(row => row.id), expectedVersions: Object.fromEntries(rows.map(row => [row.id, (row as FusionWorkspaceRow).version])) }], '清除已显示清单'); }}><Trash2 size={15} />{clearConfirm ? `确认清除已显示 ${rows.length} 条` : '清除已显示清单'}</button>
          </div></details>
        </div></div>
        {exportProgress && <div className={styles.actions} role="status"><span>{exportProgress}</span><button type="button" onClick={() => exportController.current?.abort()}>取消读取</button></div>}
        {settings.lang !== 'zh' && needsEnglish && <div className={styles.translationNeeded} role="status"><span>自定义内容尚需英文，中文结果可继续使用。</span><button disabled={translating} onClick={() => void translate()}>{translating ? '正在补齐…' : modelReady ? '补齐英文' : '选择模型补齐'}</button></div>}
        <details id="fusion-translations" ref={translationResult} className={styles.englishEditor} open={translationOpen} onToggle={e => setTranslationOpen(e.currentTarget.open)}>
          <summary className={styles.srOnly}>英文设置与译文{(settings.requirementsEn || translatedTags.length > 0) && <small> · 已有译文</small>}</summary>
          <div className={styles.actions}><button disabled={translating} onClick={() => void translate()}>{translating ? '正在补齐…' : modelReady ? '补齐英文' : '选择模型补齐'}</button>{!modelReady && <small>英文补齐需要选择 API 模型。</small>}</div>
          {(settings.requirementsEnabled || settings.requirementsEn) && <label className={styles.requirements}>英文固定要求{!settings.requirementsEnabled && <small>固定要求未启用，不会带入提示词</small>}<textarea lang="en" aria-label="英文固定要求" maxLength={10000} rows={3} value={settings.requirementsEn} onChange={e => setSettings(s => ({ ...s, requirementsEn: e.target.value }))} placeholder="默认要求已有内置英文；自定义要求可补齐英文，也可在此填写。" /></label>}
          {translatedTags.length > 0 && <dl className={styles.translatedTags}>{translatedTags.map(tag => <div key={tag.dimension + ':' + tag.label}><dt>{tag.dimension} · {tag.label}</dt><dd lang="en">{tag.en}</dd></div>)}</dl>}
          {!settings.requirementsEn && !translatedTags.length && <p className={styles.languageNote}>内置内容已有英文，自定义内容补齐后在这里查看。</p>}
          {rows.length > 0 && <button type="button" onClick={() => { setSettings(s => ({ ...s, lang: 'en' })); showResults(); }}>查看英文提示词</button>}
        </details>
        {rows.length > 0 && rulesAtGeneration !== JSON.stringify({ rules: settings.rules, cards: settings.cards, catalogue: settings.catalogue }) && <p className={styles.hint}>规则已改，保留的组合不变；新候选使用当前规则。</p>}{missing.length > 0 && <p className={styles.hint}>本批尚未覆盖：{missing.join('、')}。</p>}
        {rows.length ? <><div className={styles.resultList}>{rows.map(row => <ResultRow key={row.id} row={row} settings={settings} checked={selected.includes(row.id)} retained={retained.includes(row.id)} writable={canWrite} onRetain={() => setRetained(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} onSelect={() => setSelected(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} onCopy={() => void copy(textFor(row, settings))} onLoadEdit={async () => { if (!workspace) return { settings: settingsForRow(settings, row), version: null, body: { zh: textFor(row, { ...settings, lang: 'zh' }), en: textFor(row, { ...settings, lang: 'en' }) } }; const data = await fusionRequest<{ rowSettings: { rowId: string; version: number; settings: FusionSettings; body: { zh: string; en: string } } }>(`${WORKSPACE_API}/${workspace.id}?rowId=${encodeURIComponent(row.id)}`); return data.rowSettings; }} onRewrite={() => void execute([{ type: 'changeRow', rowId: row.id, expectedVersion: (row as FusionWorkspaceRow).version, seed: Math.floor(Math.random() * 0x100000000) }], '随机重组')} onSwap={(dimension, value) => void execute([{ type: 'changeRow', rowId: row.id, dimension, value, expectedVersion: (row as FusionWorkspaceRow).version, seed: Math.floor(Math.random() * 0x100000000) }], '单项替换')} onEdit={(draft, expectedVersion) => execute([{ type: 'reviseRow', rowId: row.id, settings: draft, expectedVersion, seed: Math.floor(Math.random() * 0x100000000) }], '调整此条')} onDeep={() => void execute([{ type: 'patchRow', rowId: row.id, expectedVersion: (row as FusionWorkspaceRow).version, patch: { advanced: !row.advanced } }], '结构扩写')} />)}</div>{rowsPage.nextCursor && <button disabled={loadingDocument} onClick={() => void loadMoreRows()}>继续读取结果（已显示 {rows.length} / {rowsPage.total}）</button>}</> : <div className={styles.empty}><h3>先生成一批候选</h3><p>{workspace ? '可直接用默认规则，再挑选和调整。' : legacyDraft ? '先显式承接原浏览器现场，再继续抽卡。' : loadingDocument ? '正在准备本人工作文档，可继续调整设置。' : '本人工作文档尚未就绪，请从上方原操作继续；当前输入保留。'}</p></div>}

      </section>
    </>}
  </main>;
}

function ResultRow({ row, settings, checked, retained, writable, onRetain, onSelect, onCopy, onLoadEdit, onRewrite, onSwap, onDeep, onEdit }: {
  row: FusionRow; settings: FusionSettings; checked: boolean; retained: boolean; writable: boolean; onRetain: () => void; onSelect: () => void; onCopy: () => void;
  onLoadEdit: () => Promise<{ settings: FusionSettings; version: number | null; body: { zh: string; en: string } }>; onEdit: (draft: FusionSettings, expectedVersion: number) => Promise<boolean>; onRewrite: () => void; onSwap: (dimension: Dimension, value: string) => void; onDeep: () => void;
}) {
  const [dimension, setDimension] = useState<Dimension>('source'), [value, setValue] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false), [editError, setEditError] = useState('');
  const [editOpen, setEditOpen] = useState(false), [editSettings, setEditSettings] = useState<FusionSettings | null>(null);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [editComparison, setEditComparison] = useState<{ version: number; body: { zh: string; en: string } } | null>(null);
  const options = allowed(settings, dimension);
  const previewLanguages: Array<'zh' | 'en'> = settings.lang === 'both' ? ['zh', 'en'] : [settings.lang];
  const englishReady = !textFor(row, { ...settings, lang: 'en' }).includes('英文尚待补齐');
  const excludedCount = CONFIG.filter(c => row.category[c.id] && settings.rules[c.id].some(t => t.label === row.category[c.id] && t.status === 'exclude')).length
    + (row.cards || []).filter(c => settings.cards.find(card => card.id === c.id)?.tags.some(t => t.label === c.label && t.status === 'exclude')).length;
  return <article className={`${styles.resultRow} ${checked ? styles.selected : ''}`}>
    <div className={styles.resultHeading}><label><input type="checkbox" checked={checked} onChange={onSelect} aria-label={`选择${row.name}`} /><strong>{row.name}</strong></label><button type="button" aria-pressed={retained} onClick={onRetain}>{retained ? '已保留，重抽时不替换' : '重抽时保留'}</button></div>
    <div className={styles.promptBody}><div className={styles.languagePreviews}>{previewLanguages.map(language => <div key={language}>{settings.lang === 'both' && <small>{LANGUAGE_LABELS[language]}</small>}<p lang={language === 'en' ? 'en' : 'zh-CN'} className={styles.promptExcerpt}>{textFor(row, { ...settings, lang: language })}</p></div>)}</div><details className={styles.prompt}><summary>展开全文</summary><p>{textFor(row, settings)}</p></details></div>
    <div className={styles.rowActions}><button onClick={onCopy}><Copy size={15} />复制{LANGUAGE_LABELS[settings.lang]}</button><details className={styles.advanced} onToggle={e => { if (!e.currentTarget.open) setSwapOpen(false); }}><summary>调整与详情</summary>
      <dl className={styles.metadata}><div><dt>母体</dt><dd>{row.source.name}</dd></div><div><dt>跨界概念</dt><dd>{row.concept.name}</dd></div><div className={styles.bridge}><dt>连接点 / 机制</dt><dd>{row.bridge}</dd></div>{row.cards?.map(c => <div key={c.id}><dt>{c.title}</dt><dd>{c.label}</dd></div>)}{TRAITS.filter(t => row.design?.traits[t.id]).map(t => <div key={t.id}><dt>{t.title}</dt><dd>{row.design!.traits[t.id].map(v => v.zh).join('、')}</dd></div>)}</dl>
      {(row.role || row.category.personality) && <p>{[row.role, row.category.personality].filter(Boolean).join(' · ')}</p>}
      <div className={styles.actions}><button aria-expanded={swapOpen} onClick={() => { setSwapOpen(v => !v); setValue(options[0] || ''); }}><RefreshCw size={15} />只换一项</button><button disabled={loadingEdit} onClick={() => { setLoadingEdit(true); setEditError(''); void onLoadEdit().then(draft => { setEditSettings(draft.settings); setEditVersion(draft.version); setEditComparison(null); setEditOpen(true); }).catch(e => setEditError(e instanceof Error ? e.message : '原结果设置读取失败，当前内容保留。')).finally(() => setLoadingEdit(false)); }}>{loadingEdit ? '读取原设置…' : '调整具体选项与属性'}</button><button disabled={!writable} onClick={onRewrite}>随机重组</button><button disabled={!writable} onClick={onDeep}>{row.advanced ? '恢复基础提示词' : '扩写三阶段结构'}</button></div>
      <dl className={styles.ruleChecks}><div><dt>英文</dt><dd>{englishReady ? '可复制' : '待补齐'}</dd></div><div><dt>当前排除规则</dt><dd>{excludedCount ? `${excludedCount} 项冲突` : '无冲突'}</dd></div><div><dt>扩写状态</dt><dd>{row.advanced ? '收纳 / 启动 / 释放三阶段' : '基础提示词'}</dd></div></dl>
      <p className={styles.dimensionSummary}>{CONFIG.filter(c => row.category[c.id]).map(c => `${c.title}：${row.category[c.id]}`).join(' · ')}</p>
    </details></div>
    {editError && <p className={styles.error} role="alert">{editError}</p>}
    {editOpen && editSettings && <section aria-label={`调整${row.name}`}><CatalogueEditor settings={editSettings} onChange={setEditSettings} /><div className={styles.actions}><button className={styles.primary} disabled={!writable || editVersion === null || loadingEdit} onClick={() => { if (editVersion === null) return; setEditError(''); void onEdit(editSettings, editVersion).then(ok => { if (ok) setEditOpen(false); else setEditError('保存尚未确认，编辑草稿已保留。请核对当前结果或原操作；若此条已更新，可核对新版本后继续使用草稿。'); }); }}>应用到此条</button><button onClick={() => setEditOpen(false)}>取消</button></div>
      {(editError || editComparison) && <div className={styles.cardPreview}><button disabled={loadingEdit} onClick={() => { setLoadingEdit(true); void onLoadEdit().then(current => { if (current.version === null) return; setEditComparison({ version: current.version, body: current.body }); }).catch(e => setEditError(e instanceof Error ? e.message : '当前结果读取失败，编辑草稿保留。')).finally(() => setLoadingEdit(false)); }}>{loadingEdit ? '正在读取当前结果…' : '核对新版本，保留草稿'}</button>{editComparison && <><p>以下是刚读取的当前结果；上方编辑草稿保持不变。</p>{previewLanguages.map(language => <p key={language} lang={language === 'en' ? 'en' : 'zh-CN'}>{editComparison.body[language]}</p>)}<button disabled={editVersion === editComparison.version} onClick={() => { setEditVersion(editComparison.version); setEditError(''); }}>{editVersion === editComparison.version ? '已核对，草稿尚未应用' : '已核对，以新版本继续编辑'}</button></>}</div>}
    </section>}
    {swapOpen && <form className={styles.swapForm} onSubmit={e => { e.preventDefault(); onSwap(dimension, value); }}><label>维度<select value={dimension} onChange={e => { const id = e.target.value as Dimension; setDimension(id); setValue(allowed(settings, id)[0] || ''); }}>{CONFIG.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>替换为<select value={value} onChange={e => setValue(e.target.value)}>{ADDONS.some(c => c.id === dimension) && <option value="">本轮不使用</option>}{options.map(option => <option key={option}>{option}</option>)}</select></label><button disabled={!writable}>应用替换</button></form>}
  </article>;
}
