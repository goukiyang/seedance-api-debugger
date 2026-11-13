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
import { newCreationState, preparationFingerprint, settingsFingerprint, type FusionCommand, type FusionWorkspaceState, type FusionWorkspaceRow } from '@/lib/character-fusion/actions';
import { applyFusionSettingChanges, effectiveFusionSettings, fusionSettingsChanges, preparationForManualChange } from '@/lib/character-fusion/configuration';
import type { FusionPreparation } from '@/lib/character-fusion/domain';
import LibraryManager from './library-manager';
import CreationChat from './creation-chat';
import { WORKSPACE_API, FusionRequestError, fusionRequest, postFusion, lookupOperation, stateCommands, workspaceConflicts, mergeWorkspaceState, mergeWorkspaceRows, type FusionWorkspace, type WorkspaceReceipt, type RowsPage, type CreationContinuation, type CreationTarget, type OperationLookup } from './workspace-client';
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
type WorkspaceListItem = FusionWorkspace & { direction?: string; rowCount?: number; batchCount?: number };

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
  const [baseSettings, setBaseSettings] = useState<FusionSettings>(defaults);
  const [preparation, setPreparation] = useState<FusionPreparation | undefined>();
  const preparationRef = useRef(preparation); preparationRef.current = preparation;
  const [rowSettings, setRowSettings] = useState<{ rowId: string; version: number; settings: FusionSettings } | null>(null);
  const rowSettingsRef = useRef(rowSettings); rowSettingsRef.current = rowSettings;
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'conditions' | 'results'>('conditions');
  const [savingInline, setSavingInline] = useState<{ opId: string; workspaceId: string; cardId: string } | null>(null);
  const [rows, setRows] = useState<FusionRow[]>([]);
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const modelSettings = useRef<HTMLDetailsElement>(null);
  const legacyCards = useRef<HTMLDetailsElement>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [retained, setRetained] = useState<string[]>([]);
  const [idea, setIdea] = useState(''), [summary, setSummary] = useState('');
  const [catalogue, setCatalogue] = useState<FusionCatalogue>(builtinCatalogue);
  const documentSettings = effectiveFusionSettings(baseSettings, preparation?.batch, catalogue);
  const settings = rowSettings && preparation?.row?.rowId === rowSettings.rowId && preparation.row.version === rowSettings.version ? applyFusionSettingChanges(rowSettings.settings, preparation.row.changes, catalogue) : documentSettings;
  const [workspace, setWorkspace] = useState<FusionWorkspace | null>(null), [documents, setDocuments] = useState<WorkspaceListItem[]>([]);
  const [documentQuery, setDocumentQuery] = useState(''), [showArchived, setShowArchived] = useState(false), [documentName, setDocumentName] = useState('');
  const [pendingCreation, setPendingCreation] = useState<{ opId: string; name: string; carry: boolean; mode?: 'fresh' | 'inherit'; automatic?: boolean; baseState?: FusionWorkspaceState; state?: FusionWorkspaceState } | null>(null);
  const initialDocument = useRef(false);
  const documentTransition = useRef<'create' | 'load' | null>(null), documentList = useRef<HTMLDetailsElement>(null);
  const [loadingDocument, setLoadingDocument] = useState(false), [savingDocument, setSavingDocument] = useState(false), [syncError, setSyncError] = useState('');
  const [conflicts, setConflicts] = useState<Array<{ path: string[]; draft: unknown; remote: unknown }>>([]);
  const [legacyDraft, setLegacyDraft] = useState(false), [assistantDrafts, setAssistantDrafts] = useState<unknown[]>([]);
  const [assistantContinuation, setAssistantContinuation] = useState<CreationContinuation | undefined>();
  const [completedPlanId, setCompletedPlanId] = useState(''), [completedPlanReply, setCompletedPlanReply] = useState('');
  const [chatTarget, setChatTarget] = useState<CreationTarget | null>(null), [chatActive, setChatActive] = useState(false);
  const chatActivityRef = useRef(false);
  const onChatActivity = useCallback((value: boolean) => { chatActivityRef.current = value; setChatActive(value); }, []);
  const workbenchRef = useRef<HTMLDivElement>(null), workspaceScroll = useRef<HTMLDivElement>(null);
  const [rowsPage, setRowsPage] = useState<RowsPage>({ nextCursor: null, total: 0 });
  const [pendingOperation, setPendingOperation] = useState<{ workspaceId: string; opId: string; baseVersion: number; commands: FusionCommand[]; acknowledged?: FusionWorkspaceState } | null>(null);
  const workspaceRef = useRef<FusionWorkspace | null>(null), rowsRef = useRef<FusionRow[]>([]), savedDraftRef = useRef<Record<string, unknown> | null>(null);
  const stateRef = useRef<FusionWorkspaceState>({ settings: baseSettings, idea: '', summary: '', messages: [], selectedIds: [], retainedIds: [] });
  stateRef.current = { ...stateRef.current, ...(workspace?.state ? { formatVersion: workspace.state.formatVersion ?? stateRef.current.formatVersion, intent: workspace.state.intent ?? stateRef.current.intent, summaryMeta: workspace.state.summaryMeta ?? stateRef.current.summaryMeta, identity: workspace.state.identity ?? stateRef.current.identity } : {}), settings: baseSettings, preparation, idea, summary, messages: workspace?.state.messages || [], selectedIds: selected, retainedIds: retained }; rowsRef.current = rows;
  const updatePreparation = (next: FusionPreparation | undefined) => { preparationRef.current = next; stateRef.current = { ...stateRef.current, preparation: next }; setPreparation(next); };
  const setSettings = (value: FusionSettings | ((current: FusionSettings) => FusionSettings)) => {
    const state = stateRef.current, pending = preparationRef.current, row = rowSettingsRef.current;
    if (pending?.row && (!row || row.rowId !== pending.row.rowId || row.version !== pending.row.version)) { setError('请先核对这条方案的原条件，当前调整草稿保留。'); return; }
    const visible = row && pending?.row?.rowId === row.rowId ? applyFusionSettingChanges(row.settings, pending.row.changes, catalogue) : effectiveFusionSettings(state.settings, pending?.batch, catalogue);
    const next = typeof value === 'function' ? value(visible) : value;
    if (row && pending?.row?.rowId === row.rowId) updatePreparation({ ...pending, formatVersion: 1, row: { rowId: row.rowId, version: pending.row.version, changes: fusionSettingsChanges(row.settings, next) } });
    else if (pending?.batch) updatePreparation(preparationForManualChange(state.settings, next, pending));
    else { stateRef.current = { ...state, settings: next }; setBaseSettings(next); }
  };
  const flight = useRef<Promise<boolean> | null>(null), pendingRef = useRef(pendingOperation); pendingRef.current = pendingOperation;
  const syncBlocked = useRef(false);
  const [view, setView] = useState<'workspace' | 'recipes' | 'library'>('workspace');
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [recentResultIds, setRecentResultIds] = useState<string[]>([]);
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
        setBaseSettings(restored); if (saved.preparation) { setPreparation(saved.preparation); preparationRef.current = saved.preparation; }
        setTranslationOpen(Boolean(restored.requirementsEn) || Object.values(restored.rules).some(tags => tags.some(tag => tag.en)));
        if (Array.isArray(saved.rows)) { setRows(saved.rows); if (Array.isArray(saved.selected)) setSelected(saved.selected.filter((id: unknown) => typeof id === 'string' && saved.rows.some((row: FusionRow) => row.id === id))); setRetained((Array.isArray(saved.retained) ? saved.retained : saved.selected || []).filter((id: unknown) => typeof id === 'string' && saved.rows.some((row: FusionRow) => row.id === id))); }
        setRulesAtGeneration(saved.rulesAtGeneration || '');
        if (saved.conversation?.messages?.length <= 38 && typeof saved.conversation.input === 'string') setConversation({ ...saved.conversation, draft: saved.conversation.draft ? parseCardDraft(saved.conversation.draft) : null });
      }
      const ui = JSON.parse(localStorage.getItem(storageKey + ':ui') || '{}');
      if (Array.isArray(ui.expanded)) setExpanded(ui.expanded.filter((id: unknown) => typeof id === 'string'));
      if (Array.isArray(ui.cardOrder)) setCardOrder(ui.cardOrder.filter((id: unknown) => typeof id === 'string'));
      if (typeof ui.apiModel === 'string') setApiModel(ui.apiModel);
      if (ui.catalogueView?.presentation === 'cards' || ui.catalogueView?.presentation === 'groups') setCatalogueView({ presentation: ui.catalogueView.presentation, expanded: Array.isArray(ui.catalogueView.expanded) ? ui.catalogueView.expanded.filter((id: unknown) => typeof id === 'string') : [], order: Array.from(new Set([...(Array.isArray(ui.catalogueView.order) ? ui.catalogueView.order.filter((id: unknown) => typeof id === 'string') : []), ...(Array.isArray(ui.cardOrder) ? ui.cardOrder.filter((id: unknown) => typeof id === 'string').map((id: string) => CONFIG.some(config => config.id === id) ? `catalogue-${id}` : `inline-${id}`) : [])])) });
    } catch { setNotice('未能恢复本页临时现场，账号配方仍可在“我的配方”读取。'); }
    setDraftReady(true);
  }, [active, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    try { const draft = { settings: baseSettings, preparation, rows, selected, retained, idea, summary, workspaceId: workspace?.id, remoteBase: workspace?.state, pendingOperation, rulesAtGeneration, conversation, chatTarget, scrollTop: workspaceScroll.current?.scrollTop || 0 }; sessionStorage.setItem(workspace ? storageKey + ':doc:' + workspace.id : storageKey, JSON.stringify(draft)); if (!workspace) savedDraftRef.current = draft; } catch { /* Explicit server recipes remain available without tab storage. */ }
  }, [active, draftReady, baseSettings, preparation, rows, selected, retained, idea, summary, workspace, pendingOperation, rulesAtGeneration, conversation, chatTarget, storageKey]);
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
    const nextRows = mergeWorkspaceRows(rowsRef.current, receipt, replace, appendPage, previous?.version);
    workspaceRef.current = receipt.workspace; stateRef.current = nextState; rowsRef.current = nextRows;
    setWorkspace(receipt.workspace); setBaseSettings(nextState.settings); setPreparation(nextState.preparation); preparationRef.current = nextState.preparation; setIdea(nextState.idea); setSummary(nextState.summary); setSelected(nextState.selectedIds); setRetained(nextState.retainedIds); setRows(nextRows); setDocumentName(receipt.workspace.name);
    if (receipt.rowsPage) setRowsPage(receipt.rowsPage);
    if (!nextState.preparation?.row) { setChatTarget(null); setRowSettings(null); }
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
      if (label) setRecentResultIds(receipt.operation.effects?.addedIds || []);
      if (label) setNotice(`${label}已保存${receipt.operation.effects?.addedIds.length ? `，新增${receipt.operation.effects.addedIds.length}条` : ''}。`); return true;
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
    if (savingDocument || pendingRef.current || savingInline || chatActivityRef.current) { setSyncError('当前操作正在保存、处理或待核对，请稍后继续。'); return false; }
    if (!await synchronize()) return false;
    return commit(commands, label);
  };
  const loadDocument = async (id: string, initial = false) => {
    if (!activeRef.current || documentTransition.current || savingInline || chatActivityRef.current) return;
    documentTransition.current = 'load'; setLoadingDocument(true); setSyncError(''); syncBlocked.current = false; setConflicts([]);
    try {
      if (!initial && workspaceRef.current && !await synchronize()) return;
      const data = await fusionRequest<{ workspace: FusionWorkspace; rowsPage?: RowsPage; nextCursor?: string | null; total?: number }>(`${WORKSPACE_API}/${encodeURIComponent(id)}`);
      if (!activeRef.current) return;
      let draft = savedDraftRef.current; try { draft = JSON.parse(sessionStorage.getItem(storageKey + ':doc:' + id) || 'null') || draft; } catch { /* Existing draft remains in memory. */ }
      const beforeLoad = stateRef.current, previousDoc = workspaceRef.current;
      applyWorkspace({ workspace: data.workspace, rowsPage: data.rowsPage || { nextCursor: data.nextCursor || null, total: data.total || data.workspace.rows.length } }, true);
      if (initial && previousDoc?.id === id) { const restored = mergeWorkspaceState(previousDoc.state, beforeLoad, data.workspace.state); stateRef.current = restored; setBaseSettings(restored.settings); setPreparation(restored.preparation); preparationRef.current = restored.preparation; setIdea(restored.idea); setSummary(restored.summary); setSelected(restored.selectedIds); setRetained(restored.retainedIds); const detected = workspaceConflicts(previousDoc.state, beforeLoad, data.workspace.state); setConflicts(detected); syncBlocked.current = true; setSyncError('已读取远端，未同步草稿保留。请核对后点击保存现场。'); }
      else if (draft?.workspaceId === id && draft.remoteBase) {
        const savedState: FusionWorkspaceState = { ...data.workspace.state, preparation: draft.preparation as FusionPreparation | undefined, settings: parseSettings(draft.settings), idea: typeof draft.idea === 'string' ? draft.idea : '', summary: typeof draft.summary === 'string' ? draft.summary : '', messages: data.workspace.state.messages, selectedIds: Array.isArray(draft.selected) ? draft.selected as string[] : [], retainedIds: Array.isArray(draft.retained) ? draft.retained as string[] : [] };
        const restored = mergeWorkspaceState(draft.remoteBase as FusionWorkspaceState, savedState, data.workspace.state); const detected = workspaceConflicts(draft.remoteBase as FusionWorkspaceState, savedState, data.workspace.state); setConflicts(detected); if (detected.length) { syncBlocked.current = true; setSyncError('已恢复浏览器草稿，远端有同字段修改。请核对差异后保存。'); }
        stateRef.current = restored; setBaseSettings(restored.settings); setPreparation(restored.preparation); preparationRef.current = restored.preparation; setIdea(restored.idea); setSummary(restored.summary); setSelected(restored.selectedIds); setRetained(restored.retainedIds);
      }
      setRowSettings(null); setChatTarget(null);
      if (draft?.pendingOperation && (draft.pendingOperation as { workspaceId?: string }).workspaceId === id) { pendingRef.current = draft.pendingOperation as NonNullable<typeof pendingOperation>; setPendingOperation(pendingRef.current); } else { pendingRef.current = null; setPendingOperation(null); }
      setNotice(''); setAssistantDrafts([]); setAssistantContinuation(undefined); setRecentResultIds([]); setView('workspace'); requestAnimationFrame(() => { if (!workspaceScroll.current) return; let position = draft?.workspaceId === id && typeof draft.scrollTop === 'number' ? draft.scrollTop : 0; try { const saved = sessionStorage.getItem(storageKey + ':position:' + id); if (saved !== null && Number.isFinite(Number(saved))) position = Number(saved); } catch { /* The saved draft position remains usable. */ } workspaceScroll.current.scrollTop = position; }); setUndo(null); if (documentList.current) documentList.current.open = false;
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
    else if (!oldDraft) void fusionRequest<{ workspaces: WorkspaceListItem[] }>(`${WORKSPACE_API}?limit=1&archived=0`).then(data => { if (!cancelled && activeRef.current) { if (data.workspaces[0]) void loadDocument(data.workspaces[0].id, true); else setNotice('点击“新创作”开始，或从“继续创作”打开已有文档。'); } }).catch(e => { if (!cancelled && activeRef.current) setSyncError(e instanceof Error ? e.message : '最近文档暂时无法读取。'); });
    return () => { cancelled = true; };
    // Document restoration runs once per account after local draft recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draftReady, storageKey]);
  useEffect(() => {
    if (!active || !draftReady) return;
    const controller = new AbortController(), params = new URLSearchParams({ q: documentQuery, archived: showArchived ? '1' : '0', limit: '100' });
    fusionRequest<{ workspaces: WorkspaceListItem[] }>(`${WORKSPACE_API}?${params}`, { signal: controller.signal }).then(data => { if (activeRef.current && !controller.signal.aborted) setDocuments(data.workspaces); }).catch(e => { if (activeRef.current && !controller.signal.aborted) setSyncError(e instanceof Error ? e.message : '文档列表读取失败。'); });
    return () => controller.abort();
  }, [active, draftReady, documentQuery, showArchived, workspace?.id, workspace?.name, workspace?.archived]);
  useEffect(() => {
    if (!active || !draftReady || !workspace || workspace.archived || pendingOperation || savingDocument || chatActive || syncBlocked.current || !CHARACTER_FUSION_WRITES_ENABLED) return;
    const timer = window.setTimeout(() => { void synchronize(); }, 700); return () => window.clearTimeout(timer);
    // Input changes are combined into field-level commands; UI preferences stay local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draftReady, workspace, baseSettings, preparation, selected, retained, idea, summary, pendingOperation, savingDocument, chatActive]);
  const createDocument = async (carry: boolean, retry = pendingCreation, automatic = false, mode: 'fresh' | 'inherit' = 'fresh') => {
    if (!activeRef.current || documentTransition.current || savingDocument || savingInline || chatActivityRef.current || !CHARACTER_FUSION_WRITES_ENABLED) return;
    documentTransition.current = 'create'; setLoadingDocument(true); setSyncError('');
    try {
      if (workspaceRef.current && !await synchronize()) return;
      let currentState = stateRef.current, currentRows = rowsRef.current;
      if (carry && legacyDraft && workspaceRef.current && savedDraftRef.current) { const draft = savedDraftRef.current; currentState = { settings: parseSettings(draft.settings), idea: typeof draft.idea === 'string' ? draft.idea : '', summary: typeof draft.summary === 'string' ? draft.summary : '', messages: [], selectedIds: Array.isArray(draft.selected) ? draft.selected as string[] : [], retainedIds: Array.isArray(draft.retained) ? draft.retained as string[] : Array.isArray(draft.selected) ? draft.selected as string[] : [] }; currentRows = Array.isArray(draft.rows) ? draft.rows as FusionRow[] : []; }
      const creation: NonNullable<typeof pendingCreation> = retry || { opId: crypto.randomUUID(), name: carry ? '继续角色融合创作' : mode === 'inherit' ? '沿用组合的新创作' : '新的角色融合创作', carry, mode, automatic, ...(automatic ? { baseState: currentState } : {}), ...(!carry ? { state: newCreationState(currentState, mode, catalogue) } : {}) }; setPendingCreation(creation); try { sessionStorage.setItem(storageKey + ':creation', JSON.stringify(creation)); } catch { /* The original ID stays in memory. */ }
      const receipt = await postFusion<WorkspaceReceipt>(WORKSPACE_API, { opId: creation.opId, name: creation.name, ...(creation.state ? { state: creation.state } : {}) });
      if (!activeRef.current) return;
      const continued = creation.automatic ? mergeWorkspaceState(creation.baseState || currentState, stateRef.current, receipt.workspace.state) : null;
      applyWorkspace(receipt, true);
      if (continued) { stateRef.current = continued; setBaseSettings(continued.settings); setPreparation(continued.preparation); preparationRef.current = continued.preparation; setIdea(continued.idea); setSummary(continued.summary); setSelected(continued.selectedIds); setRetained(continued.retainedIds); }
      setPendingCreation(null); try { sessionStorage.removeItem(storageKey + ':creation'); } catch { /* Saved receipt is already known. */ } setLegacyDraft(false); setRecentResultIds([]); setChatTarget(null); setRowSettings(null); setAssistantDrafts([]); setAssistantContinuation(undefined); setUndo(null); setView('workspace'); setNotice(creation.mode === 'inherit' ? '已沿用当前组合、持续要求、手选范围和锁定；方案与对话从空白开始。' : ''); if (documentList.current) documentList.current.open = false;
      if (continued) await synchronize();
      if (creation.carry) { const imported = await commit([{ type: 'importDraft', state: currentState, rows: currentRows }], '当前现场'); if (!imported) { stateRef.current = currentState; rowsRef.current = currentRows; setBaseSettings(currentState.settings); setPreparation(currentState.preparation); preparationRef.current = currentState.preparation; setRows(currentRows); setIdea(currentState.idea); setSummary(currentState.summary); setSelected(currentState.selectedIds); setRetained(currentState.retainedIds); setLegacyDraft(true); } else { const migrated = { ...savedDraftRef.current, workspaceId: receipt.workspace.id }; savedDraftRef.current = migrated; try { sessionStorage.setItem(storageKey, JSON.stringify(migrated)); } catch { /* The old draft remains stored. */ } } }
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
  const useCatalogue = (next: FusionCatalogue) => { setCatalogue(next); };
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
  const generate = async () => {
    if (chatActivityRef.current || savingDocument || pendingRef.current || savingInline || loadingTarget) return;
    if (!await synchronize()) return;
    const state = stateRef.current, row = state.preparation?.row;
    if (row && !row.changes.length) { setNotice('这条还没有调整；可先修改卡片或发送想法，再更新。'); return; }
    const commands: FusionCommand[] = row ? [{ type: 'applyPreparedRow', rowId: row.rowId, expectedVersion: row.version, seed: Math.floor(Math.random() * 0x100000000) }] : [{ type: 'generate', mode: effectiveFusionSettings(state.settings, state.preparation?.batch, catalogue).generationMode || 'append', seed: Math.floor(Math.random() * 0x100000000), settingsHash: settingsFingerprint(state.settings), preparationHash: preparationFingerprint(state.preparation?.batch) }];
    const ok = await commit(commands, row ? '更新这条' : '生成提示词');
    if (ok && activeRef.current) setRulesAtGeneration(JSON.stringify({ rules: settingsRef.current.rules, cards: settingsRef.current.cards, catalogue: settingsRef.current.catalogue }));
  };
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
  const setTagStatus = (id: Dimension, label: string, status: Tag['status']) => setSettings(s => reconcile({ ...s, rules: { ...s.rules, [id]: s.rules[id].map(t => t.label === label ? { ...t, status, definitionOnly: undefined } : t) } }));
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
    if (!form || busy || !active || form.action === 'save' && preparationRef.current?.row) return;
    setBusy(true); setError('');
    try {
      if (form.action === 'save' && workspaceRef.current && !workspaceRef.current.archived && CHARACTER_FUSION_WRITES_ENABLED) { const saved = await execute([{ type: 'saveRecipe', id: form.id, name: form.name, settingsHash: settingsFingerprint(stateRef.current.settings), preparationHash: preparationFingerprint(stateRef.current.preparation?.batch) }], '规则配方'); if (saved && activeRef.current) { setForm(null); setRecipeReload(value => value + 1); } return; }
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
    const c = parseCardDraft(draft), id = `card-${crypto.randomUUID()}`, catalogueCategoryId = c.catalogueCategoryId || crypto.randomUUID();
    if (allCards.some(item => item.title === c.title)) throw new Error('已有同名卡片，请继续对话换一个明确名称。');
    setSettings(s => ({ ...s, cards: [...s.cards, { ...c, catalogueCategoryId, tags: c.tags.map(tag => ({ ...tag, termId: tag.termId || crypto.randomUUID(), descriptionZh: tag.descriptionZh || tag.label, descriptionEn: tag.descriptionEn || tag.en })), id, joined: true, value: c.tags[0].label, locked: false }] }));
    setUndo({ label: '新增卡片', restore: () => setSettings(current => ({ ...current, cards: current.cards.filter(card => card.id !== id) })) });
    setConversation(emptyConversation()); setChatOpen(false); setNotice(`「${c.title}」已加入规则与当前组合。`);
    if (legacyCards.current) legacyCards.current.open = true;
    requestAnimationFrame(() => document.getElementById(`card-${id}-root`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  });
  const translate = async () => {
    if (translating || chatActivityRef.current) return;
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
      setSettings(next); setTranslationOpen(true);
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
  const viewRows = (ids: string[]) => {
    setView('workspace'); setMobilePanel('results');
    requestAnimationFrame(() => { const element = ids.map(id => document.getElementById(`fusion-result-${id}`)).find(Boolean); (element || resultsRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  };
  const batchGroups = (workspace?.batches || []).map(batch => ({ batch, rows: rows.filter(row => row.originBatchId === batch.id) })).filter(group => group.rows.length).sort((a, b) => b.batch.number - a.batch.number);
  const legacyRows = rows.filter(row => !batchGroups.some(group => group.batch.id === row.originBatchId));
  const rowLabel = (row: FusionRow) => {
    const batch = workspace?.batches?.find(batch => batch.id === row.originBatchId);
    return `${batch ? `第${batch.number}批 · ` : '历史方案 · '}${row.displayNo ? `方案${String(row.displayNo).padStart(2, '0')}` : row.name}`;
  };
  const clearTarget = () => { const current = preparationRef.current; updatePreparation(current?.batch ? { formatVersion: 1, batch: current.batch } : undefined); setChatTarget(null); setRowSettings(null); };
  const targetRow = async (row: FusionRow) => {
    const current = workspaceRef.current; if (!current || chatActivityRef.current || pendingRef.current || savingDocument) return;
    if (!await synchronize()) return;
    setLoadingTarget(true); setError('');
    try {
      const result = await fusionRequest<{ rowSettings: { rowId: string; version: number; settings: FusionSettings } }>(`${WORKSPACE_API}/${current.id}?rowId=${encodeURIComponent(row.id)}`);
      if (!activeRef.current || workspaceRef.current?.id !== current.id) return;
      setRowSettings(result.rowSettings); setChatTarget({ rowId: row.id, version: result.rowSettings.version, label: rowLabel(row) });
      updatePreparation({ ...preparationRef.current, formatVersion: 1, row: { rowId: row.id, version: result.rowSettings.version, changes: [] } }); setMobilePanel('conditions');
    } catch (error) { if (activeRef.current) setError(error instanceof Error ? error.message : '原方案条件未能读取，未切换目标。'); }
    finally { if (activeRef.current) setLoadingTarget(false); }
  };
  useEffect(() => {
    const target = preparation?.row; if (!workspace || !target || rowSettings?.rowId === target.rowId && rowSettings.version === target.version) return;
    const controller = new AbortController(); setLoadingTarget(true);
    void fusionRequest<{ rowSettings: { rowId: string; version: number; settings: FusionSettings }; workspace: FusionWorkspace }>(`${WORKSPACE_API}/${workspace.id}?rowId=${encodeURIComponent(target.rowId)}`, { signal: controller.signal }).then(result => {
      if (!activeRef.current || controller.signal.aborted) return;
      setRowSettings(result.rowSettings); const row = result.workspace.rows.find(row => row.id === target.rowId);
      setChatTarget({ rowId: target.rowId, version: target.version, label: row ? rowLabel(row) : `方案 · ${target.rowId.slice(-6)}` });
      if (result.rowSettings.version !== target.version) setError('这条方案已更新，原调整草稿保留。请在方案上重新选择“聊这张”，核对新版本后再更新。');
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '原方案条件暂时无法读取，调整草稿保留。'); }).finally(() => { if (!controller.signal.aborted) setLoadingTarget(false); });
    return () => controller.abort();
    // A restored row draft must fresh-read its exact source before exposing editable cards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, preparation?.row?.rowId, preparation?.row?.version]);
  const saveInline = async (cardId: string) => {
    const current = workspaceRef.current; if (!current || savingInline || chatActivityRef.current || loadingTarget || preparationRef.current?.row && (!rowSettingsRef.current || rowSettingsRef.current.version !== preparationRef.current.row.version) || !await synchronize()) return;
    const operation = { opId: crypto.randomUUID(), workspaceId: current.id, cardId }; setSavingInline(operation); setError('');
    try { sessionStorage.setItem(storageKey + ':inline:' + current.id, JSON.stringify(operation)); } catch { /* The original ID remains in memory. */ }
    try {
      const result = await postFusion<OperationLookup>('/api/character-fusion/assistant', { action: 'saveInline', ...operation, baseVersion: workspaceRef.current!.version, ...(preparationRef.current?.row ? { rowId: preparationRef.current.row.rowId } : {}) });
      if (!activeRef.current || workspaceRef.current?.id !== current.id) return;
      if (result.workspace) applyWorkspace({ workspace: result.workspace, rowChanges: result.rowChanges, rowsPage: result.rowsPage });
      if (result.status !== 'cancelled' && result.status !== 'rejected' && result.continuation) { setAssistantDrafts(result.drafts || result.continuation.entries || []); setAssistantContinuation(result.continuation); setView('library'); setSavingInline(null); try { sessionStorage.removeItem(storageKey + ':inline:' + current.id); } catch { /* Receipt is already known. */ } }
      else if (result.status === 'rejected' || result.status === 'cancelled') { setSavingInline(null); try { sessionStorage.removeItem(storageKey + ':inline:' + current.id); } catch { /* Terminal receipt remains on the server. */ } setError(result.error || '本次未保存到词库，原卡片保留。'); }
    } catch (error) { if (activeRef.current) setError(error instanceof Error ? error.message : '存库准备结果待核对，原卡片与编号已保留。'); }
  };
  const checkInline = async (cancel = false) => {
    if (!savingInline) return;
    setError('');
    try { const result = cancel ? await postFusion<OperationLookup>('/api/character-fusion/assistant', { action: 'cancel', workspaceId: savingInline.workspaceId, opId: savingInline.opId }) : await lookupOperation(savingInline.workspaceId, savingInline.opId); if (!activeRef.current || workspaceRef.current?.id !== savingInline.workspaceId) return; if (result.status !== 'cancelled' && result.status !== 'rejected' && result.continuation) { setAssistantDrafts(result.drafts || result.continuation.entries || []); setAssistantContinuation(result.continuation); setView('library'); setSavingInline(null); try { sessionStorage.removeItem(storageKey + ':inline:' + savingInline.workspaceId); } catch { /* The source plan remains durable. */ } } else if (result.status === 'rejected' || result.status === 'cancelled') { setSavingInline(null); try { sessionStorage.removeItem(storageKey + ':inline:' + savingInline.workspaceId); } catch { /* Terminal receipt remains available. */ } setNotice('原存库准备已结束，卡片仍保留。'); } else setNotice('原存库准备尚未确认，请继续核对。'); } catch (error) { setError(error instanceof Error ? error.message : '暂时无法核对原存库准备。'); }
  };
  useEffect(() => { if (!workspace) return; try { const saved = JSON.parse(sessionStorage.getItem(storageKey + ':inline:' + workspace.id) || 'null'); if (saved?.opId) setSavingInline(saved); else setSavingInline(null); } catch { setSavingInline(null); } }, [workspace?.id, storageKey]);
  useEffect(() => {
    if (!workspace) return;
    try { const saved = JSON.parse(sessionStorage.getItem(storageKey + ':catalogue-plan:' + workspace.id) || 'null'); if (saved?.continuation?.workspaceId === workspace.id) { setAssistantContinuation(saved.continuation); setAssistantDrafts(saved.drafts || saved.continuation.entries || []); } } catch { /* Original source operation can still be queried. */ }
  }, [workspace?.id, storageKey]);
  useEffect(() => {
    if (!assistantContinuation) return;
    try { sessionStorage.setItem(storageKey + ':catalogue-plan:' + assistantContinuation.workspaceId, JSON.stringify({ continuation: assistantContinuation, drafts: assistantDrafts })); } catch { /* The original plan is durable on the server. */ }
  }, [assistantContinuation, assistantDrafts, storageKey]);
  const requirementParts = [
    ...(settings.role ? [settings.role] : []),
    ...CONFIG.filter(config => settings.bossDimensions.includes(config.id) && (settings.bossLocks[config.id] || settings.catalogue?.details[config.id]?.locked)).map(config => `${config.title}：${settings.catalogue?.details[config.id]?.locked ? settings.catalogue.details[config.id]!.value : settings.boss[config.id]}`),
    ...TRAITS.filter(trait => settings.catalogue?.traits[trait.id]?.enabled && settings.catalogue.traits[trait.id].locked).map(trait => `${trait.title}：${settings.catalogue!.traits[trait.id].values.join('、')}`),
    ...Object.entries(settings.catalogue?.dynamic?.selections || {}).filter(([, selection]) => selection.enabled && selection.locked).map(([id, selection]) => `${settings.catalogue!.dynamic!.snapshot.categories.find(category => category.id === id)?.nameZh || '词库类别'}：${selection.values.map(id => settings.catalogue!.dynamic!.snapshot.terms.find(term => term.id === id)?.nameZh || '不可用词条').join('、')}`),
    ...settings.cards.filter(card => card.joined && card.locked).map(card => `${card.title}：${cardValues(card).join('、')}`),
    ...(!preparation?.row ? workspace?.state.intent?.requirements.map(requirement => requirement.text) || [] : []),
    ...(settings.requirementsEnabled && settings.requirements ? [settings.requirements] : []),
  ];
  const ruleParts = [
    ...CONFIG.filter(config => settings.bossDimensions.includes(config.id)).flatMap(config => { const must = settings.rules[config.id].filter(tag => tag.status === 'must').map(tag => tag.label), excluded = settings.rules[config.id].filter(tag => tag.status === 'exclude' && !tag.definitionOnly).map(tag => tag.label); return [must.length ? `${config.title}必出：${must.join('、')}` : '', excluded.length ? `${config.title}排除：${excluded.join('、')}` : ''].filter(Boolean); }),
    ...TRAITS.filter(trait => settings.catalogue?.traits[trait.id]?.enabled).flatMap(trait => { const state = settings.catalogue!.traits[trait.id]; return [state.must.length ? `${trait.title}必出：${state.must.join('、')}` : '', state.excluded.length ? `${trait.title}排除：${state.excluded.join('、')}` : ''].filter(Boolean); }),
    ...settings.cards.filter(card => card.joined).flatMap(card => { const must = card.tags.filter(tag => tag.status === 'must').map(tag => tag.label), excluded = card.tags.filter(tag => tag.status === 'exclude').map(tag => tag.label); return [must.length ? `${card.title}必出：${must.join('、')}` : '', excluded.length ? `${card.title}排除：${excluded.join('、')}` : ''].filter(Boolean); }),
    ...Object.entries(settings.catalogue?.dynamic?.selections || {}).filter(([, selection]) => selection.enabled).flatMap(([id, selection]) => { const snapshot = settings.catalogue!.dynamic!.snapshot, title = snapshot.categories.find(category => category.id === id)?.nameZh || '词库类别', names = (ids: string[]) => ids.map(id => snapshot.terms.find(term => term.id === id)?.nameZh || '不可用词条').join('、'); return [selection.candidates !== undefined ? `${title}随机范围：${names(selection.candidates) || '空范围'}` : '', selection.must.length ? `${title}必出：${names(selection.must)}` : '', selection.excluded.length ? `${title}排除：${names(selection.excluded)}` : ''].filter(Boolean); }),
    ...(settings.catalogue?.sourceFusion?.enabled ? [`辅助融合：${settings.catalogue.sourceFusion.locked ? settings.catalogue.sourceFusion.values.join('、') : '随机1–3项'}`] : []),
  ];
  useEffect(() => {
    const element = workbenchRef.current; if (!element) return;
    const chat = element.querySelector<HTMLElement>('[data-fusion-creation-chat]'), dock = element.querySelector<HTMLElement>('[data-fusion-creation-dock]'), rootStyle = document.documentElement.style;
    const update = () => {
      const viewport = window.visualViewport, bounds = element.getBoundingClientRect();
      element.style.setProperty('--fusion-workbench-top', `${Math.max(0, bounds.top)}px`); element.style.setProperty('--fusion-viewport-height', `${viewport?.height || window.innerHeight}px`);
      element.style.setProperty('--fusion-dock-height', `${dock?.getBoundingClientRect().height || 0}px`);
      element.style.setProperty('--fusion-dock-left', `${bounds.left}px`); element.style.setProperty('--fusion-dock-right', `${Math.max(0, window.innerWidth - bounds.right)}px`);
      element.style.setProperty('--fusion-keyboard-inset', `${Math.max(0, window.innerHeight - (viewport?.height || window.innerHeight) - (viewport?.offsetTop || 0))}px`);
      if (active && view === 'workspace' && element.getBoundingClientRect().width < 1280 && chat) rootStyle.setProperty('--character-fusion-feedback-bottom', `${Math.max(24, window.innerHeight - chat.getBoundingClientRect().top + 12)}px`);
      else rootStyle.removeProperty('--character-fusion-feedback-bottom');
    };
    update(); const observer = new ResizeObserver(update); if (element.parentElement) observer.observe(element.parentElement); if (chat) observer.observe(chat); if (dock) observer.observe(dock); window.addEventListener('resize', update); window.addEventListener('scroll', update, { passive: true }); window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update);
    return () => { observer.disconnect(); rootStyle.removeProperty('--character-fusion-feedback-bottom'); window.removeEventListener('resize', update); window.removeEventListener('scroll', update); window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update); };
  }, [active, view, loadingDocument, syncError]);
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
  const canWrite = CHARACTER_FUSION_WRITES_ENABLED && Boolean(workspace && !workspace.archived) && !loadingDocument && !savingDocument && !pendingOperation && !chatActive && !savingInline;
  const modelStatus = modelError || modelAvailability.reason || (!loadingModels && !modelReady ? '请选择已开放的 API 模型，当前选择和输入已保留。' : '');
  if (!active) return <main className={styles.page}><p role="status">正在确认当前账号…</p></main>;
  return <main className={styles.page}>
    <header className={styles.header}><h1>角色融合提示词</h1></header>
    <div className={styles.toolbar}><div className={styles.tabs} aria-label="角色融合工作区"><button aria-pressed={view === 'workspace'} onClick={() => { setView('workspace'); setForm(null); }}>融合工作台</button><button aria-pressed={view === 'library'} onClick={() => { setView('library'); setForm(null); }}>词库管理</button><button aria-pressed={view === 'recipes'} onClick={() => { setView('recipes'); setForm(null); }}>我的配方</button></div><div className={styles.toolbarActions}><button disabled={busy || Boolean(preparation?.row)} title={preparation?.row ? '先返回本次创作，再保存当前设置为配方' : undefined} onClick={() => setForm({ action: 'save', id: crypto.randomUUID(), name: '角色融合配方' })}><Save size={16} />{preparation?.row ? '先返回创作再存配方' : '保存规则配方'}</button><details ref={modelSettings} className={styles.pageSettings} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>模型设置</summary><div className={styles.settingsPanel}><div className={styles.modelPicker}><label htmlFor="fusion-api-model">API 模型</label><select id="fusion-api-model" value={modelReady ? apiModel : ''} title={modelReady ? apiModel : undefined} onChange={e => setApiModel(e.target.value)}><option value="" disabled>{loadingModels && !apiModels.length ? '正在读取模型…' : '请选择已开放模型'}</option>{modelOptions.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}</select><button type="button" disabled={loadingModels} aria-busy={loadingModels} onClick={() => { void loadModels(true); void modelAvailability.refresh(); }}><RefreshCw size={15} />{loadingModels ? '更新中…' : '更新'}</button></div><small>用于创作助手、对话新增卡片和补齐英文，选择后自动记住。</small>{modelStatus && <p role={modelError ? 'alert' : 'status'} className={styles.hint}>{modelStatus}</p>}</div></details></div></div>
    <section className={styles.documentBar} aria-label="本人工作文档">
      <div className={styles.documentIdentity}><strong>{workspace?.name || '浏览器创作现场'}</strong><small role="status">{loadingDocument ? documentTransition.current === 'create' ? '正在新建文档…' : '正在继续文档…' : savingDocument ? '正在保存…' : pendingOperation ? '操作待核对，草稿保留' : syncError ? '未同步，草稿保留' : workspace ? workspace.archived ? '已归档，只读' : stateCommands(workspace.state, stateRef.current).length ? '有未同步修改' : '已保存到本人账号' : '尚未保存到账号'}</small></div>
      <div className={styles.actions}>{workspace && <button disabled={savingDocument || Boolean(pendingOperation) || !CHARACTER_FUSION_WRITES_ENABLED || workspace.archived} onClick={() => { syncBlocked.current = false; void synchronize(); }}>保存现场</button>}<button disabled={loadingDocument || savingDocument || chatActive || !CHARACTER_FUSION_WRITES_ENABLED || Boolean(pendingOperation) || Boolean(pendingCreation)} onClick={() => void createDocument(false)}>新创作</button><details className={styles.documentList}><summary aria-label="更多新建方式">新建方式</summary><div><button disabled={loadingDocument || savingDocument || chatActive || !CHARACTER_FUSION_WRITES_ENABLED || Boolean(pendingOperation) || Boolean(pendingCreation)} onClick={() => void createDocument(false, null, false, 'inherit')}>复制当前设置</button>{legacyDraft && <button disabled={loadingDocument || savingDocument || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void createDocument(true)}>{workspace ? '承接原浏览器现场为新文档' : '保存并继续当前现场'}</button>}</div></details><details ref={documentList} className={styles.documentList}><summary>打开历史</summary><div><label>查找本人文档<input value={documentQuery} onChange={event => setDocumentQuery(event.target.value)} placeholder="搜索名称" /></label><label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />查看已归档</label>{documents.map(document => <div className={styles.libraryLine} key={document.id}><span className={styles.documentEntry}><strong>{document.name}{document.archived ? ' · 已归档' : ''}</strong>{(document.direction?.trim() || document.batchCount !== undefined || document.rowCount !== undefined) && <small className={styles.documentSummary}>{[document.direction?.trim(), [document.batchCount !== undefined ? `${document.batchCount}批` : '', document.rowCount !== undefined ? `${document.rowCount}条` : ''].filter(Boolean).join('/')].filter(Boolean).join(' · ')}</small>}<RelativeTime value={document.updatedAt} /></span><button disabled={document.id === workspace?.id || loadingDocument || savingDocument || chatActive || Boolean(pendingOperation)} onClick={() => void loadDocument(document.id)}>{document.id === workspace?.id ? '当前文档' : '继续'}</button></div>)}{!documents.length && <p className={styles.hint}>没有匹配文档，当前浏览器现场仍保留。</p>}</div></details>{workspace && <details className={styles.documentList}><summary>文档管理</summary><div><label>文档名称<input maxLength={60} value={documentName} onChange={event => setDocumentName(event.target.value)} /></label><button disabled={!canWrite || !documentName.trim() || documentName === workspace.name} onClick={() => void execute([{ type: 'rename', name: documentName, expected: workspace.name }], '文档改名')}>保存名称</button><button disabled={savingDocument || Boolean(pendingOperation) || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => { if (workspace.archived) { void commit([{ type: 'archive', archived: false, expected: true }], '恢复文档'); } else void execute([{ type: 'archive', archived: true, expected: false }], '归档文档'); }}>{workspace.archived ? '恢复文档' : '归档，可恢复'}</button></div></details>}</div>
    </section>
    {pendingCreation && <p className={styles.hint}>新文档创建结果待确认，原编号与草稿保留。<button disabled={loadingDocument || !CHARACTER_FUSION_WRITES_ENABLED} onClick={() => void createDocument(pendingCreation.carry, pendingCreation)}>按原编号继续创建</button></p>}
    {!CHARACTER_FUSION_WRITES_ENABLED && <p className={styles.hint}>当前为只读，可查看目录、恢复现场与复制导出。新写入暂不可用，浏览器草稿保留。</p>}
    {syncError && <p className={styles.error} role="alert">{syncError}{workspace && !pendingOperation && <button onClick={() => void loadDocument(workspace.id, true)}>读取远端并核对</button>}</p>}
    {conflicts.length > 0 && <details className={styles.conflictDetails}><summary>查看 {conflicts.length} 处差异，当前草稿保留</summary>{conflicts.map((conflict, index) => <div key={index}><strong>{conflict.path.join(' / ')}</strong><label>当前草稿<pre>{JSON.stringify(conflict.draft, null, 2)}</pre></label><label>远端内容<pre>{JSON.stringify(conflict.remote, null, 2)}</pre></label></div>)}</details>}
    {pendingOperation && <div className={styles.actions}><small>操作结果待确认</small><details><summary>操作详情</summary><small>{pendingOperation.opId}</small></details><button disabled={savingDocument} onClick={() => void checkPending()}>核对原操作</button></div>}
    {view === 'recipes' && (error || notice) && <p role={error ? 'alert' : 'status'} className={error ? styles.error : styles.notice}>{error || notice}</p>}
    {form && <form className={styles.recipeForm} onSubmit={e => { e.preventDefault(); void saveRecipe(); }}><label>{form.action === 'save' ? '保存规则配方' : '配方改名'}<input autoFocus maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /><small>保存组合与规则，结果清单请单独导出。</small></label><button className={styles.primary} disabled={busy}>{busy ? '保存中…' : '保存'}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>取消</button></form>}
    <div className={`${styles.mobilePanels} ${view !== 'workspace' ? styles.hidePanels : ''}`} role="tablist" aria-label="创作内容"><button role="tab" aria-selected={mobilePanel === 'conditions'} onClick={() => setMobilePanel('conditions')}>要求</button><button role="tab" aria-selected={mobilePanel === 'results'} onClick={() => setMobilePanel('results')}>方案{rowsPage.total > 0 ? ` · ${rowsPage.total}` : ''}</button></div>
    <div ref={workbenchRef} className={`${styles.workbench} ${view !== 'workspace' ? styles.managementView : ''}`} data-panel={mobilePanel}>
        {view === 'library' ? <LibraryManager ownerId={ownerId} admin={user?.role === 'admin'} active={active} catalogue={catalogue} cards={settings.cards} drafts={assistantDrafts} continuation={assistantContinuation} onPreparePlan={async () => Boolean(workspaceRef.current?.id === assistantContinuation?.workspaceId && await synchronize())} onWorkspace={receipt => applyWorkspace(receipt)} onContinuation={(next, reply) => { if (!next) { try { sessionStorage.removeItem(storageKey + ':catalogue-plan:' + assistantContinuation?.workspaceId); } catch { /* The completed source remains durable. */ } setCompletedPlanReply(reply || ''); setCompletedPlanId(assistantContinuation?.sourceOpId || ''); setAssistantDrafts([]); } setAssistantContinuation(next); }} onCatalogue={useCatalogue} onJoin={joinTerm} onOpenCardChat={() => { setView('workspace'); setChatOpen(true); if (legacyCards.current) legacyCards.current.open = true; }} /> : view === 'recipes' ? <section className={styles.recipes}><div className={styles.sectionHead}><h2>我的配方</h2><span>仅本人可见，保存在账号中</span></div>
      {loadingRecipes ? <p role="status">正在读取配方…</p> : recipeError ? <p role="alert" className={styles.error}>{recipeError}<button onClick={() => setRecipeReload(n => n + 1)}>重新读取</button></p> : recipes.length ? recipes.map(recipe => <article className={styles.recipe} key={recipe.id}><div><h3>{recipe.name}</h3><p>{recipe.settings.count} 条 · {recipe.settings.lang === 'zh' ? '中文' : recipe.settings.lang === 'en' ? 'English' : '中英双语'} · {recipe.settings.bossDimensions.length + (recipe.settings.cards || []).filter(c => c.joined).length + Object.values(recipe.settings.catalogue?.traits || {}).filter(t => t.enabled).length} 个融合维度</p></div><div className={styles.actions}><button onClick={() => run(() => { setSettings(parseSettings(recipe.settings)); setView('workspace'); setNotice(`已套用「${recipe.name}」，已有提示词保留。`); })}>套用</button><button disabled={busy} onClick={() => setForm({ action: 'rename', id: recipe.id, name: recipe.name, revision: recipe.revision })}>改名</button><details className={styles.delete}><summary>删除</summary><p>删除「{recipe.name}」？</p><button disabled={busy} onClick={() => void deleteRecipe(recipe)}>确认删除</button></details></div></article>) : <p className={styles.empty}>还没有配方。设置好规则后，点“保存规则配方”。</p>}
    </section> : <><div className={styles.creationColumn}><div ref={workspaceScroll} className={styles.conditionsScroll} onScroll={event => { if (workspace) try { sessionStorage.setItem(storageKey + ':position:' + workspace.id, String(event.currentTarget.scrollTop)); } catch { /* Keep current position on screen. */ } }}>
      <section className={styles.currentRequirements} aria-label="当前创作要求"><details><summary><strong>当前要求</strong><span>{requirementParts.length ? requirementParts.join(' · ') : '基础组合，未限定创作方向'}</span><small>展开</small></summary><div><ul>{[...requirementParts, ...ruleParts].map((part, index) => <li key={index}>{part}</li>)}</ul><small>来自下方实际设置与明确创作要求，只影响后续生成；已有方案保留原设定。</small><details className={styles.creationContext}><summary>原始想法与创作备忘</summary><label>原始想法<textarea rows={3} maxLength={12000} value={idea} onChange={event => setIdea(event.target.value)} /></label>{summary && <div><small>{workspace?.state.summaryMeta?.legacy || !workspace?.state.summaryMeta ? '历史备忘，来源未确认' : `创作备忘 · 状态版本${workspace.state.summaryMeta.stateVersion}`}</small><p>{summary}</p></div>}</details></div></details></section>
      <section className={styles.boss} aria-labelledby="boss-title">
        <div className={styles.sectionHead}><h2 id="boss-title">{chatTarget ? '这条的条件' : '创作条件'}</h2><details className={styles.utilities}><summary>组合操作</summary><div><button onClick={() => setSettings(current => refreshBoss(current))}><RefreshCw size={15} />随机刷新</button><button onClick={() => setSettings(current => ({ ...current, bossLocks: defaults().bossLocks, cards: current.cards.map(card => ({ ...card, locked: false })), catalogue: { ...current.catalogue, details: {}, traits: Object.fromEntries(Object.entries(current.catalogue?.traits || {}).map(([id, value]) => [id, { ...value, locked: false }])) , ...(current.catalogue?.dynamic ? { dynamic: { ...current.catalogue.dynamic, selections: Object.fromEntries(Object.entries(current.catalogue.dynamic.selections).map(([id, value]) => [id, { ...value, locked: false }])) } } : {}) } }))}><UnlockKeyhole size={15} />全部解锁</button><button onClick={copyBody}><Copy size={15} />复制身形组合</button><button disabled={!canWrite || !manualReady || Boolean(generationProblem)} onClick={() => void execute([{ type: 'addCurrent', seed: Math.floor(Math.random() * 0x100000000) }], '加入当前组合')}>单独加入当前组合</button><button onClick={() => { setCatalogueView(defaultCatalogueView()); setExpanded([]); setCardOrder([]); }}>恢复卡片布局</button><button onClick={() => { setSettings(current => reconcile({ ...current, rules: defaults().rules })); setNotice('内置规则已重置，扩展定义保留。'); }}>重置内置规则</button></div></details></div>
        {loadingTarget && <p role="status" className={styles.hint}>正在读取这条方案的原条件…</p>}
        {chatTarget && <div className={styles.scopeBanner}><strong>仅调整：{chatTarget.label}</strong><button type="button" onClick={clearTarget}>返回本次创作</button></div>}
        {!chatTarget && preparation?.batch && <div className={styles.scopeBanner}><strong>仅本批</strong><span>生成后恢复创作默认条件</span><button type="button" disabled={!canWrite} onClick={() => { const current = preparationRef.current; updatePreparation(current?.row ? { formatVersion: 1, row: current.row } : undefined); }}>取消本批条件</button><button type="button" disabled={!canWrite} onClick={() => { const current = stateRef.current; const next = effectiveFusionSettings(current.settings, current.preparation?.batch, catalogue); setBaseSettings(next); stateRef.current = { ...current, settings: next }; updatePreparation(current.preparation?.row ? { formatVersion: 1, row: current.preparation.row } : undefined); setNotice('当前可见条件已设为后续默认。'); }}>设为默认</button></div>}
        <CatalogueEditor settings={settings} onChange={setSettings} view={catalogueView} onViewChange={setCatalogueView} fullCatalogue={catalogue} onSaveInline={cardId => void saveInline(cardId)} savingInlineId={savingInline?.cardId} onAddCard={() => setChatOpen(value => !value)} />
        {chatOpen && <CardChat value={conversation} onChange={setConversation} onConfirm={confirmCard} onClose={() => setChatOpen(false)} model={apiModel} modelReady={modelReady} onChooseModel={openModelSettings} />}
        <details className={styles.visualRequirements}><summary>视觉要求与角色定位{settings.requirementsEnabled ? ' · 已启用' : ''}</summary><label>角色定位<select value={settings.role} onChange={event => setSettings(current => ({ ...current, role: event.target.value }))}><option value="">不限定位</option>{['主角', '配角', '伙伴', '反派', 'Boss', '路人'].map(role => <option key={role}>{role}</option>)}</select></label><label><input type="checkbox" checked={settings.requirementsEnabled} onChange={event => setSettings(current => ({ ...current, requirementsEnabled: event.target.checked }))} />启用固定视觉要求</label><label>中文要求<textarea rows={3} maxLength={6000} value={settings.requirements} onChange={event => setSettings(current => ({ ...current, requirements: event.target.value, requirementsEn: '' }))} /></label><label>英文要求<textarea rows={3} maxLength={10000} lang="en" value={settings.requirementsEn} onChange={event => setSettings(current => ({ ...current, requirementsEn: event.target.value }))} /></label><small>只影响接下来生成或当前目标更新，已有方案保留原正文。</small></details>
      </section>
      </div><div className={styles.creationDock} data-fusion-creation-dock>
    <CreationChat key={workspace?.id || 'preparing'} ownerId={ownerId} workspaceId={workspace?.id || ''} documentName={workspace?.name || '请选择工作文档'} messages={workspace?.state.messages || []} model={apiModel} modelReady={modelReady} active={active} completedPlanId={completedPlanId} completedPlanReply={completedPlanReply} preparing={loadingDocument || !draftReady} disabled={!canWrite || loadingTarget || Boolean(preparation?.row && (!rowSettings || rowSettings.version !== preparation.row.version))} count={settings.count} language={outputLanguage} target={chatTarget} onClearTarget={clearTarget} onActivityChange={onChatActivity} onViewResults={viewRows} onUndo={operationId => execute([{ type: 'undo', operationId }], '撤销调整')} onOpenDrafts={() => setView('library')} onPrepare={async () => {
      const id = workspaceRef.current?.id;
      if (!id || loadingTarget || preparationRef.current?.row && (!rowSettingsRef.current || rowSettingsRef.current.version !== preparationRef.current.row.version) || documentTransition.current || pendingRef.current && !flight.current || !await synchronize()) return null;
      const current = workspaceRef.current;
      return current?.id === id ? { workspaceId: id, version: current.version } : null;
    }} onWorkspace={receipt => applyWorkspace(receipt)} onChooseModel={openModelSettings} onDrafts={(drafts, continuation) => { setAssistantDrafts(drafts); setAssistantContinuation(continuation); }} />        <section className={styles.generateDock} aria-label="确认并生成提示词"><div className={styles.generationControls}><label><span className={styles.srOnly}>生成数量</span><select aria-label="生成数量" disabled={Boolean(chatTarget)} value={settings.count} onChange={event => setSettings(current => ({ ...current, count: Number(event.target.value) }))}>{COUNTS.map(count => <option key={count} value={count}>{count}套</option>)}</select></label><label><span className={styles.srOnly}>生成语言</span><select aria-label="生成语言" value={settings.lang} onChange={event => setSettings(current => ({ ...current, lang: event.target.value as FusionSettings['lang'] }))}><option value="zh">中文</option><option value="en">英文</option><option value="both">中英双语</option></select></label><button className={styles.primary} disabled={!canWrite || loadingTarget || Boolean(generationProblem) || Boolean(preparation?.row && (!preparation.row.changes.length || !rowSettings || rowSettings.version !== preparation.row.version))} aria-describedby={generationProblem ? 'fusion-generation-problem' : undefined} onClick={() => void generate()}>{chatTarget ? '更新这条' : `${settings.generationMode === 'replace' ? '替换生成' : '生成'}${settings.count}套提示词`}</button><details className={styles.generationMore}><summary aria-label="更多生成操作">更多</summary><div><label>生成方式<select disabled={Boolean(chatTarget)} value={settings.generationMode || 'append'} onChange={event => setSettings(current => ({ ...current, generationMode: event.target.value as FusionSettings['generationMode'] }))}><option value="append">追加新一批</option><option value="replace">替换未保留方案</option></select></label><label><input type="checkbox" checked={settings.diversity === 'strict'} onChange={event => setSettings(current => ({ ...current, diversity: event.target.checked ? 'strict' : 'prefer' }))} />母体严格不重复</label><button disabled={busy || Boolean(preparation?.row)} title={preparation?.row ? '先返回本次创作，再保存当前设置为配方' : undefined} onClick={() => setForm({ action: 'save', id: crypto.randomUUID(), name: '角色融合配方' })}>保存当前设置为配方</button></div></details></div>
        {preparation?.row && !preparation.row.changes.length && <p className={styles.generationFeedback}>先调整卡片或发送想法，再点“更新这条”。</p>}
        {generationProblem && <p id="fusion-generation-problem" role="status" className={styles.generationFeedback}>{generationProblem}{missingCore.length > 0 && <button onClick={() => setSettings(current => ({ ...current, bossDimensions: Array.from(new Set([...current.bossDimensions, ...CORE.map(config => config.id)])) }))}>加入缺少的基础条件</button>}</p>}
        {(error || notice) && <div className={`${styles.generationFeedback} ${error ? styles.error : styles.notice}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span>{!error && recentResultIds.length > 0 && <button onClick={() => viewRows(recentResultIds)}>查看新增{recentResultIds.length}条</button>}</div>}
        {undo && <button disabled={Boolean(undo.remote) && !canWrite} className={styles.undoFeedback} onClick={() => { undo.restore(); setUndo(null); setError(''); }}><Undo2 size={14} />撤销{undo.label}</button>}
        {savingInline && <div className={styles.generationFeedback}><span>存入词库的准备结果待核对，卡片保留</span><button onClick={() => void checkInline()}>核对原操作</button><button onClick={() => void checkInline(true)}>取消本次准备</button></div>}
        </section>      </div></div><div className={styles.resultsColumn}>
      <section className={styles.results} ref={resultsRef} aria-labelledby="results-title">
        <div className={styles.sectionHead}><h2 id="results-title">方案 <small>{workspace ? rowsPage.total : rows.length} 条{selected.length > 0 && ` · 已选 ${selected.length} 条`}</small></h2><div className={styles.actions}>
          <label className={styles.outputLanguage}><span className={styles.srOnly}>预览与复制语言</span><select aria-label="提示词预览与复制语言" value={settings.lang} onChange={e => setSettings(s => ({ ...s, lang: e.target.value as FusionSettings['lang'] }))}><option value="zh">中文</option><option value="en">英文 English</option><option value="both">中英双语</option></select></label>
          <button aria-expanded={translationOpen} aria-controls="fusion-translations" onClick={() => { setTranslationOpen(v => !v); }}>译文{(settings.requirementsEn || translatedTags.length > 0) && <span className={styles.translationDot} aria-label="已有译文" />}</button>
          {rows.length > 0 && <><button disabled={Boolean(exportProgress)} onClick={() => void copyDocument(selected.length > 0)}><Copy size={16} />{selected.length ? `复制所选 ${selected.length} 条` : '复制全部'}{outputLanguage}</button></>}
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
        {rows.length > 0 && rulesAtGeneration !== JSON.stringify({ rules: settings.rules, cards: settings.cards, catalogue: settings.catalogue }) && <p className={styles.hint}>规则已改，保留的组合不变；新候选使用当前规则。</p>}
        {rows.length ? <>{[...batchGroups.map(group => ({ id: group.batch.id, title: `第${group.batch.number}批 · ${group.batch.label}`, rows: group.rows, total: group.batch.rowIds.length })), ...(legacyRows.length ? [{ id: 'legacy', title: '历史方案', rows: legacyRows, total: legacyRows.length }] : [])].map(group => <section className={styles.resultBatch} key={group.id}><div className={styles.batchHeading}><h3>{group.title}</h3><small>{group.rows.length < group.total ? `已显示${group.rows.length} / ${group.total}条` : `${group.rows.length}条`}</small></div><div className={styles.resultList}>{group.rows.map(row => <ResultRow key={row.id} row={row} settings={settings} fullCatalogue={catalogue} peers={group.rows} label={rowLabel(row)} chatTargeted={chatTarget?.rowId === row.id} onChat={() => void targetRow(row)} checked={selected.includes(row.id)} retained={retained.includes(row.id)} writable={canWrite} onRetain={() => setRetained(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} onSelect={() => setSelected(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} onCopy={() => void copy(textFor(row, settings))} onLoadEdit={async () => { if (!workspace) return { settings: settingsForRow(settings, row), version: null, body: { zh: textFor(row, { ...settings, lang: 'zh' }), en: textFor(row, { ...settings, lang: 'en' }) } }; const data = await fusionRequest<{ rowSettings: { rowId: string; version: number; settings: FusionSettings; body: { zh: string; en: string } } }>(`${WORKSPACE_API}/${workspace.id}?rowId=${encodeURIComponent(row.id)}`); return data.rowSettings; }} onRewrite={() => void execute([{ type: 'changeRow', rowId: row.id, expectedVersion: (row as FusionWorkspaceRow).version, seed: Math.floor(Math.random() * 0x100000000) }], '随机重组')} onSwap={(dimension, value) => void execute([{ type: 'changeRow', rowId: row.id, dimension, value, expectedVersion: (row as FusionWorkspaceRow).version, seed: Math.floor(Math.random() * 0x100000000) }], '单项替换')} onEdit={(draft, expectedVersion) => execute([{ type: 'reviseRow', rowId: row.id, settings: draft, expectedVersion, seed: Math.floor(Math.random() * 0x100000000) }], '调整此条')} onDeep={() => void execute([{ type: 'patchRow', rowId: row.id, expectedVersion: (row as FusionWorkspaceRow).version, patch: { advanced: !row.advanced } }], '结构扩写')} />)}</div></section>)}{rowsPage.nextCursor && <button disabled={loadingDocument} onClick={() => void loadMoreRows()}>继续读取结果（已显示 {rows.length} / {rowsPage.total}）</button>}</> : <div className={styles.empty}><h3>先生成一批候选</h3><p>{workspace ? '可直接用默认规则，再挑选和调整。' : legacyDraft ? '先显式承接原浏览器现场，再继续抽卡。' : loadingDocument ? '正在准备本人工作文档，可继续调整设置。' : '本人工作文档尚未就绪，请从上方原操作继续；当前输入保留。'}</p></div>}

      </section>      </div></>}
    </div>
  </main>;
}

function ResultRow({ row, settings, checked, retained, writable, onRetain, onSelect, onCopy, onLoadEdit, onRewrite, onSwap, onDeep, onEdit, label, chatTargeted, onChat, peers, fullCatalogue }: {
  row: FusionRow; fullCatalogue: FusionCatalogue; peers: FusionRow[]; settings: FusionSettings; label: string; chatTargeted: boolean; onChat: () => void; checked: boolean; retained: boolean; writable: boolean; onRetain: () => void; onSelect: () => void; onCopy: () => void;
  onLoadEdit: () => Promise<{ settings: FusionSettings; version: number | null; body: { zh: string; en: string } }>; onEdit: (draft: FusionSettings, expectedVersion: number) => Promise<boolean>; onRewrite: () => void; onSwap: (dimension: Dimension, value: string) => void; onDeep: () => void;
}) {
  const [dimension, setDimension] = useState<Dimension>('source'), [value, setValue] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false), [editError, setEditError] = useState('');
  const [editOpen, setEditOpen] = useState(false), [editSettings, setEditSettings] = useState<FusionSettings | null>(null);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [editComparison, setEditComparison] = useState<{ version: number; body: { zh: string; en: string } } | null>(null);
  const facts = (result: FusionRow): Record<string, string> => Object.fromEntries([
    ['造型母体', result.source.name], ['主题灵感', result.concept.name],
    ...CONFIG.filter(config => !['source', 'concept'].includes(config.id) && result.category[config.id]).map(config => [config.title, result.detail[config.id] || result.category[config.id]]),
    ...TRAITS.filter(trait => result.design?.traits[trait.id]).map(trait => [trait.title, result.design!.traits[trait.id].map(value => value.zh).join('、')]),
    ...(result.cards || []).map(card => [card.title, card.label]),
    ...Object.entries(result.catalogueSnapshot?.selections || {}).flatMap(([id, values]) => { const snapshot = result.catalogueSnapshot!, category = snapshot.categories.find(category => category.id === id); return category ? [[category.nameZh, values.map(id => snapshot.terms.find(term => term.id === id)?.nameZh).filter(Boolean).join('、')]] : []; }),
  ].filter(([, value]) => Boolean(value))) as Record<string, string>;
  const rowFacts = facts(row), otherFacts = peers.filter(peer => peer.id !== row.id).map(facts);
  const differences = Object.entries(rowFacts).filter(([key, value]) => !otherFacts.length || otherFacts.some(peer => peer[key] !== value));
  const options = allowed(settings, dimension);
  const previewLanguages: Array<'zh' | 'en'> = settings.lang === 'both' ? ['zh', 'en'] : [settings.lang];
  const englishReady = !textFor(row, { ...settings, lang: 'en' }).includes('英文尚待补齐');
  const excludedCount = CONFIG.filter(c => row.category[c.id] && settings.rules[c.id].some(t => t.label === row.category[c.id] && t.status === 'exclude' && !t.definitionOnly)).length
    + (row.cards || []).filter(c => settings.cards.find(card => card.id === c.id)?.tags.some(t => t.label === c.label && t.status === 'exclude')).length;
  return <article id={`fusion-result-${row.id}`} className={`${styles.resultRow} ${checked ? styles.selected : ''} ${chatTargeted ? styles.chatTargeted : ''}`}>
    <small className={styles.stableIdentity}>{label}</small>
    <div className={styles.resultHeading}><label><input type="checkbox" checked={checked} onChange={onSelect} aria-label={`选择${row.name}`} /><strong>{row.name}</strong></label><button type="button" aria-pressed={retained} disabled={!writable} onClick={onRetain}>{retained ? '已保留，重抽时不替换' : '重抽时保留'}</button></div>
    <dl className={styles.resultDifferences}>{(differences.length ? differences : Object.entries(rowFacts)).slice(0, 6).map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl>{differences.length > 6 && <details className={styles.moreDifferences}><summary>另外{differences.length - 6}项不同</summary><dl className={styles.resultDifferences}>{differences.slice(6).map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl></details>}
    <details className={styles.prompt}><summary>查看完整{LANGUAGE_LABELS[settings.lang]}提示词</summary>{previewLanguages.map(language => <div key={language}>{settings.lang === 'both' && <small>{LANGUAGE_LABELS[language]}</small>}<p lang={language === 'en' ? 'en' : 'zh-CN'}>{textFor(row, { ...settings, lang: language })}</p></div>)}</details>
    <div className={styles.rowActions}><button type="button" aria-pressed={chatTargeted} disabled={!writable} onClick={onChat}>聊这张</button><button onClick={onCopy}><Copy size={15} />复制{LANGUAGE_LABELS[settings.lang]}</button><details className={styles.advanced} onToggle={e => { if (!e.currentTarget.open) setSwapOpen(false); }}><summary>调整与详情</summary>
      <dl className={styles.metadata}><div><dt>母体</dt><dd>{row.source.name}</dd></div><div><dt>跨界概念</dt><dd>{row.concept.name}</dd></div><div className={styles.bridge}><dt>连接点 / 机制</dt><dd>{row.bridge}</dd></div>{row.cards?.map(c => <div key={c.id}><dt>{c.title}</dt><dd>{c.label}</dd></div>)}{TRAITS.filter(t => row.design?.traits[t.id]).map(t => <div key={t.id}><dt>{t.title}</dt><dd>{row.design!.traits[t.id].map(v => v.zh).join('、')}</dd></div>)}</dl>
      {(row.role || row.category.personality) && <p>{[row.role, row.category.personality].filter(Boolean).join(' · ')}</p>}
      <div className={styles.actions}><button aria-expanded={swapOpen} onClick={() => { setSwapOpen(v => !v); setValue(options[0] || ''); }}><RefreshCw size={15} />只换一项</button><button disabled={loadingEdit} onClick={() => { setLoadingEdit(true); setEditError(''); void onLoadEdit().then(draft => { setEditSettings(draft.settings); setEditVersion(draft.version); setEditComparison(null); setEditOpen(true); }).catch(e => setEditError(e instanceof Error ? e.message : '原结果设置读取失败，当前内容保留。')).finally(() => setLoadingEdit(false)); }}>{loadingEdit ? '读取原设置…' : '调整具体选项与属性'}</button><button disabled={!writable} onClick={onRewrite}>随机重组</button><button disabled={!writable} onClick={onDeep}>{row.advanced ? '恢复基础提示词' : '扩写三阶段结构'}</button></div>
      <dl className={styles.ruleChecks}><div><dt>英文</dt><dd>{englishReady ? '可复制' : '待补齐'}</dd></div><div><dt>当前排除规则</dt><dd>{excludedCount ? `${excludedCount} 项冲突` : '无冲突'}</dd></div><div><dt>扩写状态</dt><dd>{row.advanced ? '收纳 / 启动 / 释放三阶段' : '基础提示词'}</dd></div></dl>
      <p className={styles.dimensionSummary}>{CONFIG.filter(c => row.category[c.id]).map(c => `${c.title}：${row.category[c.id]}`).join(' · ')}</p>
    </details></div>
    {editError && <p className={styles.error} role="alert">{editError}</p>}
    {editOpen && editSettings && <section aria-label={`调整${row.name}`}><CatalogueEditor settings={editSettings} onChange={setEditSettings} fullCatalogue={fullCatalogue} /><div className={styles.actions}><button className={styles.primary} disabled={!writable || editVersion === null || loadingEdit} onClick={() => { if (editVersion === null) return; setEditError(''); void onEdit(editSettings, editVersion).then(ok => { if (ok) setEditOpen(false); else setEditError('保存尚未确认，编辑草稿已保留。请核对当前结果或原操作；若此条已更新，可核对新版本后继续使用草稿。'); }); }}>应用到此条</button><button onClick={() => setEditOpen(false)}>取消</button></div>
      {(editError || editComparison) && <div className={styles.cardPreview}><button disabled={loadingEdit} onClick={() => { setLoadingEdit(true); void onLoadEdit().then(current => { if (current.version === null) return; setEditComparison({ version: current.version, body: current.body }); }).catch(e => setEditError(e instanceof Error ? e.message : '当前结果读取失败，编辑草稿保留。')).finally(() => setLoadingEdit(false)); }}>{loadingEdit ? '正在读取当前结果…' : '核对新版本，保留草稿'}</button>{editComparison && <><p>以下是刚读取的当前结果；上方编辑草稿保持不变。</p>{previewLanguages.map(language => <p key={language} lang={language === 'en' ? 'en' : 'zh-CN'}>{editComparison.body[language]}</p>)}<button disabled={editVersion === editComparison.version} onClick={() => { setEditVersion(editComparison.version); setEditError(''); }}>{editVersion === editComparison.version ? '已核对，草稿尚未应用' : '已核对，以新版本继续编辑'}</button></>}</div>}
    </section>}
    {swapOpen && <form className={styles.swapForm} onSubmit={e => { e.preventDefault(); onSwap(dimension, value); }}><label>维度<select value={dimension} onChange={e => { const id = e.target.value as Dimension; setDimension(id); setValue(allowed(settings, id)[0] || ''); }}>{CONFIG.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>替换为<select value={value} onChange={e => setValue(e.target.value)}>{ADDONS.some(c => c.id === dimension) && <option value="">本轮不使用</option>}{options.map(option => <option key={option}>{option}</option>)}</select></label><button disabled={!writable}>应用替换</button></form>}
  </article>;
}
