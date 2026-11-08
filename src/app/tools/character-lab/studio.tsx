'use client';
import { imageStudioPricingChannelId } from '@/lib/image-studio/channels';
import { usePricingModelAvailability } from '@/lib/pricing/use-model-availability';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy, Download, Grid2X2, History, ImagePlus, Loader2, Maximize2, Plus, RefreshCw, Save, Settings2, SlidersHorizontal, UserRound, X } from 'lucide-react';
import { useMaterialArrival } from '@/components/useMaterialArrival';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { ImageGenerationChannelSelect } from '@/components/ImageGenerationChannelSelect';
import { ImageUsageProjectSelect } from '@/components/ImageUsageProjectSelect';
import { CharacterLabImage as ReturnedImage, CharacterLabMediaProvider, CharacterLabPreview } from './images';
import { CharacterLabPromptPanel } from './prompt-panel';
import { CharacterLabWorkbench, type LabEditorIntent } from './workbench';
import { FrontVersionPicker } from './front-version-picker';
import { RelativeTime } from '@/components/RelativeTime';
import { ImageFeishuStatus } from '@/components/image-studio/ImageFeishuStatus';
import { ImageResultStatusDetails } from '@/components/ImageResultStatusDetails';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { uploadFileAsAsset, type UploadProgressHandler } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import { copyPngBlob } from '@/lib/media/copy-image';
import { handImageDownloadToBrowser } from '@/lib/media/native-download';
import { imageUiQuoteFields, imageUiQuotePriceText, validImageUiQuote } from '@/app/image-studio/use-studio-batch';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, imageStudioNewQualityOptions, imageStudioQualityLabel } from '@/lib/image-studio/model-catalog';
import { imageStudioChannelModel, imageStudioChannelModels, imageStudioEffectiveChannelId, imageStudioUsesLegacyRoute, normalizeImageStudioChannels } from '@/lib/image-studio/channels';
import { faceLabPrompt, labDefaultStageStyles, labDefaultViewPrompts, labStyleField, labViewPrompt, labViewPromptFields } from '@/lib/character-lab/prompts';
import { characterLabIsGrid, characterLabMediaUrl, characterLabSlot, characterLabSlotsOverlap, characterLabReferenceSlot, characterLabStrength, sameLabReference, type CharacterLabRestoredSettings, type CharacterLabOperation, type CharacterLabReference, type CharacterLabView, type CharacterLabBootstrap, type CharacterLabConfig, type CharacterLabDraft, type CharacterLabFace, type CharacterLabPlan, type CharacterLabPromptFields, type CharacterLabQuote, type CharacterLabStage, type CharacterLabTask, type CharacterLabWorkspace, type CharacterLabWorkspacePayload } from '@/lib/character-lab/types';
import { labPersonalFields } from '@/lib/character-lab/contexts';
import styles from './studio.module.css';

const stages: Array<{ id: CharacterLabStage | 'body'; label: string }> = [{ id: 'faces', label: '人脸生成' }, { id: 'selection', label: '方案选择' }, { id: 'body', label: '全身正反面' }, { id: 'result', label: '成品预览' }];
type PromptTarget = CharacterLabPlan['kind'] | CharacterLabOperation;
type HistoryGroup = 'faces' | 'side' | 'body' | 'legacy';
function historyGroupOf(plan: CharacterLabPlan): HistoryGroup {
  return plan.operation?.startsWith('body-') ? 'body' : plan.operation === 'side' || plan.operation === 'refine-side' ? 'side' : plan.kind === 'faces' ? 'faces' : 'legacy';
}
type Refinement = { operation: 'refine-face' | 'refine-side'; target: CharacterLabReference; text: string; planId?: string };
const viewTitles = { side: '侧脸', 'body-front': '正面全身', 'body-back': '背面全身' };
const promptTitles: Record<PromptTarget, string> = {
  faces: '人脸候选提示词', result: '旧版整图提示词',
  'refine-face': '正脸微调提示词', side: '侧脸提示词', 'refine-side': '侧脸微调提示词',
  'body-front': '正面全身提示词', 'body-back': '背面全身提示词', 'body-pair': '正背面生成提示词',
};
function pendingLabPlans(payload: CharacterLabWorkspacePayload, pending: string[]) {
  return Array.from(new Set([...pending, ...payload.plans.filter(plan => payload.submissionByRequestId[plan.id] === 'submitting').map(plan => plan.id)]))
    .filter(id => !payload.taskByRequestId[id] && payload.submissionByRequestId[id] !== 'rejected');
}
const faceStyleField = ['styleConstraints', '正脸风格约束', '仅用于正脸候选和正脸微调'] as const;
const promptFields = {
  faces: [
    ['basePrompt', '明显变化 · 基础提示词', '明显变化档的候选生成规则'],
    ['characterContext', '角色上下文要求', '从原图理解角色时需要保留的身份与特征'],
    ['faceVariables', '明显变化 · 面部变量', '明显变化档的骨相和五官规则'],
    faceStyleField,
  ],
  result: [
    ['resultPrompt', '成品生成规则', '面部一致性、服装与四格构图要求'],
    ['resultStyleConstraints', '旧版整图风格约束', '仅用于旧版整图'],
  ],
} as const;
const sameFace = (a: CharacterLabFace | null, b: CharacterLabFace) => a?.planId === b.planId && a.cell === b.cell;
const taskState: Record<string, string> = { queued: '排队中', running: '生成中', succeeded: '已生成', failed: '生成失败', canceled: '已取消', uncertain: '结果待核对', billing_pending: '费用待核对' };
function readableError(error: unknown) { return error instanceof Error ? error.message : '操作尚未完成，请重试'; }
async function labApi<T>(body?: Record<string, unknown>, query = '') {
  const response = await fetch(`/api/character-lab${query}`, { cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await readJsonResponse<T & { error?: string; submitted?: boolean | null }>(response);
  if (!response.ok) throw Object.assign(new Error(data.error || '操作尚未确认，已有输入保留'), { status: response.status, submitted: data.submitted });
  return data;
}
function fieldsOf(config: CharacterLabConfig): CharacterLabPromptFields {
  const { revision, updatedAt, ...fields } = config;
  return { ...labDefaultStageStyles, ...labDefaultViewPrompts, ...fields };
}
export default function CharacterLabStudio({ ownerId, isAdmin, initialWorkspaceId, initialPrompts, initialBody }: { ownerId: string; isAdmin: boolean; initialWorkspaceId?: string; initialPrompts?: boolean; initialBody?: boolean }) {
  const { isAvailable: modelAvailable, reason: modelAvailabilityReason } = usePricingModelAvailability();
  const session = useAppSession();
  const { confirm, prompt: askName, productDialog } = useProductDialog();
  const [bootstrap, setBootstrap] = useState<CharacterLabBootstrap | null>(null);
  const [workspace, setWorkspace] = useState<CharacterLabWorkspace | null>(null);
  const sourceArrival = useMaterialArrival(`${ownerId}:${workspace?.id || ''}`);
  const [draft, setDraft] = useState<CharacterLabDraft | null>(null);
  const [plans, setPlans] = useState<CharacterLabPlan[]>([]);
  const [tasks, setTasks] = useState<Record<string, CharacterLabTask | null>>({});
  const [source, setSource] = useState<CharacterLabWorkspacePayload['sourceAsset']>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'failed'>('saved');
  const [saveConflict, setSaveConflict] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false), [uploading, setUploading] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [advanced, setAdvanced] = useState(false);
  const [historyGroup, setHistoryGroup] = useState<HistoryGroup>('side');
  const [pendingPlanIds, setPendingPlanIds] = useState<string[]>([]);
  const [legacyView, setLegacyView] = useState(false);
  const [legacyResultOpen, setLegacyResultOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(Boolean(initialBody));
  const [bodyPreviewId, setBodyPreviewId] = useState<string | null>(null);
  const [facePreviewId, setFacePreviewId] = useState<string | null>(null);
  const [frontPreview, setFrontPreview] = useState<CharacterLabFace | null>(null);
  const [resultPreviewId, setResultPreviewId] = useState<string | null>(null);
  const [viewPreviews, setViewPreviews] = useState<Partial<Record<CharacterLabView, string>>>({});
  const [recipeTarget, setRecipeTarget] = useState<PromptTarget | 'front' | null>(null);
  const [recipeTab, setRecipeTab] = useState<'current' | 'next'>('current');
  const [compositionSlot, setCompositionSlot] = useState<{ id: string; slot: 'mainFace' | 'side' | 'front' | 'back' } | null>(null);
  const [inspectionId, setInspectionId] = useState<string | null>(null);
  const [refinement, setRefinement] = useState<Refinement | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const refineDialog = useRef<HTMLDialogElement>(null);
  const [exportMode, setExportMode] = useState<'sheet' | 'cells' | 'all'>('all');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const [promptTarget, setPromptTarget] = useState<PromptTarget | 'current' | null>(initialPrompts && isAdmin ? 'current' : null);
  const [configDraft, setConfigDraft] = useState<CharacterLabPromptFields | null>(null);
  const [configError, setConfigError] = useState('');
  const promptDialog = useRef<HTMLDialogElement>(null);
  const recipeTrigger = useRef<HTMLElement | null>(null);
  const viewSignature = useRef('');
  viewSignature.current = JSON.stringify([facePreviewId, frontPreview, bodyPreviewId, resultPreviewId, viewPreviews, recipeTarget, compositionSlot, inspectionId, refinement]);
  const initialized = useRef(false);
  const workspaceRef = useRef(workspace), draftRef = useRef(draft), alive = useRef(true), busyRef = useRef(false), scope = useRef(0), loadSequence = useRef(0), savePromise = useRef<Promise<void> | null>(null), savedSignature = useRef(''), pendingRef = useRef<string[]>([]);
  workspaceRef.current = workspace; draftRef.current = draft;
  const sessionReady = session.hasLoadedUser && !session.userLoadError && !session.sessionChanged && session.user?.id === ownerId;
  const active = useRef(false); active.current = sessionReady && !isClientSessionBlocked();
  const positionKey = `sd2:character-lab:position:v1:${ownerId}`;
  const pendingKey = useCallback((id: string) => `sd2:character-lab:submission:v1:${ownerId}:${id}`, [ownerId]);
  const dirty = Boolean(workspace && draft && savedSignature.current !== JSON.stringify([workspace.name, draft]));
  const activePromptTarget = promptTarget === 'current' ? (draft?.stage === 'result' ? 'result' : 'faces') : promptTarget;
  const activePromptFields: readonly (readonly [keyof CharacterLabPromptFields, string, string])[] =
    !activePromptTarget ? [] : activePromptTarget === 'faces' || activePromptTarget === 'result' ? promptFields[activePromptTarget]
      : [[labViewPromptFields[activePromptTarget], '生成规则', '只用于当前设置'], [labStyleField(activePromptTarget), activePromptTarget.startsWith('body-') ? '前后身风格约束' : activePromptTarget === 'refine-face' ? '正脸风格约束' : '侧脸风格约束', '只用于对应部位的生成与微调']];
  const savedPromptFields = bootstrap ? fieldsOf(bootstrap.config) : null;
  const promptOpen = Boolean(isAdmin && sessionReady && !loading && activePromptTarget && bootstrap && configDraft);
  const configDirty = Boolean(configDraft && bootstrap && JSON.stringify(configDraft) !== JSON.stringify(savedPromptFields));
  const scopedConfigDirty = activePromptFields.some(([field]) => configDraft?.[field] !== savedPromptFields?.[field]);
  usePageExitRisk({
    unsaved: [
      ...(dirty && saveState !== 'saved' ? ['角色工作现场尚未保存'] : []),
      ...(configDirty ? ['管理员提示词尚未保存'] : []),
    ],
    busy: busy === 'config' ? ['提示词保存尚未确认'] : busy === 'submit' || uploading ? ['角色任务提交或素材上传尚未确认'] : [],
    revision: JSON.stringify([workspace?.id, draft, configDirty && configDraft]),
  });
  useDialogDismiss({
    open: promptOpen, dialogRef: promptDialog, nativeDialog: true,
    dismissOnOutside: busy !== 'config', dismissOnEscape: busy !== 'config', onDismiss: closePrompts,
  });
  useEffect(() => {
    if (!promptOpen) return;
    const dialog = promptDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [promptOpen]);
  const refinementVisible = Boolean(refineOpen && refinement && sessionReady);
  useDialogDismiss({ open: refinementVisible, dialogRef: refineDialog, nativeDialog: true, dismissOnEscape: !recipeTarget, onDismiss: () => { setRefineOpen(false); setRecipeTarget(null); } });
  useEffect(() => {
    if (!refinementVisible) return;
    const dialog = refineDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [refinementVisible]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; scope.current++; }; }, []);
  function assertActive() { if (!active.current || isClientSessionBlocked()) throw new Error('请先确认当前账号，工作现场已保留'); }
  function updateDraft(patch: Partial<CharacterLabDraft>) {
    if (!active.current || busyRef.current) return;
    if (patch.stage && patch.stage !== 'result') {
      setBodyOpen(false);
      if (recipeTarget) setRecipeTarget('faces');
      const url = new URL(window.location.href);
      if (url.searchParams.get('view') === 'body') { url.searchParams.delete('view'); window.history.replaceState(window.history.state, '', url); }
    }
    if (patch.sourceAssetId !== undefined && patch.sourceAssetId !== draftRef.current?.sourceAssetId) {
      setFacePreviewId(null); setBodyPreviewId(null); setResultPreviewId(null); setViewPreviews({}); setInspectionId(null);
      patch = { ...patch, settingsSource: undefined };
    }
    setDraft(current => current ? { ...current, ...patch } : current); setSaveState('dirty'); setNotice('');
  }
  const writePending = useCallback((ids: string[], workspaceId: string) => {
    const key = pendingKey(workspaceId);
    // Preserve the original single-request storage key and use a distinct format for new clients.
    if (ids.length) localStorage.setItem(key + ':slots', JSON.stringify(ids));
    else localStorage.removeItem(key + ':slots');
    localStorage.removeItem(key);
    pendingRef.current = ids;
    setPendingPlanIds(ids);
  }, [pendingKey]);
  const acceptWorkspace = useCallback((value: CharacterLabWorkspacePayload) => {
    const input = value.workspace.views ? { ...value.workspace.draft, views: value.workspace.views } : value.workspace.draft;
    workspaceRef.current = value.workspace; draftRef.current = input;
    savedSignature.current = JSON.stringify([value.workspace.name, input]);
    setWorkspace(value.workspace); setDraft(input); setPlans(value.plans); setTasks(value.taskByRequestId); setSource(value.sourceAsset); setSaveState('saved'); setSaveConflict(false);
    setLegacyResultOpen(Boolean(input.resultPlanId && !value.workspace.views));
    setHistoryGroup(input.resultPlanId && !value.workspace.views ? 'legacy' : 'side');
    const url = new URL(window.location.href);
    setBodyOpen(url.searchParams.get('view') === 'body');
    if (url.searchParams.get('view') === 'body') { url.searchParams.set('workspace', value.workspace.id); window.history.replaceState(window.history.state, '', url); }
    setLegacyView(false); setRefineOpen(false); setRefinement(null);
    const front = input.views?.['body-front'], back = input.views?.['body-back'];
    setBodyPreviewId(front?.cell === 0 && back?.cell === 1 && front.planId === back.planId ? front.planId : null);
    setFacePreviewId(null); setFrontPreview(null); setResultPreviewId(null); setViewPreviews({}); setRecipeTarget(null); setRecipeTab('current'); setCompositionSlot(null); setInspectionId(null);
    try {
      const remembered = JSON.parse(localStorage.getItem(`sd2:character-lab:view:v2:${ownerId}:${value.workspace.id}`) || 'null');
      if (remembered && remembered.sourceAssetId === input.sourceAssetId) {
        const readable = (id: unknown) => typeof id === 'string' && value.plans.some(plan => plan.id === id) ? id : null;
        setFacePreviewId(readable(remembered.face)); setBodyPreviewId(readable(remembered.body)); setResultPreviewId(readable(remembered.result));
        setInspectionId(readable(remembered.inspection));
        const front = remembered.front;
        const frontPlan = value.plans.find(plan => plan.id === front?.planId && plan.kind === 'faces'
          && (!plan.operation || plan.operation === 'refine-face') && plan.sourceAssetId === input.sourceAssetId);
        if (frontPlan && Number.isInteger(front.cell) && front.cell >= 0 && front.cell < frontPlan.count
          && value.taskByRequestId[frontPlan.id]?.asset) setFrontPreview({ planId: frontPlan.id, cell: front.cell });
        if (remembered.views && typeof remembered.views === 'object') setViewPreviews(Object.fromEntries(['side', 'body-front', 'body-back'].flatMap(slot => readable(remembered.views[slot]) ? [[slot, remembered.views[slot]]] : [])));
        if (typeof remembered.target === 'string' && ['faces', 'result', 'front', ...Object.keys(labViewPromptFields)].includes(remembered.target)) setRecipeTarget(remembered.target as PromptTarget | 'front');
        if (remembered.tab === 'next') setRecipeTab('next');
        if (remembered.composition && ['mainFace', 'side', 'front', 'back'].includes(remembered.composition.slot)
          && value.workspace.compositions?.some(item => item.id === remembered.composition.id && item.sources)) setCompositionSlot(remembered.composition);
        const refinement = remembered.refinement, target = refinement?.target;
        if (refinement && ['refine-face', 'refine-side'].includes(refinement.operation) && readable(target?.planId)
          && (target.cell === undefined || Number.isInteger(target.cell) && target.cell >= 0 && target.cell <= 8)
          && typeof refinement.text === 'string' && refinement.text.length <= 3000) setRefinement({
          operation: refinement.operation, target: { planId: target.planId, ...(target.cell !== undefined ? { cell: target.cell } : {}) },
          text: refinement.text, ...(readable(refinement.planId) ? { planId: refinement.planId } : {}),
        });
      }
    } catch { /* Optional browsing state never replaces saved selections or submits a task. */ }
    let remembered: string[] = [];
    try {
      localStorage.setItem(positionKey, value.workspace.id);
      const key = pendingKey(value.workspace.id), legacy = localStorage.getItem(key);
      const stored: unknown = JSON.parse(localStorage.getItem(key + ':slots') || 'null');
      if (Array.isArray(stored)) remembered = stored.filter((id): id is string => typeof id === 'string');
      if (legacy) remembered.push(legacy);
    } catch { setNotice('浏览器无法记住最后位置；服务器已保存的工作区仍可手动打开。'); }
    const unresolved = pendingLabPlans(value, remembered);
    try { writePending(unresolved, value.workspace.id); }
    catch { pendingRef.current = unresolved; setPendingPlanIds(unresolved); }
    const address = new URL(window.location.href); address.searchParams.set('workspace', value.workspace.id); window.history.replaceState(window.history.state, '', address);
    setBootstrap(current => current ? { ...current, workspaces: [value.workspace, ...current.workspaces.filter(item => item.id !== value.workspace.id)] } : current);
  }, [positionKey, pendingKey, writePending, ownerId]);
  async function openWorkspace(id: string) {
    assertActive(); const sequence = ++loadSequence.current; scope.current++; setLoading(true); setError('');
    try { const value = await labApi<CharacterLabWorkspacePayload>(undefined, `?workbench=2&workspace=${encodeURIComponent(id)}`); if (alive.current && sequence === loadSequence.current && active.current) acceptWorkspace(value); }
    catch (cause) { if (alive.current && sequence === loadSequence.current) setError(readableError(cause)); }
    finally { if (alive.current && sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => {
    if (!sessionReady || initialized.current) return;
    initialized.current = true;
    const sequence = ++loadSequence.current;
    void (async () => {
      setLoading(true);
      try {
        const value = await labApi<CharacterLabBootstrap>();
        if (!alive.current || !active.current || sequence !== loadSequence.current) return;
        setBootstrap(value); if (isAdmin) setConfigDraft(fieldsOf(value.config));
        let saved = '';
        try { saved = localStorage.getItem(positionKey) || ''; } catch { /* The project selector remains usable. */ }
        const requested = initialWorkspaceId || saved;
        const id = value.workspaces.find(item => item.id === requested)?.id || (!initialWorkspaceId ? value.workspaces[0]?.id : undefined);
        if (initialWorkspaceId && !id) setError('指定角色工作区不存在或已无权访问，请从角色列表重新选择。');
        if (id) {
          const payload = await labApi<CharacterLabWorkspacePayload>(undefined, `?workbench=2&workspace=${encodeURIComponent(id)}`);
          if (alive.current && active.current && sequence === loadSequence.current) acceptWorkspace(payload);
        }
      } catch (cause) { if (alive.current && sequence === loadSequence.current) setError(readableError(cause)); }
      finally { if (alive.current && sequence === loadSequence.current) setLoading(false); }
    })();
  }, [ownerId, isAdmin, sessionReady, initialWorkspaceId, positionKey, acceptWorkspace]); // Read-only recovery never submits a task.
  useEffect(() => {
    if (!sessionReady) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`sd2:character-lab:ui:v1:${ownerId}`) || 'null');
      if (saved && typeof saved === 'object') {
        const value = saved as { exportMode?: unknown; advanced?: unknown; historyOpen?: unknown };
        if (value.exportMode === 'sheet' || value.exportMode === 'cells' || value.exportMode === 'all') setExportMode(value.exportMode);
        if (typeof value.advanced === 'boolean') setAdvanced(value.advanced);
        if (typeof value.historyOpen === 'boolean') setHistoryOpen(value.historyOpen);
      }
    } catch { /* Optional display preferences never replace the server workspace. */ }
    setPreferencesReady(true);
  }, [ownerId, sessionReady]);
  useEffect(() => {
    if (!preferencesReady || !sessionReady) return;
    try { localStorage.setItem(`sd2:character-lab:ui:v1:${ownerId}`, JSON.stringify({ exportMode, advanced, historyOpen })); }
    catch { /* Content and plans are saved on the server. */ }
  }, [ownerId, preferencesReady, sessionReady, exportMode, advanced, historyOpen]);
  useEffect(() => {
    if (!workspace || !draft || loading || !sessionReady) return;
    try { localStorage.setItem(`sd2:character-lab:view:v2:${ownerId}:${workspace.id}`, JSON.stringify({
      sourceAssetId: draft.sourceAssetId, face: facePreviewId, body: bodyPreviewId, result: resultPreviewId,
      views: viewPreviews, front: frontPreview, target: recipeTarget, tab: recipeTab, refinement, composition: compositionSlot, inspection: inspectionId,
    })); } catch { /* Server-saved input and selected images remain available. */ }
  }, [ownerId, workspace, draft, loading, sessionReady, facePreviewId, frontPreview, bodyPreviewId, resultPreviewId, viewPreviews, recipeTarget, recipeTab, refinement, compositionSlot, inspectionId]);
  async function saveDraft() {
    assertActive();
    if (savePromise.current) await savePromise.current;
    const current = workspaceRef.current, input = draftRef.current;
    if (!current || !input || savedSignature.current === JSON.stringify([current.name, input])) return;
    const signature = JSON.stringify([current.name, input]), capturedScope = scope.current;
    setSaveState('saving');
    const promise = (async () => {
      const result = await labApi<{ workspace: CharacterLabWorkspace }>({ action: 'save-workspace', id: current.id, revision: current.revision, name: current.name, draft: input });
      if (!alive.current || capturedScope !== scope.current || !active.current) return;
      const latest = workspaceRef.current;
      if (!latest || latest.id !== current.id) return;
      const next = { ...result.workspace, name: latest.name };
      workspaceRef.current = next; setWorkspace(next); savedSignature.current = signature;
      setSaveState(JSON.stringify([latest.name, draftRef.current]) === signature ? 'saved' : 'dirty');
      setBootstrap(previous => previous ? { ...previous, workspaces: [next, ...previous.workspaces.filter(item => item.id !== next.id)] } : previous);
    })();
    savePromise.current = promise;
    try { await promise; } catch (cause) { if (alive.current && capturedScope === scope.current) { setSaveState('failed'); setSaveConflict(Boolean(cause && typeof cause === 'object' && 'status' in cause && cause.status === 409)); setError(readableError(cause)); } throw cause; }
    finally { if (savePromise.current === promise) savePromise.current = null; }
  }
  useEffect(() => {
    if (!workspace || !draft || !sessionReady || saveState !== 'dirty') return;
    const timer = setTimeout(() => { void saveDraft().catch(() => {}); }, 650);
    return () => clearTimeout(timer);
  }, [draft, workspace?.name, sessionReady, saveState]);
  const refreshTasks = useCallback(async () => {
    const id = workspaceRef.current?.id, capturedScope = scope.current;
    if (!id || !active.current) return;
    const result = await labApi<CharacterLabWorkspacePayload>(undefined, `?workbench=2&workspace=${encodeURIComponent(id)}`);
    if (!alive.current || capturedScope !== scope.current || !active.current) return;
    setPlans(result.plans); setTasks(result.taskByRequestId);
    const old = pendingRef.current, pending = pendingLabPlans(result, old);
    if (old.length !== pending.length || old.some(id => !pending.includes(id))) {
      try { writePending(pending, id); }
      catch { pendingRef.current = pending; setPendingPlanIds(pending); }
      const accepted = result.plans.find(plan => old.includes(plan.id) && result.taskByRequestId[plan.id]);
      if (accepted) {
        const draft = draftRef.current;
        if (draft && !accepted.operation && accepted.sourceAssetId === draft.sourceAssetId) {
          const next = { ...draft, ...(accepted.kind === 'faces' ? { facePlanId: accepted.id } : { resultPlanId: accepted.id }) };
          draftRef.current = next; setDraft(next); setSaveState('dirty');
        }
        setNotice('已核对到原任务，可在本次结果或历史中查看。');
        void session.refreshCredits();
      }
    }
  }, [writePending, session.refreshCredits]);
  const hasRunning = Object.values(tasks).some(task => task && ['queued', 'running'].includes(task.status));
  useEffect(() => {
    if (!workspace || !sessionReady || (!hasRunning && !pendingPlanIds.length)) return;
    let checking = false, unknownChecks = 0;
    const timer = setInterval(() => {
      if (document.hidden || checking || (pendingRef.current.length && unknownChecks >= 12 && !hasRunning)) return;
      checking = true; if (pendingRef.current.length) unknownChecks++;
      void refreshTasks().catch(() => {}).finally(() => { checking = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [workspace?.id, sessionReady, hasRunning, pendingPlanIds.length, refreshTasks]);
  async function run(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setNotice('');
    try { assertActive(); await action(); } catch (cause) { if (alive.current) setError(readableError(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(''); }
  }
  async function createWorkspace() {
    const capturedScope = scope.current, id = crypto.randomUUID();
    let awaiting = false, submittedName = '';
    await askName('角色名称', '未命名角色', { title: '新建角色', confirmLabel: '创建角色', maxLength: 80, onSubmit: async name => {
      assertActive();
      if (!alive.current || capturedScope !== scope.current) throw new Error('当前角色已变化，请返回原角色操作。');
      if (busyRef.current) throw new Error('请等待当前操作结束。');
      if (awaiting && name !== submittedName) throw new Error('原创建结果待确认，尚未提交新名称。请先核对原角色。');
      busyRef.current = true; setBusy('create'); setError(''); setNotice('');
      const querying = awaiting;
      try {
        if (awaiting) {
          const result = await labApi<CharacterLabWorkspacePayload>(undefined, `?workbench=2&workspace=${encodeURIComponent(id)}`);
          assertActive();
          if (!alive.current || capturedScope !== scope.current) throw new Error('当前角色已变化，请返回原角色核对创建结果。');
          scope.current++; loadSequence.current++; acceptWorkspace(result);
        } else {
          await saveDraft(); assertActive();
          if (!alive.current || capturedScope !== scope.current) throw new Error('当前角色已变化，未创建新角色。');
          awaiting = true; submittedName = name;
          const result = await labApi<{ workspace: CharacterLabWorkspace }>({ action: 'create-workspace', id, name });
          assertActive();
          if (!alive.current || capturedScope !== scope.current) throw new Error('当前角色已变化，请返回原角色核对创建结果。');
          await openWorkspace(result.workspace.id);
        }
      } catch (cause) {
        if (!querying && (cause as { status?: number }).status! < 500) awaiting = false;
        throw cause;
      } finally { busyRef.current = false; if (alive.current) setBusy(''); }
    } });
  }
  async function switchWorkspace(id: string) {
    if (id === workspace?.id) return;
    await run('open', async () => { await saveDraft(); await openWorkspace(id); });
  }
  function pendingBlocks(kind: CharacterLabPlan['kind'], operation?: CharacterLabOperation) {
    const slot = characterLabSlot({ kind, operation });
    return pendingRef.current.some(id => {
      const plan = plans.find(item => item.id === id);
      return !plan?.slotScoped || slot === 'legacy' || characterLabSlotsOverlap(plan, { kind, operation });
    });
  }
  async function generate(kind: CharacterLabPlan['kind'], operation?: CharacterLabOperation, refine?: Refinement, reproducePlanId?: string, editor?: LabEditorIntent) {
    let generatedId: string | undefined;
    await run('prepare', async () => {
      if (!workspaceRef.current || !draftRef.current) return;
      if (pendingBlocks(kind, operation)) throw new Error('这里的原提交待确认，请先核对原请求。');
      await saveDraft();
      const current = workspaceRef.current!, input = { ...draftRef.current! }, capturedScope = scope.current;
      const { plan } = await labApi<{ plan: CharacterLabPlan }>(reproducePlanId ? {
        action: 'reproduce', sourcePlanId: reproducePlanId, workspaceId: current.id, requestId: crypto.randomUUID(),
      } : {
        action: 'prepare', workspaceId: current.id, requestId: crypto.randomUUID(), workbench: operation || kind === 'faces' ? 2 : undefined,
        kind, draft: input, operation, recipeProtocol: 1, contextProtocol: 1, layoutProtocol: 1, ...(editor ? { input: editor.input, description: editor.description } : {}), ...(!editor && refine ? { input: refine.target, description: refine.text }
          : operation === 'side' ? { description: input.sideDescription || '' } : operation?.startsWith('body-') ? { description: input.bodyDescription || '' } : {}),
      });
      if (!reproducePlanId && plan.contextProtocol !== 1) throw new Error('当前服务器暂不支持独立上下文，请刷新页面；尚未提交生成。');
      if (plan.recipeProtocol !== 1) throw new Error('当前服务器暂不支持生成配方，请刷新页面；尚未提交生成。');
      assertActive(); if (capturedScope !== scope.current) return;
      const quote = await labApi<CharacterLabQuote>({ action: 'quote', planId: plan.id });
      assertActive(); if (capturedScope !== scope.current) return;
      if (!validImageUiQuote(quote)) throw new Error('报价已过期或不完整，请重新获取报价；尚未提交生成。');
      setPlans(previous => [plan, ...previous.filter(item => item.id !== plan.id)]);
      const label = characterLabIsGrid(plan) ? `生成1张${plan.count}宫格${operation === 'side' || operation === 'refine-side' ? '侧脸' : '正脸'}候选图`
        : operation === 'body-pair' ? '生成1张正背面全身对照图' : operation ? `生成1张${viewTitles[operation as CharacterLabView]}` : '生成1张旧版整图';
      if (!await confirm(`${reproducePlanId ? '按原记录的冻结提示词、参考和参数，' : ''}${label}，规则v${plan.configRevision}，${imageUiQuotePriceText(quote)}。已有图片保留。`, { title: '确认生成', confirmLabel: '开始生成' })) return;
      assertActive();
      if (capturedScope !== scope.current) throw new Error('当前角色已变化，请在原角色中查询计划。');
      if (!validImageUiQuote(quote)) throw new Error('报价已过期，请重新报价；尚未提交。');
      generatedId = plan.id;
      writePending([...pendingRef.current, plan.id], current.id);
      if (operation === 'body-pair') setBodyPreviewId(plan.id);
      if (!operation && kind === 'faces') setFacePreviewId(plan.id);
      if (!operation && kind === 'result') setResultPreviewId(plan.id);
      if (operation === 'side' || operation === 'body-front' || operation === 'body-back') setViewPreviews(previous => ({ ...previous, [operation]: plan.id }));
      if (refine) setRefinement(previous => previous ? { ...previous, planId: plan.id } : previous);
      if (!editor && reproducePlanId && (operation === 'refine-face' || operation === 'refine-side') && plan.input) {
        setRefinement({ operation, target: plan.input, text: plan.adjustment, planId: plan.id }); setRefineOpen(true);
      }
      setBusy('submit');
      try {
        await labApi({ action: 'submit', planId: plan.id, ...imageUiQuoteFields(quote) });
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'submitted' in cause && cause.submitted === false) {
          const remaining = pendingRef.current.filter(id => id !== plan.id);
          try { writePending(remaining, current.id); }
          catch { pendingRef.current = remaining; setPendingPlanIds(remaining); }
        }
        throw cause;
      } finally { await refreshTasks().catch(() => {}); }
      if (capturedScope !== scope.current || !active.current) return;
      if (!operation && !reproducePlanId) {
        const next = { ...draftRef.current!, ...(kind === 'faces' ? { facePlanId: plan.id, stage: 'faces' as const } : { resultPlanId: plan.id, stage: 'result' as const }) };
        draftRef.current = next; setDraft(next); setSaveState('dirty'); await saveDraft();
      }
      setNotice('生成任务已受理。'); void session.refreshCredits();
    });
    return generatedId;
  }
  const facePlans = plans.filter(plan => plan.kind === 'faces' && !plan.operation);
  const historyBatchNumbers = useMemo(() => {
    const counts = new Map<PromptTarget, number>();
    return new Map([...plans].reverse().map(plan => {
      const target = plan.operation || plan.kind, number = (counts.get(target) || 0) + 1;
      counts.set(target, number);
      return [plan.id, number] as const;
    }));
  }, [plans]);
  function restoreHistoryPersonal(plan: CharacterLabPlan) {
    if (plan.sourceAssetId !== draftRef.current?.sourceAssetId) return;
    updateDraft(labPersonalFields(plan));
  }
  function browseFace(plan: CharacterLabPlan) {
    setCompositionSlot(null); setInspectionId(null); setFacePreviewId(plan.id);
    restoreHistoryPersonal(plan);
    if (recipeTarget) { setRecipeTarget('faces'); setRecipeTab('current'); }
  }
  function browseHistoryPlan(plan: CharacterLabPlan) {
    setCompositionSlot(null); setHistoryGroup(historyGroupOf(plan));
    if (plan.sourceAssetId !== draft?.sourceAssetId || historyGroupOf(plan) === 'side' && !sameLabReference(plan.mainFace, draft?.mainFace)) {
      setInspectionId(plan.id); setRecipeTarget(plan.operation || plan.kind); setRecipeTab('current'); setHistoryOpen(false); return;
    }
    setInspectionId(null);
    if ((plan.operation === 'refine-face' || plan.operation === 'refine-side') && plan.input) openRefinement(plan.operation, plan.input, plan);
    else if (plan.operation === 'body-pair') { restoreHistoryPersonal(plan); showBodyGeneration(); setBodyPreviewId(plan.id); if (recipeTarget) setRecipeTarget('body-pair'); }
    else if (plan.operation) { restoreHistoryPersonal(plan); showIndependentViews(); setViewPreviews(previous => ({ ...previous, [plan.operation!]: plan.id })); if (recipeTarget) setRecipeTarget(plan.operation); }
    else if (plan.kind === 'faces') { if (historyOpen || bodyOpen || draft?.stage === 'result') updateDraft({ stage: 'selection' }); browseFace(plan); }
    else { restoreHistoryPersonal(plan); showIndependentViews(); setLegacyResultOpen(true); setResultPreviewId(plan.id); if (recipeTarget) setRecipeTarget('result'); }
    setHistoryOpen(false);
  }
  const inspectionPlan = plans.find(plan => plan.id === inspectionId);
  const resultPlans = plans.filter(plan => plan.kind === 'result' && !plan.operation);
  const facePlan = facePlans.find(plan => plan.id === draft?.facePlanId) || facePlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const resultPlan = resultPlans.find(plan => plan.id === draft?.resultPlanId) || resultPlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const viewedFace = facePlans.find(plan => plan.id === facePreviewId);
  const shownFacePlan = viewedFace && tasks[viewedFace.id]?.asset ? viewedFace : facePlan && tasks[facePlan.id]?.asset ? facePlan : facePlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const facePlanNumber = facePlan ? facePlans.length - facePlans.indexOf(facePlan) : null;
  const shownFacePlanNumber = shownFacePlan ? facePlans.length - facePlans.indexOf(shownFacePlan) : null;
  const viewedResult = resultPlans.find(plan => plan.id === resultPreviewId);
  const shownResultPlan = viewedResult && tasks[viewedResult.id]?.asset ? viewedResult : resultPlan && tasks[resultPlan.id]?.asset ? resultPlan : resultPlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const bodyPlans = plans.filter(plan => plan.operation === 'body-pair' && plan.sourceAssetId === draft?.sourceAssetId);
  const bodyAvailable = bodyPlans.filter(plan => tasks[plan.id]?.asset);
  const bodyPlan = bodyPlans.find(plan => plan.id === bodyPreviewId) || bodyPlans.find(plan => tasks[plan.id] || pendingPlanIds.includes(plan.id));
  const bodyShown = bodyAvailable.find(plan => plan.id === bodyPreviewId) || bodyAvailable[0];
  const currentPlan = bodyOpen ? bodyPlan : draft?.stage === 'result' ? (legacyResultOpen ? resultPlan : undefined) : facePlan;
  const currentTask = currentPlan ? tasks[currentPlan.id] : null;
  const resultTask = shownResultPlan ? tasks[shownResultPlan.id] : null;
  const displayedOutputTask = bodyOpen ? null : draft?.stage === 'result' ? (legacyResultOpen ? resultTask : null) : shownFacePlan ? tasks[shownFacePlan.id] : null;
  const sendPresentationLabel = draft?.stage === 'result' ? '当前生成原图' : `候选整图（完整${shownFacePlan?.count || 4}宫格）`;
  const selectedResult = workspace?.savedResults.find(item => item.planId === shownResultPlan?.id);
  const workName = draft?.resultName || '';
  const resultName = workName.trim() || selectedResult?.name || workspace?.name || '角色参考图';
  const channels = useMemo(() => normalizeImageStudioChannels(bootstrap?.settings.imageChannels), [bootstrap?.settings.imageChannels]);
  const effectiveChannel = draft ? imageStudioEffectiveChannelId(channels, draft.model, draft.channelId, draft.quality) : 'original';
  const selectedChannel = channels.items.find(item => item.id === effectiveChannel);
  const capability = draft ? imageStudioChannelModel(selectedChannel, draft.model) : undefined;
  const legacyRoute = draft ? imageStudioUsesLegacyRoute(channels, draft.model, draft.channelId) : true;
  const modelChoices = imageStudioChannelModels(channels, IMAGE_STUDIO_MODELS).filter(model => modelAvailable('image', model));
  const qualityChoices = (draft ? draft.model === 'gpt-image-2.5-sunburst' ? imageStudioNewQualityOptions(draft.model) : capability?.qualities ?? (legacyRoute ? IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[draft.model as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] : []) ?? [] : []).filter(value => Boolean(draft && modelAvailable('image', draft.model, { quality: value }, imageStudioPricingChannelId(channels, draft.model, draft.channelId, value))));
  const resolutionChoices = (draft ? capability?.resolutions ?? (legacyRoute ? IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[draft.model as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] : []) ?? [] : []).filter(value => Boolean(draft && modelAvailable('image', draft.model, { quality: draft.quality, resolution: value }, imageStudioPricingChannelId(channels, draft.model, draft.channelId, draft.quality))));
  function selectFace(face: CharacterLabFace) {
    if (!draft) return;
    setFrontPreview(face);
    updateDraft({ mainFace: face, auxiliaryFaces: draft.auxiliaryFaces.filter(item => !sameFace(item, face)) });
  }
  function toggleAuxiliary(face: CharacterLabFace) {
    if (!draft || sameFace(draft.mainFace, face)) return;
    updateDraft({ auxiliaryFaces: draft.auxiliaryFaces.some(item => sameFace(item, face)) ? draft.auxiliaryFaces.filter(item => !sameFace(item, face)) : [...draft.auxiliaryFaces, face] });
  }
  async function saveResult() {
    await run('save-result', async () => {
      await saveDraft(); const current = workspaceRef.current;
      if (!current || !shownResultPlan) return;
      const result = await labApi<{ workspace: CharacterLabWorkspace }>({ action: 'save-result', workspaceId: current.id, revision: current.revision, planId: shownResultPlan.id, name: resultName });
      workspaceRef.current = result.workspace; setWorkspace(result.workspace); setNotice('成品已保存，可随时从历史版本重新打开。');
    });
  }
  async function exportResult() {
    await run('export', async () => {
      if (!shownResultPlan) return;
      const capturedScope = scope.current;
      await handImageDownloadToBrowser(`/api/character-lab/export?plan=${encodeURIComponent(shownResultPlan.id)}&mode=${exportMode}&name=${encodeURIComponent(resultName)}`, `${resultName}.${exportMode === 'sheet' ? 'png' : 'zip'}`, () => active.current && capturedScope === scope.current);
      setNotice('已交给浏览器下载。');
    });
  }
  function closePrompts() {
    if (activePromptTarget && legacyView) { setRecipeTarget(activePromptTarget); setRecipeTab('next'); }
    else setRecipeTarget(null);
    setPromptTarget(null);
    if (promptTarget === 'current') {
      const address = new URL(window.location.href);
      address.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', address);
    }
  }
  function applyPromptVersion(version: CharacterLabConfig) {
    setConfigDraft(previous => {
      if (!previous) return previous;
      const next = { ...previous };
      const fields = fieldsOf(version);
      for (const [field] of activePromptFields) Object.assign(next, { [field]: fields[field] });
      return next;
    });
  }
  async function saveConfig() {
    if (!bootstrap || !configDraft || !scopedConfigDirty) return;
    const fields = fieldsOf(bootstrap.config);
    for (const [field] of activePromptFields) Object.assign(fields, { [field]: configDraft[field] });
    setConfigError('');
    await run('config', async () => {
      try {
        const result = await labApi<{ config: CharacterLabConfig; configVersions: CharacterLabConfig[] }>({
          action: 'save-config', contextProtocol: 1, revision: bootstrap.config.revision, fields,
        });
        if (!alive.current || !active.current) return;
        setBootstrap(current => current ? { ...current, ...result } : current);
        applyPromptVersion(result.config);
        closePrompts();
        setNotice('提示词新版本已保存，将用于之后的新生成。');
      } catch (cause) {
        if (alive.current && active.current) setConfigError(readableError(cause));
      }
    });
  }
  const locked = Boolean(busy) || uploading || loading || !sessionReady;
  const resultDetailsActive = sessionReady && !isClientSessionBlocked();
  const currentStep = bodyOpen ? 'body' : draft?.stage;
  const shownMainFace = draft?.stage === 'result' && legacyResultOpen && shownResultPlan ? shownResultPlan.mainFace : draft?.mainFace;
  const sourceId = inspectionPlan?.sourceAssetId || (bodyOpen ? draft?.sourceAssetId : draft?.stage === 'result' && legacyResultOpen && shownResultPlan ? shownResultPlan.sourceAssetId : draft?.stage === 'selection' && shownFacePlan ? shownFacePlan.sourceAssetId : draft?.sourceAssetId);
  const faceSourceMismatch = Boolean(shownFacePlan && draft && shownFacePlan.sourceAssetId !== draft.sourceAssetId);
  const sourceUrl = sourceId ? `/api/image-studio/template-assets/${encodeURIComponent(sourceId)}` : '';
  const selectedFaces = draft ? [...(draft.mainFace ? [draft.mainFace] : []), ...draft.auxiliaryFaces] : [];
  const unresolved = pendingPlanIds.length > 0;
  const facePending = pendingBlocks('faces');
  const legacyPending = pendingBlocks('result');
  const viewSlots = ['side', 'body-front', 'body-back'] as const;
  const viewSelection = (slot: CharacterLabView) => draft?.views?.[slot];
  const referencePlan = (reference: CharacterLabReference | null | undefined) => plans.find(plan => plan.id === reference?.planId);
  const frontReady = Boolean(draft?.mainFace && referencePlan(draft.mainFace)?.sourceAssetId === draft.sourceAssetId && tasks[draft.mainFace.planId]?.asset);
  const frontPlans = plans.filter(plan => plan.kind === 'faces' && (!plan.operation || plan.operation === 'refine-face')
    && plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const frontVersions = frontPlans.flatMap(plan => Array.from({ length: plan.count }, (_, cell) => ({ planId: plan.id, cell })));
  const frontShown = frontVersions.find(face => sameLabReference(face, frontPreview)) || (frontReady ? draft?.mainFace : undefined);
  const frontRefinement = refinement?.operation === 'refine-face' && sameLabReference(refinement.target, frontShown) ? refinement
    : frontShown ? { operation: 'refine-face' as const, target: frontShown, text: '' } : null;
  const viewReady = (slot: CharacterLabView, reference = viewSelection(slot)) => {
    const plan = referencePlan(reference);
    return Boolean(plan && reference && characterLabReferenceSlot(plan, reference) === slot && plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset
      && (slot !== 'side' || sameLabReference(plan.mainFace, draft?.mainFace)));
  };
  const bodyPairReady = viewReady('body-front') && viewReady('body-back')
    && draft?.views?.['body-front']?.planId === draft?.views?.['body-back']?.planId
    && referencePlan(draft?.views?.['body-front'])?.operation === 'body-pair';
  const sheetReady = frontReady && viewSlots.every(slot => viewReady(slot));
  function viewOptions(slot: CharacterLabView) {
    return plans.filter(plan => (plan.operation === slot || slot === 'side' && plan.operation === 'refine-side' || slot !== 'side' && plan.operation === 'body-pair')
      && plan.sourceAssetId === draft?.sourceAssetId && (slot !== 'side' || sameLabReference(plan.mainFace, draft?.mainFace)));
  }
  function shownView(slot: CharacterLabView): CharacterLabReference | undefined {
    const selected = viewSelection(slot), options = viewOptions(slot);
    const plan = options.find(item => item.id === viewPreviews[slot] && tasks[item.id]?.asset);
    if (plan) return selected?.planId === plan.id ? selected : { planId: plan.id, ...(plan.operation === 'body-pair' ? { cell: slot === 'body-front' ? 0 : 1 } : characterLabIsGrid(plan) ? { cell: 0 } : {}) };
    if (viewReady(slot)) return selected;
    const first = options.find(item => tasks[item.id]?.asset);
    return first ? { planId: first.id, ...(first.operation === 'body-pair' ? { cell: slot === 'body-front' ? 0 : 1 } : characterLabIsGrid(first) ? { cell: 0 } : {}) } : undefined;
  }
  const refinePlan = refinement ? (referencePlan(refinement.planId ? { planId: refinement.planId } : undefined)
    || plans.find(plan => plan.operation === refinement.operation && plan.sourceAssetId === draft?.sourceAssetId
      && sameLabReference(plan.input, refinement.target)
      && (plan.operation !== 'refine-side' || sameLabReference(plan.mainFace, draft?.mainFace)) && tasks[plan.id])) : undefined;
  const refineTask = refinePlan ? tasks[refinePlan.id] : null;
  const refineTitle = refinement?.operation === 'refine-side' ? '微调侧脸' : '微调这张脸';
  const busyCopy = ({ prepare: '正在准备生成与报价…', submit: '正在确认原请求…', config: '正在保存提示词…', export: '正在准备下载…', compose: '正在合成…' } as Record<string, string>)[busy] || (busy ? '正在处理…' : '');

  function openRefinement(operation: Refinement['operation'], target: CharacterLabReference, plan?: CharacterLabPlan) {
    setRefinement(previous => !plan && previous?.operation === operation && sameLabReference(previous.target, target)
      ? previous : { operation, target, text: plan?.adjustment || '', planId: plan?.id });
    setRefineOpen(true);
    if (recipeTarget) setRecipeTarget(operation);
  }
  function showIndependentViews() {
    setInspectionId(null);
    setBodyOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get('view') === 'body') { url.searchParams.delete('view'); window.history.replaceState(window.history.state, '', url); }
    setLegacyResultOpen(false);
    updateDraft({ stage: 'result', views: draft?.views || {} });
    if (recipeTarget) setRecipeTarget('front');
  }
  function showBodyGeneration() {
    setInspectionId(null);
    setBodyOpen(true); setLegacyResultOpen(false);
    const url = new URL(window.location.href); url.searchParams.set('view', 'body');
    if (workspace) url.searchParams.set('workspace', workspace.id);
    window.history.replaceState(window.history.state, '', url);
    updateDraft({ stage: 'result', views: draft?.views || {} });
    if (recipeTarget) setRecipeTarget('body-pair');
  }
  function chooseBodyPair(planId: string) {
    const plan = plans.find(item => item.id === planId);
    if (plan?.operation === 'body-pair' && plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset) {
      setBodyPreviewId(planId);
      updateDraft({ views: { ...draft?.views, 'body-front': { planId, cell: 0 }, 'body-back': { planId, cell: 1 } } });
    }
  }
  function chooseView(slot: CharacterLabView, choice: CharacterLabReference) {
    if (referencePlan(choice)?.operation === 'body-pair') { chooseBodyPair(choice.planId); return; }
    if (viewReady(slot, choice)) updateDraft({ views: { ...draft?.views, [slot]: choice } });
  }
  async function restoreSettings(planId: string, openRefinement = true) {
    assertActive();
    const current = workspaceRef.current, signature = JSON.stringify(draftRef.current), capturedScope = scope.current, capturedView = viewSignature.current;
    if (!current) return false;
    const restored = await labApi<CharacterLabRestoredSettings>({ action: 'restore-settings', workspaceId: current.id, planId });
    assertActive();
    if (capturedScope !== scope.current || capturedView !== viewSignature.current || JSON.stringify(draftRef.current) !== signature) throw new Error('当前查看对象或输入已变化，保留你的新编辑；需要时可再次沿用设置。');
    updateDraft(restored.patch);
    if (openRefinement && (restored.operation === 'refine-face' || restored.operation === 'refine-side') && restored.input) {
      setRefinement({ operation: restored.operation, target: restored.input, text: restored.description }); setRefineOpen(true);
    }
    setNotice('已沿用本次设置，使用当前已保存规则；原图和已选用图片保留。');
    return true;
  }
  async function repeatSettings(planId: string) {
    const sourcePlan = plans.find(plan => plan.id === planId);
    if (!sourcePlan) throw new Error('原记录已不可用，请重新读取');
    await generate(sourcePlan.kind, sourcePlan.operation, undefined, planId);
  }
  function restorePersonal(plan: CharacterLabPlan, text: string) {
    assertActive();
    if (!draftRef.current || plan.workspaceId !== workspaceRef.current?.id) throw new Error('当前角色已变化，请重新打开历史记录。');
    const target = recipeTarget === 'front' ? 'refine-face' : recipeTarget;
    if (!target) return false;
    const family = (value: PromptTarget) => value.startsWith('body-') ? 'body' : value === 'side' || value === 'refine-side' ? 'side' : value === 'result' ? 'legacy' : 'face';
    if (family(target) !== family(plan.operation || plan.kind)) throw new Error('这份补充属于其他部位，请在对应区域恢复。');
    if (target === 'refine-face' || target === 'refine-side') {
      const activeRefinement = recipeTarget === 'front' ? frontRefinement : refinement;
      const current = activeRefinement?.operation === target ? activeRefinement : null;
      const input = current?.target || (target === 'refine-face' ? frontShown : shownView('side')) || plan.input;
      if (!input) throw new Error('先选择要微调的图片，历史补充仍可复制。');
      setRefinement({ ...current, operation: target, target: input, text });
    } else {
      updateDraft(target === 'side' ? { sideDescription: text } : target === 'result'
        ? !plan.operation && plan.kind === 'result' ? { context: plan.context, adjustment: plan.adjustment } : { adjustment: text }
        : target.startsWith('body-') ? { bodyDescription: text } : { faceDescription: text });
    }
    return true;
  }
  function compositionUrl(id: string, saved?: string) {
    const query = new URLSearchParams({ workspace: id });
    if (saved) query.set('composition', saved);
    else query.set('revision', String(workspaceRef.current?.revision));
    return '/api/character-lab/compose?' + query;
  }
  function copyComposition() {
    void run('compose', async () => {
      const capturedScope = scope.current;
      const png = (async () => {
        await saveDraft();
        const current = workspaceRef.current!;
        const response = await fetch(compositionUrl(current.id), { cache: 'no-store' });
        if (!response.ok) throw new Error((await readJsonResponse<{ error?: string }>(response)).error || '合成图暂不可读，请重试');
        const blob = await response.blob();
        assertActive();
        if (capturedScope !== scope.current) throw new Error('工作区已变化，复制已取消');
        return blob;
      })();
      await copyPngBlob(png);
      setNotice('已复制合成图。');
    });
  }
  async function saveComposition() {
    await run('compose', async () => {
      await saveDraft();
      const current = workspaceRef.current!, capturedScope = scope.current;
      const { workspace: saved } = await labApi<{ workspace: CharacterLabWorkspace }>({
        action: 'save-composition', workspaceId: current.id, revision: current.revision, name: resultName,
      });
      assertActive();
      if (!alive.current || capturedScope !== scope.current) return;
      workspaceRef.current = saved; setWorkspace(saved);
      setNotice('合成图已保存，可在已保存的合成图里打开。');
    });
  }

  return <CharacterLabMediaProvider value={{ plans, tasks }}><main className={styles.root} aria-busy={loading}>
    <header className={styles.header}>
      <div className={styles.brand}><UserRound size={21} /><strong>CHARACTER LAB</strong><span>角色参考图工作台</span></div>
      {legacyView && <button type="button" onClick={() => { setLegacyView(false); setInspectionId(null); setRecipeTarget(null); }}>返回成品工作台</button>}{legacyView && <nav className={styles.steps} aria-label="角色制作阶段">{stages.map((stage, index) => <button type="button" key={stage.id} aria-current={currentStep === stage.id ? 'step' : undefined} disabled={!draft || locked} onClick={() => stage.id === 'body' ? showBodyGeneration() : stage.id === 'result' ? showIndependentViews() : updateDraft({ stage: stage.id })}><b>{draft && stages.findIndex(item => item.id === currentStep) > index ? <Check size={15} /> : index + 1}</b><span>{stage.label}</span></button>)}</nav>}
      <div className={styles.headerActions}>
        <label className={styles.workspaceLabel}><span className={styles.srOnly}>角色工作区</span><select value={workspace?.id || ''} disabled={locked || !bootstrap} onChange={event => void switchWorkspace(event.target.value)}><option value="" disabled>选择角色</option>{bootstrap?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className={styles.iconButton} disabled={locked || !bootstrap} onClick={() => void createWorkspace()} title="新建角色" aria-label="新建角色"><Plus size={18} /></button>
        {!legacyView && workspace && <><button type="button" className={styles.primary} disabled={locked || !sheetReady} onClick={() => void saveComposition()}><Save size={15} />保存版本</button><button type="button" disabled={locked || !sheetReady} onClick={copyComposition}><Copy size={15} />复制整张</button><button type="button" disabled={locked || !sheetReady} onClick={() => void run('export', async () => { await saveDraft(); const current = workspaceRef.current!; await handImageDownloadToBrowser(compositionUrl(current.id) + '&download=1', resultName + '.png', () => active.current); })}><Download size={15} />下载</button></>}
        <button type="button" aria-expanded={historyOpen} aria-controls="character-lab-history" disabled={!workspace || locked} onClick={() => setHistoryOpen(value => !value)}><History size={16} /><span>历史记录</span></button>
      </div>
    </header>
    <div className={styles.feedback} aria-live="polite">
      <span className={styles.saveIndicator}><i data-saved={saveState === 'saved'} />{!workspace ? '角色工作台' : saveState === 'saved' ? '工作现场已保存' : saveState === 'saving' ? '正在保存工作现场' : saveState === 'failed' ? '工作现场未保存' : '工作现场待保存'}</span>
      {busyCopy && <span><Loader2 className={styles.spinner} size={14} />{busyCopy}</span>}
      {notice && <span>{notice}</span>}
      {error && <span role="alert" className={styles.error}>{error}</span>}
      {saveState === 'failed' && <><button type="button" disabled={locked || saveConflict} onClick={() => void run('save', saveDraft)}>重试保存</button>{saveConflict && <button type="button" disabled={locked} onClick={() => void run('reload', async () => { if (workspace && await confirm('当前工作现场尚未保存。重新读取会采用服务器的最新版本，当前未保存的修改将丢失。', { title: '重新读取工作区', confirmLabel: '读取最新版本' })) await openWorkspace(workspace.id); })}>读取最新版本</button>}</>}
      {unresolved && <span className={styles.pending}>原提交结果待确认 <button type="button" disabled={locked} onClick={() => void run('query', refreshTasks)}>核对原请求</button></span>}
    </div>
    {!sessionReady ? <div className={styles.welcome}><UserRound size={36} /><p>正在核对当前账号，工作现场已保留。</p></div> : loading && !workspace ? <div className={styles.loading}><div /><div /><div /><span>正在恢复角色工作区…</span></div> : !workspace || !draft ? <section className={styles.welcome}><ImagePlus size={44} /><h1>从一张角色原图开始</h1><p>探索不同的真人面孔，再制作完整的角色参考图。</p><button type="button" className={styles.primary} disabled={locked || !bootstrap} onClick={() => void createWorkspace()}><Plus size={17} />新建角色</button>{error && <button type="button" onClick={() => window.location.reload()}>重新读取</button>}</section> : <>
      {!legacyView ? <CharacterLabWorkbench key={`${ownerId}:${workspace.id}:${draft.sourceAssetId || ''}`} initialPart={bodyOpen ? 'body' : 'overview'} ownerId={ownerId} workspace={workspace} draft={draft} plans={plans} tasks={tasks} isAdmin={isAdmin} locked={locked} pending={pendingPlanIds} allHistory={historyOpen} settings={renderGenerationSettings()}
        onUpdate={updateDraft} onSource={() => setPickerOpen(true)} onPreview={(src, alt) => setPreview({ src, alt })} onQuery={() => void run('query', refreshTasks)}
        onGenerate={intent => generate(!intent.operation || intent.operation === 'refine-face' || intent.operation === 'refine-side' ? 'faces' : 'result', intent.operation, undefined, undefined, intent)}
        onLegacy={plan => { setLegacyView(true); browseHistoryPlan(plan); }} onManage={target => { setPromptTarget(target); setConfigError(''); }}
        onRestore={id => restoreSettings(id, false)} onReproduce={id => { const plan = plans.find(item => item.id === id); if (!plan) return Promise.reject(new Error('原记录已不可用，请重新读取')); return generate(plan.kind, plan.operation, undefined, id, { description: plan.adjustment }); }} /> : <>
      <div className={styles.workbench}>
        <aside className={styles.materialRail}><section className={styles.materialSection}><h2>原始素材</h2>{sourceUrl ? <><button type="button" className={styles.sourceImage} data-material-arrived={draft.sourceAssetId && sourceArrival.arrived?.includes(draft.sourceAssetId) || undefined} onClick={() => setPreview({ src: sourceUrl, alt: '原始角色素材' })}><ReturnedImage src={sourceUrl} alt="原始角色素材" /></button></> : <button type="button" className={styles.uploadEmpty} disabled={locked} onClick={() => setPickerOpen(true)}><ImagePlus size={32} /><strong>添加原始素材</strong><span>上传或从素材库选择一张图片</span></button>}<button type="button" className={styles.outline} disabled={locked || unresolved} onClick={() => setPickerOpen(true)}><ImagePlus size={15} />{draft.sourceAssetId ? '更换原图' : '选择原图'}</button></section>
          {!bodyOpen && draft.stage === 'result' && shownMainFace && <section className={styles.materialSection}><div className={styles.sectionTitle}><h2>主面部 · {String(shownMainFace!.cell + 1).padStart(2, '0')}</h2><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}>更换方案<ArrowRight size={13} /></button></div><button type="button" className={styles.faceReference} onClick={() => setPreview({ src: characterLabMediaUrl(shownMainFace!.planId, shownMainFace!.cell), alt: '选定主面部' })}><ReturnedImage src={characterLabMediaUrl(shownMainFace!.planId, shownMainFace!.cell)} alt="选定主面部" /></button></section>}
          {renderHistoryCandidates()}
        </aside>
        <section className={styles.canvasColumn} aria-label={bodyOpen ? '全身正反面生成' : draft.stage === 'result' ? '角色成品预览' : '人脸候选'}>
          <div className={styles.canvasHeading}><h2>{inspectionPlan ? '历史生成图' : bodyOpen ? '生成全身正反面' : draft.stage === 'result' ? '角色参考图' : draft.stage === 'selection' ? '选择喜欢的面部方案' : '生成结果'}{!inspectionPlan && !bodyOpen && draft.stage !== 'result' && shownFacePlan && <span> · 第{shownFacePlanNumber}组 · {shownFacePlan.count}宫格</span>}</h2><div className={styles.canvasActions}>{!bodyOpen && draft.stage !== 'result' && shownFacePlan && (
            <button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(shownFacePlan.id), alt: '本批候选原图' })}><Maximize2 size={14} />查看整张宫格</button>
          )}{legacyResultOpen && shownResultPlan && resultTask?.asset && <><ImageResultStatusDetails active={resultDetailsActive}
            scopeKey={`${ownerId}:${workspace.id}:${shownResultPlan.id}:legacy-result-details`} label="查看成图规格" heading="成图规格">
            <dl><div><dt>成图比例</dt><dd>2:3</dd></div>{resultTask.asset.width && resultTask.asset.height && <div><dt>实际尺寸</dt><dd>{resultTask.asset.width}×{resultTask.asset.height}</dd></div>}</dl>
          </ImageResultStatusDetails><button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(shownResultPlan.id), alt: '角色参考图' })}><Maximize2 size={15} />放大</button></>}
          {displayedOutputTask?.asset && <ImageFeishuStatus key={`${ownerId}:${displayedOutputTask.id}`} owner={ownerId} taskId={displayedOutputTask.id} presentationLabel={sendPresentationLabel} />}<button type="button" className={styles.iconButton} disabled={locked} onClick={() => void run('query', refreshTasks)} aria-label="查询生成状态" title="查询生成状态"><RefreshCw size={16} /></button></div></div>
          {currentPlan && !currentTask && <div className={styles.taskStatus}>{currentPlan.kind === 'faces' && <span>本次{currentPlan.count}宫格 · </span>}此计划尚未提交或提交结果待核对。下方已有结果保留。</div>}
          {currentTask && <div className={styles.taskStatus} role="status">
            {['queued', 'running'].includes(currentTask.status) && <Loader2 className={styles.spinner} size={15} />}
            <span>{currentPlan?.kind === 'faces' && <>第{facePlanNumber}组 · {currentPlan.count}宫格 · </>}{taskState[currentTask.status] || '状态待确认'}{currentTask.error && <> · {currentTask.error}</>}</span>
            {bodyOpen && !currentTask.asset && bodyShown && <span>本次尚无新图，当前预览保留已有组合。</span>}
            {currentTask.resultDisposition && <span>图片已返回，请核对实际规格。</span>}
          </div>}
          {!inspectionPlan && !bodyOpen && draft.stage !== 'result' && facePlan && shownFacePlan && facePlan.id !== shownFacePlan.id && !tasks[facePreviewId || '']?.asset && <div className={styles.previousOutput}>
            <strong>当前显示第{shownFacePlanNumber}组 · {shownFacePlan.count}宫格旧图</strong>
            <span>第{facePlanNumber}组 · {facePlan.count}宫格尚无可显示的新图片。旧图生成于 <RelativeTime value={shownFacePlan.createdAt} />。</span>
          </div>}
          {inspectionPlan && <div className={styles.previousOutput}><span>正在查看历史生成记录。当前工作区的原图、输入和已选用图片保留。</span>{inspectionPlan.sourceAssetId !== draft.sourceAssetId && <button type="button" disabled={locked || unresolved} onClick={() => { updateDraft({ sourceAssetId: inspectionPlan.sourceAssetId, mainFace: null, auxiliaryFaces: [], views: {}, facePlanId: null, resultPlanId: null, stage: 'faces' }); setFacePreviewId(inspectionPlan.kind === 'faces' && !inspectionPlan.operation ? inspectionPlan.id : null); }}>使用本组原图</button>}<button type="button" onClick={() => setInspectionId(null)}>返回当前制作</button></div>}
          {!inspectionPlan && bodyOpen && <p className={styles.bodyIntro}>以左侧原始角色图为参考，同一次生成左正面、右背面的全身对照图，保持比例、服装和配饰一致。选用整组后进入成品预览。</p>}
          {inspectionPlan ? <div className={styles.resultArea}>{tasks[inspectionPlan.id]?.asset ? <button type="button" className={styles.resultImage} onClick={() => setPreview({ src: characterLabMediaUrl(inspectionPlan.id), alt: '历史生成图' })}><ReturnedImage src={characterLabMediaUrl(inspectionPlan.id)} alt="历史生成图" /></button> : <p>这条历史记录尚无可显示的图片。</p>}</div> : bodyOpen ? renderBodyPair() : draft.stage === 'result' ? !legacyResultOpen ? renderViewBoard() : shownResultPlan && resultTask?.asset ? <div className={styles.resultArea}><button type="button" className={styles.resultImage} onClick={() => setPreview({ src: characterLabMediaUrl(shownResultPlan.id), alt: '角色四格参考图' })}><ReturnedImage src={characterLabMediaUrl(shownResultPlan.id)} alt="角色四格参考图：正面特写、侧面特写、正面全身、背面全身" /></button></div> : <div className={styles.canvasEmpty}><Grid2X2 size={42} /><h3>{currentTask && ['queued', 'running'].includes(currentTask.status) ? '正在制作角色参考图' : '在这里预览角色参考图'}</h3><p>选定面部后，结合原图生成正面特写、侧面特写和正背全身。</p>{draft.mainFace && <button type="button" className={styles.primary} disabled={locked || unresolved} onClick={showIndependentViews}>制作角色参考图<ArrowRight size={16} /></button>}</div> : shownFacePlan ? <div className={styles.candidateGrid} style={{ gridTemplateColumns: `repeat(${shownFacePlan.count === 9 ? 3 : 2}, minmax(0, 1fr))` }}>{Array.from({ length: shownFacePlan.count }, (_, cell) => {
            const face = { planId: shownFacePlan.id, cell }, main = sameFace(draft.mainFace, face), auxiliary = draft.auxiliaryFaces.some(item => sameFace(item, face));
            return <article key={cell} className={styles.candidate} data-main={main} data-auxiliary={auxiliary}><button type="button" className={styles.candidateImage} disabled={locked} aria-pressed={main} aria-label={`选择候选${cell + 1}作为主面部`} onClick={() => selectFace(face)}><ReturnedImage src={characterLabMediaUrl(shownFacePlan.id, cell)} alt={`真人面部候选${cell + 1}`} /><span className={styles.cellNumber}>{String(cell + 1).padStart(2, '0')}</span>{main && <span className={styles.mainBadge}><Check size={12} />主面部</span>}{auxiliary && <span className={styles.auxBadge}>辅助参考</span>}</button><div className={styles.cellActions}><button type="button" disabled={locked} onClick={() => setPreview({ src: characterLabMediaUrl(shownFacePlan.id, cell), alt: `候选${cell + 1}` })}><Maximize2 size={13} />放大</button><button type="button" disabled={locked || main} aria-pressed={auxiliary} onClick={() => toggleAuxiliary(face)}>{auxiliary ? '移除辅助' : '作为辅助'}</button></div></article>;
          })}</div> : <div className={styles.canvasEmpty}><UserRound size={46} /><h3>{currentTask && ['queued', 'running'].includes(currentTask.status) ? '正在探索不同的面部方案' : '探索适合角色的真人面孔'}</h3><p>添加一张角色原图，调整面部差异，生成4宫格或9宫格候选。</p>{!draft.sourceAssetId && <button type="button" className={styles.outline} disabled={locked} onClick={() => setPickerOpen(true)}><ImagePlus size={16} />添加原始素材</button>}</div>}
        </section>
        <aside className={styles.controls}>
          {recipeTarget && !refinementVisible && renderRecipePanel()}
          {!recipeTarget && <>
          {bodyOpen ? <>
            <section><div className={styles.settingsHeading}><h2>正反面生成设置</h2>{renderPromptButton('body-pair')}</div>
              {renderGenerationSettings()}
              <label className={styles.field}><span>角色补充要求</span><textarea rows={5} maxLength={3000} value={draft.bodyDescription || ''} disabled={locked} onChange={event => updateDraft({ bodyDescription: event.target.value })} placeholder="例如：保持原图头身比、腰带和靴子细节，双手自然下垂" /></label>
              <button type="button" className={`${styles.primary} ${styles.generateAfterInput}`} disabled={locked || !draft?.sourceAssetId || pendingBlocks('result', 'body-pair')} onClick={() => void generate('result', 'body-pair')}>{bodyShown ? '重新生成正背面' : '一起生成正背面'}</button>
              <p className={styles.hint}>这些要求用于下一次正背面共同生成。</p>
            </section>
            <section><h2>{bodyPairReady ? '已选用正背面组合' : '选择一组正背面'}</h2>
              <p className={styles.hint}>{!bodyPairReady && (viewReady('body-front') || viewReady('body-back')) ? '旧单面选择保留在成品里。选用新组合会一起替换两面。' : '选用整组后，正背面一起带入成品预览。'}</p>
              <button type="button" className={styles.primary} disabled={locked || !bodyPairReady} onClick={showIndependentViews}>确认并进入成品预览<ArrowRight size={16} /></button>
            </section>
            <button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}><ArrowLeft size={15} />返回选脸</button>
          </> : draft.stage === 'result' && !legacyResultOpen ? <>
            <section><h2>合成与交付</h2>
              <p className={styles.hint}>四格选齐即可保存或复制。全身以原始角色图为准。</p>
              <label className={styles.field}><span>作品名称</span><input value={workName} placeholder={workspace.name} maxLength={80} disabled={locked} onChange={event => updateDraft({ resultName: event.target.value })} /></label>
              <div className={styles.actionPair}>
                <button type="button" className={styles.primary} disabled={locked || !sheetReady} onClick={() => void saveComposition()}><Save size={16} />合并保存</button>
                <button type="button" className={styles.outline} disabled={locked || !sheetReady} onClick={copyComposition}><Copy size={16} />复制合成图</button>
              </div>
            </section>
            {renderGenerationSettings()}
            <button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}><ArrowLeft size={15} />返回选脸</button>
          </> : draft.stage === 'result' ? <><section className={styles.resultState}><strong>旧版成品 {shownResultPlan ? `v${resultPlans.length - resultPlans.findIndex(item => item.id === shownResultPlan.id)}` : ''}</strong><span>{selectedResult ? '已保存' : resultTask?.asset ? '已生成' : '待生成'}</span></section><section><h2>保存与导出</h2><label className={styles.field}><span>作品名称</span><input value={workName} placeholder={selectedResult?.name || workspace.name} maxLength={80} onChange={event => updateDraft({ resultName: event.target.value })} /></label><div className={styles.field}><span>导出内容</span><div className={styles.segmented}>{([['sheet', '整图'], ['cells', '单张'], ['all', '全部']] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={exportMode === mode} onClick={() => setExportMode(mode)}>{label}</button>)}</div></div><div className={styles.exportDetails}><span>文件格式 <b>PNG{exportMode !== 'sheet' ? ' / ZIP' : ''}</b></span><span>图片尺寸 <b>原始尺寸</b></span></div><div className={styles.actionPair}><button type="button" className={styles.primary} disabled={locked || !shownResultPlan || !resultTask?.asset} onClick={() => void saveResult()}><Save size={16} />保存成品</button><button type="button" className={styles.outline} disabled={locked || !shownResultPlan || !resultTask?.asset} onClick={() => void exportResult()}><Download size={16} />导出图片</button></div><p className={styles.hint}>直接保存当前结果，无需重新生成。</p></section><details className={styles.adjustments}><summary><SlidersHorizontal size={16} />调整成品<ChevronDown size={15} /></summary><label className={styles.field}><span>调整位置</span><select value={draft.adjustmentCell ?? 'all'} onChange={event => updateDraft({ adjustmentCell: event.target.value === 'all' ? null : Number(event.target.value) })}><option value="all">全部四格</option>{['正面特写', '侧面特写', '正面全身', '背面全身'].map((label, index) => <option key={index} value={index}>{label}</option>)}</select></label>{renderPromptButton('result')}{renderGenerationSettings()}<label className={styles.field}><span>调整要求</span><textarea rows={4} value={draft.adjustment} maxLength={3000} onChange={event => updateDraft({ adjustment: event.target.value })} placeholder="例如：侧面保持平视，露出完整发型" /></label><button type="button" className={`${styles.outline} ${styles.generateAfterInput}`} disabled={locked || legacyPending || !draft.mainFace || faceSourceMismatch} onClick={() => void generate('result')}><RefreshCw size={15} />生成新版本</button></details><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}><ArrowLeft size={15} />返回选择</button><button type="button" className={styles.outline} disabled={locked} onClick={showIndependentViews}>制作独立四格<ArrowRight size={15} /></button></> : <>
            {draft.stage === 'selection' && <section className={styles.selectedSection}><h2>已选 {selectedFaces.length} 个方案</h2>{faceSourceMismatch && <div className={styles.sourceMismatch}><p>这组候选来自另一张原图。</p><button type="button" disabled={locked} onClick={() => updateDraft({ sourceAssetId: shownFacePlan!.sourceAssetId, views: {} })}>使用本组原图</button></div>}{selectedFaces.length > 0 ? <div className={styles.selectedFaces}>{selectedFaces.map((face, index) => <div key={`${face.planId}:${face.cell}`} data-main={index === 0 && Boolean(draft.mainFace)}><button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(face.planId, face.cell), alt: index === 0 && draft.mainFace ? '主面部' : '辅助参考' })}><ReturnedImage src={characterLabMediaUrl(face.planId, face.cell)} alt={index === 0 && draft.mainFace ? '主面部' : '辅助参考'} /></button><span>{index === 0 && draft.mainFace ? '主面部' : '辅助参考'} {String(face.cell + 1).padStart(2, '0')}</span>{index > 0 && <button type="button" className={styles.removeAux} aria-label={`移除辅助参考${face.cell + 1}`} onClick={() => toggleAuxiliary(face)}><X size={13} /></button>}</div>)}</div> : <p className={styles.hint}>点击候选确定主面部，可另外添加辅助参考。</p>}<label className={styles.field}><span>辅助特征</span><textarea rows={3} maxLength={1000} value={draft.auxiliaryFeatures} onChange={event => updateDraft({ auxiliaryFeatures: event.target.value })} placeholder="例如：参考辅助方案的鼻梁与眼部气质" /></label><p className={styles.hint}>主面部确定身份，辅助参考提供特征方向。</p></section>}
            <section><div className={styles.settingsHeading}><h2>{draft.stage === 'faces' ? '生成设置' : '探索更多面孔'}</h2>{renderPromptButton('faces')}</div><div className={styles.segmented}>{([4, 9] as const).map(count => <button type="button" key={count} disabled={locked} aria-pressed={draft.count === count} onClick={() => updateDraft({ count })}><Grid2X2 size={16} />{count}宫格</button>)}</div><label className={styles.sliderLabel}><span>面部变化<b>{characterLabStrength(draft.diversity)}</b></span><input type="range" min="0" max="100" step="1" value={draft.diversity} aria-valuetext={characterLabStrength(draft.diversity)} disabled={locked} onChange={event => updateDraft({ diversity: Number(event.target.value) })} /><small><span>小幅</span><span>中等</span><span>明显</span></small></label><p className={styles.hint}>小幅围绕同一张脸做局部变化。设置用于下一批候选。</p>{renderGenerationSettings()}<label className={styles.field}><span>角色补充要求</span><textarea rows={4} maxLength={3000} value={draft.faceDescription || ''} disabled={locked} onChange={event => updateDraft({ faceDescription: event.target.value })} placeholder="例如：黑发、细框眼镜，沉静气质" /></label><button type="button" className={`${shownFacePlan ? styles.outline : styles.primary} ${styles.generateAfterInput}`} disabled={locked || facePending || !draft.sourceAssetId} onClick={() => void generate('faces')}><RefreshCw size={15} />{shownFacePlan ? '重新生成' : '生成人脸候选'}</button></section>
            {frontReady && draft.mainFace && <section className={styles.refineEntry}>
              <ReturnedImage src={characterLabMediaUrl(draft.mainFace.planId, draft.mainFace.cell)} alt="选定正脸" />
              <div><h2>选定正脸</h2><button type="button" className={styles.outline} disabled={locked} onClick={() => openRefinement('refine-face', draft.mainFace!)}>微调这张脸</button></div>
            </section>}
            <div className={styles.mainActions}>{draft.stage === 'faces' ? <button type="button" className={shownFacePlan ? styles.primary : ''} disabled={locked || !shownFacePlan} onClick={() => updateDraft({ stage: 'selection' })}>选择方案<ArrowRight size={16} /></button> : <><button type="button" className={styles.primary} disabled={locked || !frontReady} onClick={showBodyGeneration}>全身正反面<ArrowRight size={16} /></button><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'faces' })}><ArrowLeft size={15} />返回生成</button></>}</div>
          </>}
          </>}
        </aside>
      </div>
      </>}
      {Boolean(workspace.compositions?.length) && <details className={styles.versionShelf} aria-label="已保存的合成图">
        <summary>成品版本 · {workspace.compositions?.length} 个</summary>
        <div className={styles.savedSheets}>{workspace.compositions?.map(item => {
          const url = compositionUrl(workspace.id, item.id);
          return <div key={item.id}><button type="button" onClick={() => setPreview({ src: url, alt: item.name })}>{item.name}</button>
            <a href={url + '&download=1'} download={item.name + '.png'}>下载</a>
            {item.sources && <button type="button" disabled={locked || unresolved} onClick={() => { const refs = item.sources!; updateDraft({ sourceAssetId: refs.sourceAssetId, mainFace: refs.mainFace, views: { side: refs.side, 'body-front': refs.front, 'body-back': refs.back } }); setLegacyView(false); setNotice('已将此版本作为当前工作底稿，原成品版本保留。'); }}>继续编辑</button>}
            {item.sources ? <details><summary>生成来源</summary><div className={styles.recipeActions}>{([['mainFace', '正脸'], ['side', '侧脸'], ['front', '正面全身'], ['back', '背面全身']] as const).map(([slot, label]) => <button type="button" key={slot} onClick={() => {
              setCompositionSlot({ id: item.id, slot }); setRecipeTab('current'); setRecipeTarget(slot === 'mainFace' ? 'front' : slot === 'side' ? 'side' : slot === 'front' ? 'body-front' : 'body-back');
            }}>{label}提示词</button>)}</div></details> : <span className={styles.hint}>旧成品未记录分格来源</span>}</div>;
        })}</div>
      </details>}
    </>}
    {!legacyView && recipeTarget && !refinementVisible && renderRecipePanel()}
    <ResourceLibraryPicker open={pickerOpen} renderImagePreview={props => <CharacterLabPreview {...props} />} imageOnly target="image-studio" purpose="character-lab-source" contextKey={`${ownerId}:character-lab:${workspace?.id || 'draft'}`} title="选择角色原始素材" confirmLabel="使用这张原图" maxSelection={1} currentCount={0} currentAssetIds={[]} onClose={() => setPickerOpen(false)} onUploadFile={async (file: File, onProgress?: UploadProgressHandler) => { assertActive(); const capturedScope = scope.current; setUploading(true); try { const asset = await uploadFileAsAsset(file, { onProgress, ownerId }); if (capturedScope !== scope.current || !active.current) throw new Error('当前角色或账号已变化，图片没有替换到当前工作区'); return asset; } finally { if (alive.current) setUploading(false); } }} onConfirm={async (ids, assets) => { assertActive(); if (!draftRef.current || !ids[0] || busyRef.current) return false; const asset = assets?.find(item => item.id === ids[0]); setSource({ id: ids[0], url: asset?.originalUrl || `/api/image-studio/assets/${encodeURIComponent(ids[0])}`, thumbnailUrl: asset?.thumbnailUrl || '', fileName: asset?.fileName || '角色原始素材' }); updateDraft({ sourceAssetId: ids[0], facePlanId: null, resultPlanId: null, mainFace: null, auxiliaryFaces: [], views: {}, stage: bodyOpen ? 'result' : 'faces' }); sourceArrival.mark([ids[0]]); return true; }} />
    {preview && sessionReady && <CharacterLabPreview src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />}
    {refinementVisible && refinement && renderRefinement(refinement)}
    {promptOpen && activePromptTarget && bootstrap && configDraft && (
      <dialog ref={promptDialog} className={styles.promptDialog} aria-labelledby="character-lab-prompt-title">
        <header className={styles.promptHeader}>
          <h2 id="character-lab-prompt-title">{promptTitles[activePromptTarget]}</h2>
          <button type="button" className={styles.iconButton} aria-label="关闭提示词" disabled={Boolean(busy)} onClick={closePrompts}><X size={18} /></button>
        </header>
        <div className={styles.promptBody}>
          <label className={styles.promptRevision}>
            <span>提示词版本</span>
            <select value="" disabled={Boolean(busy)} onChange={event => {
              if (!event.target.value) return;
              const revision = Number(event.target.value);
              const version = revision === bootstrap.config.revision
                ? bootstrap.config : bootstrap.configVersions.find(item => item.revision === revision);
              if (version) {
                setConfigError('');
                applyPromptVersion(version);
              }
            }}>
              <option value="">选择要载入的版本</option>
              <option value={bootstrap.config.revision}>v{bootstrap.config.revision} · 当前</option>
              {bootstrap.configVersions.filter(version => version.revision !== bootstrap.config.revision).map(version => (
                <option key={version.revision} value={version.revision}>v{version.revision}{version.updatedAt ? ' · ' + new Date(version.updatedAt).toLocaleDateString() : ''}</option>
              ))}
            </select>
          </label>
          {draft && legacyView && activePromptTarget !== 'result' && <details className={styles.promptPreview}>
            <summary>查看本次规则预览</summary>
            <pre>{activePromptTarget === 'faces'
              ? faceLabPrompt(bootstrap.config, draft)
              : labViewPrompt(bootstrap.config, activePromptTarget, refinement?.operation === activePromptTarget ? refinement.text
                : activePromptTarget === 'side' ? draft.sideDescription || '' : activePromptTarget.startsWith('body-') ? draft.bodyDescription || '' : '', { count: draft.count })}</pre>
          </details>}
          {activePromptFields.map(([field, title, placeholder]) => (
            <label className={styles.field} key={field}>
              <span>{title}</span>
              <textarea rows={field === 'resultPrompt' ? 6 : 4} maxLength={3000} value={configDraft[field]} placeholder={placeholder} disabled={Boolean(busy)} onChange={event => {
                const value = event.target.value;
                setConfigDraft(previous => previous ? { ...previous, [field]: value } : previous);
              }} />
              {field.endsWith('StyleConstraints') || field === 'styleConstraints' ? <small>仅影响对应部位的新生成与微调。</small> : null}
            </label>
          ))}
        </div>
        <footer className={styles.promptFooter}>
          {configError && <p role="alert">{configError}</p>}
          <small>保存后用于新生成。</small>
          <button type="button" disabled={Boolean(busy)} onClick={closePrompts}>关闭</button>
          <button type="button" className={styles.primary} disabled={Boolean(busy) || !scopedConfigDirty} onClick={() => void saveConfig()}>
            <Save size={16} />{busy === 'config' ? '正在保存…' : '保存新版本'}
          </button>
        </footer>
      </dialog>
    )}
    {productDialog}
  </main></CharacterLabMediaProvider>;

  function renderPromptButton(target: PromptTarget) {
    return <button type="button" data-character-prompt={target} className={styles.promptTrigger} aria-expanded={recipeTarget === target} aria-label={promptTitles[target]} disabled={locked} onClick={event => { recipeTrigger.current = event.currentTarget; setCompositionSlot(null); setRecipeTab('current'); setRecipeTarget(previous => previous === target ? null : target); }}>
      <Settings2 size={15} />{target === 'faces' ? '人脸提示词' : target === 'result' ? '整图提示词' : '提示词'}
    </button>;
  }

  function renderRecipePanel() {
    if (!recipeTarget || !draft || !workspace) return null;
    const target: PromptTarget = recipeTarget === 'front' ? 'refine-face' : recipeTarget;
    const operation = target === 'faces' || target === 'result' ? undefined : target === 'body-front' || target === 'body-back' ? 'body-pair' : target;
    const localRefinement = recipeTarget === 'front' ? frontRefinement : refinement?.operation === operation ? refinement
      : operation === 'refine-face' ? frontRefinement : null;
    const savedComposition = compositionSlot ? workspace.compositions?.find(item => item.id === compositionSlot.id) : undefined;
    const savedSource = savedComposition?.sources && compositionSlot ? savedComposition.sources[compositionSlot.slot] : undefined;
    const reference: CharacterLabReference | undefined = savedSource || (inspectionPlan ? { planId: inspectionPlan.id } : recipeTarget === 'front' ? frontShown || undefined
      : target === 'faces' ? shownFacePlan ? { planId: shownFacePlan.id } : undefined
        : target === 'result' ? shownResultPlan ? { planId: shownResultPlan.id } : undefined
          : target === 'body-pair' ? bodyShown ? { planId: bodyShown.id } : undefined
            : target === 'refine-face' || target === 'refine-side' ? refinePlan && tasks[refinePlan.id]?.asset ? { planId: refinePlan.id } : localRefinement?.target
              : shownView(target));
    const kind = target === 'faces' || target === 'refine-face' || target === 'refine-side' ? 'faces' : 'result';
    const description = localRefinement && operation?.startsWith('refine-') ? localRefinement.text
      : operation === 'side' ? draft.sideDescription || '' : operation?.startsWith('body-') ? draft.bodyDescription || '' : target === 'faces' ? draft.faceDescription || '' : draft.adjustment;
    const siblings = (recipeTarget === 'front' ? [] : target === 'faces' ? facePlans : target === 'result' ? resultPlans : target === 'body-pair' ? bodyPlans
      : target === 'side' || target === 'body-front' || target === 'body-back' ? viewOptions(target) : plans.filter(plan => plan.operation === target && sameLabReference(plan.input, localRefinement?.target)))
      .filter(plan => tasks[plan.id]?.asset);
    const siblingIndex = siblings.findIndex(plan => plan.id === reference?.planId);
    return <CharacterLabPromptPanel ownerId={ownerId} workspaceId={workspace.id} title={savedComposition ? `成品来源 · ${recipeTarget === 'front' ? '正脸' : viewTitles[recipeTarget as CharacterLabView] || '生成记录'}` : recipeTarget === 'front' ? '正脸' : promptTitles[target].replace('提示词', '')}
      reference={reference} tab={recipeTab} onTab={setRecipeTab} onClose={() => {
        setRecipeTarget(null);
        requestAnimationFrame(() => { const button = recipeTrigger.current?.isConnected ? recipeTrigger.current : document.querySelector<HTMLElement>('[data-character-prompt]'); button?.focus({ preventScroll: true }); });
      }} isAdmin={isAdmin} disabled={locked}
      previewPayload={{ action: 'preview-prompt', contextProtocol: 1, layoutProtocol: 1, workspaceId: workspace.id, workspaceRevision: workspace.revision, kind, operation, draft, description }}
      previous={siblingIndex >= 0 ? siblings[siblingIndex + 1]?.id : undefined} next={siblingIndex > 0 ? siblings[siblingIndex - 1]?.id : undefined}
      onBrowse={id => {
        setCompositionSlot(null); setInspectionId(null);
        if (target === 'faces') { const plan = facePlans.find(item => item.id === id); if (plan) browseFace(plan); }
        else if (target === 'result' || target === 'body-pair') {
          const plan = plans.find(item => item.id === id); if (plan) restoreHistoryPersonal(plan);
          if (target === 'result') setResultPreviewId(id); else setBodyPreviewId(id);
        }
        else if (target === 'refine-face' || target === 'refine-side') { const plan = plans.find(item => item.id === id); setRefinement(current => current ? { ...current, planId: id, text: plan?.adjustment ?? current.text } : current); }
        else { const plan = plans.find(item => item.id === id); if (plan) restoreHistoryPersonal(plan); setViewPreviews(current => ({ ...current, [target]: id })); }
      }}
      escapeEnabled={!preview && !promptOpen}
      onPreviewAsset={id => setPreview({ src: `/api/image-studio/template-assets/${encodeURIComponent(id)}`, alt: '本次参考原图' })}
      onInspectSource={id => { const item = plans.find(plan => plan.id === id); if (item) { setCompositionSlot(null); setInspectionId(id); setRecipeTarget(item.operation || item.kind); setRecipeTab('current'); } }}
      onRestore={restoreSettings} onRestorePersonal={restorePersonal} onReproduce={repeatSettings} onPreview={item => setPreview({ src: characterLabMediaUrl(item.planId, item.cell), alt: '生成记录图片' })}>
      {target === 'faces' && <><label className={styles.field}><span>宫格数量</span><select value={draft.count} disabled={locked} onChange={event => updateDraft({ count: Number(event.target.value) as 4 | 9 })}><option value={4}>四宫格</option><option value={9}>九宫格</option></select></label>
        <label className={styles.sliderLabel}><span>面部变化<b>{characterLabStrength(draft.diversity)}</b></span><input type="range" min={0} max={100} value={draft.diversity} disabled={locked} onChange={event => updateDraft({ diversity: Number(event.target.value) })} /></label></>}
      {renderGenerationSettings()}
      {target === 'result' && <label className={styles.field}><span>角色补充要求</span>
        <textarea rows={3} maxLength={3000} disabled={locked} value={draft.context} onChange={event => updateDraft({ context: event.target.value })} />
      </label>}
      <label className={styles.field}><span>{operation?.startsWith('refine-') ? '本次微调要求' : operation === 'side' ? '侧脸补充要求' : target === 'result' ? '本次调整要求' : '角色补充要求'}</span>
        <textarea rows={4} maxLength={3000} disabled={locked} value={description} onChange={event => {
          if (operation?.startsWith('refine-') && localRefinement) setRefinement({ ...localRefinement, text: event.target.value });
          else updateDraft(operation === 'side' ? { sideDescription: event.target.value } : target === 'result' ? { adjustment: event.target.value } : operation?.startsWith('body-') ? { bodyDescription: event.target.value } : { faceDescription: event.target.value });
        }} />
      </label>
      <button type="button" className={`${styles.primary} ${styles.generateAfterInput}`} disabled={locked || !draft.sourceAssetId || pendingBlocks(kind, operation) || operation === 'side' && !frontReady
          || operation?.startsWith('refine-') && (!localRefinement?.text.trim() || !localRefinement.target)} onClick={() => {
          if (operation?.startsWith('refine-') && localRefinement) { setRefineOpen(true); void generate('faces', operation, localRefinement); }
          else void generate(kind, operation);
        }}>生成新版本</button>
      <div className={styles.recipeActions}>
        <button type="button" disabled={locked} onClick={() => { setFacePreviewId(null); setFrontPreview(null); setBodyPreviewId(null); setResultPreviewId(null); setViewPreviews({}); setCompositionSlot(null); setInspectionId(null); setRecipeTarget(null); setRecipeTab('current'); }}>重置查看位置</button>
        {isAdmin && <button type="button" disabled={locked} onClick={() => void run('config-read', async () => {
          const previous = bootstrap ? fieldsOf(bootstrap.config) : null, capturedScope = scope.current;
          const fresh = await labApi<CharacterLabBootstrap>();
          assertActive(); if (capturedScope !== scope.current) return;
          const next = fieldsOf(fresh.config);
          setConfigDraft(current => current && previous ? Object.fromEntries(Object.entries(next).map(([key, value]) => [key, current[key as keyof CharacterLabPromptFields] === previous[key as keyof CharacterLabPromptFields] ? value : current[key as keyof CharacterLabPromptFields]])) as CharacterLabPromptFields : next);
          setBootstrap(current => current ? { ...current, config: fresh.config, configVersions: fresh.configVersions, settings: fresh.settings } : fresh);
          setRecipeTarget(null); setConfigError(''); setPromptTarget(target);
        })}>管理阶段规则</button>}

      </div>
    </CharacterLabPromptPanel>;
  }

  function renderBodyPair() {
    const selected = bodyPairReady ? viewSelection('body-front')?.planId : undefined;
    return <section className={styles.bodyPair}>
      <div className={styles.viewActions}>
        {bodyShown && <button type="button" className={styles.outline} disabled={locked || selected === bodyShown.id} onClick={() => chooseBodyPair(bodyShown.id)}>{selected === bodyShown.id ? '已选用这组' : '选用这组'}</button>}
        {bodyShown && <button type="button" className={styles.iconButton} aria-label="放大正背面整图" title="放大正背面整图" onClick={() => setPreview({ src: characterLabMediaUrl(bodyShown.id), alt: '正背面全身对照图' })}><Maximize2 size={16} /></button>}
      </div>
      <div className={styles.viewBoard} data-body-only="true">
        {(['正面全身', '背面全身'] as const).map((title, cell) => <article key={title} className={styles.viewSlot} data-body="true">
          <h2>{title}</h2>
          {bodyShown ? <button type="button" className={styles.viewImage} onClick={() => setPreview({ src: characterLabMediaUrl(bodyShown.id, cell), alt: title })}>
            <ReturnedImage src={characterLabMediaUrl(bodyShown.id, cell)} alt={title} />
          </button> : <div className={styles.viewEmpty}>同一次生成中呈现{title}</div>}
        </article>)}
      </div>
    </section>;
  }

  function renderViewBoard() {
    const front = frontShown, frontAdopted = Boolean(front && sameLabReference(front, draft?.mainFace));
    return <div className={styles.viewBoard}>
      <article className={styles.viewSlot}>
        <div className={styles.settingsHeading}><h2>正脸</h2><div className={styles.viewHeadingActions}>
          <button type="button" className={styles.promptTrigger} disabled={locked || !front} onClick={() => { setCompositionSlot(null); setRecipeTab('current'); setRecipeTarget('front'); }}>提示词</button>
          {frontPlans.length > 0 && <FrontVersionPicker key={`${ownerId}:${workspace?.id}:${draft?.sourceAssetId}`}
            current={front} adopted={draft?.mainFace} disabled={locked} groups={frontPlans.map(plan => {
              const batch = plan.operation === 'refine-face' ? plans.filter(item => item.operation === 'refine-face') : facePlans;
              return { plan, label: `${plan.operation === 'refine-face' ? '正脸微调' : '候选'}第 ${batch.length - batch.findIndex(item => item.id === plan.id)} 批` };
            })} onBrowse={face => {
              setFrontPreview(face); setHistoryGroup('faces'); setCompositionSlot(null); setInspectionId(null);
              if (recipeTarget) { setRecipeTab('current'); setRecipeTarget('front'); }
            }} />}
        </div></div>
        <div className={styles.viewActions}>
          {front && !frontAdopted && <button type="button" className={styles.primary} disabled={locked} onClick={() => selectFace(front)}>选用这张</button>}
          {front && <button type="button" disabled={locked} onClick={() => openRefinement('refine-face', front)}>微调正脸{frontAdopted && <Check size={13} aria-label="已选用" />}</button>}
          {front && <a href={characterLabMediaUrl(front.planId, front.cell) + '&download=1'} download="正脸.png" aria-label="下载正脸" title="下载正脸"><Download size={16} /></a>}
        </div>
        {front ? <>
          <button type="button" className={styles.viewImage} onClick={() => setPreview({ src: characterLabMediaUrl(front.planId, front.cell), alt: frontAdopted ? '选定正脸' : '预览正脸' })}>
            <ReturnedImage src={characterLabMediaUrl(front.planId, front.cell)} alt={frontAdopted ? '选定正脸' : '预览正脸'} />
          </button>
        </> : <div className={styles.viewEmpty}>先选定一张正脸</div>}
      </article>
      {viewSlots.map(slot => {
        const title = viewTitles[slot], selected = viewSelection(slot);
        const options = viewOptions(slot);
        const latest = options.find(plan => tasks[plan.id] || pendingPlanIds.includes(plan.id));
        const latestTask = latest ? tasks[latest.id] : null;
        const shown = shownView(slot);
        const adopted = Boolean(shown && viewReady(slot, shown) && sameLabReference(selected, shown));
        const src = shown ? characterLabMediaUrl(shown.planId, shown.cell) : '';
        const statusDetail = [latest ? latestTask ? taskState[latestTask.status] || '状态待确认' : '原提交待确认' : '',
          latestTask?.error || '', adopted ? '已选用' : selected && slot === 'side' ? '旧侧脸保留在历史，请选用当前正脸对应的版本' : '']
          .filter(Boolean).join(' · ');
        const statusReason = Boolean(latestTask?.error || latestTask?.status === 'failed');
        return <article className={styles.viewSlot} key={slot} data-body={slot !== 'side'}>
          <div className={styles.settingsHeading}><h2>{title}</h2><div className={styles.viewHeadingActions}>{renderPromptButton(slot)}
            {statusDetail && <ImageResultStatusDetails active={resultDetailsActive} reason={statusReason}
              scopeKey={`${ownerId}:${workspace?.id || 'workspace'}:${slot}:${shown?.planId || latest?.id || 'empty'}:${shown?.cell ?? ''}:status`} label={statusReason ? `查看${title}失败原因` : `查看${title}结果详情`} heading={statusReason ? `${title}失败原因` : `${title}结果详情`}>
              <p className={styles.viewStatusDetail}>{statusDetail}</p>
            </ImageResultStatusDetails>}

          </div></div>
          <div className={styles.viewActions}>
            {slot === 'side' ? <button type="button" className={styles.outline} disabled={locked} onClick={event => {
              recipeTrigger.current = event.currentTarget; setHistoryGroup('side'); setCompositionSlot(null); setInspectionId(null); setRecipeTarget('side'); setRecipeTab('next');
            }}>编辑侧脸补充</button> : slot === 'body-front' && <button type="button" className={styles.outline} disabled={locked} onClick={showBodyGeneration} title="编辑正背面补充与生成设置">正背面设置</button>}
            {shown && !adopted && <button type="button" className={styles.primary} disabled={locked} onClick={() => chooseView(slot, shown)}>{referencePlan(shown)?.operation === 'body-pair' ? '选用组合' : '选用这张'}</button>}
            {shown && slot === 'side' && <button type="button" disabled={locked} onClick={() => openRefinement('refine-side', shown)}>微调侧脸</button>}
            {shown && <a href={src + '&download=1'} download={title + '.png'} aria-label={'下载' + title} title={'下载' + title}><Download size={16} /></a>}
          </div>
          {shown ? <button type="button" className={styles.viewImage}
            onClick={() => slot === 'side' && !locked ? openRefinement('refine-side', shown) : setPreview({ src, alt: title })}>
            <ReturnedImage src={src} alt={title} />
          </button> : <div className={styles.viewEmpty}>{slot === 'side' && !frontReady ? '先选定正脸' : '待生成'}</div>}
        </article>;
      })}
    </div>;
  }

  function renderRefinement(current: Refinement) {
    const side = current.operation === 'refine-side';
    const resultReady = Boolean(refinePlan && refineTask?.asset && refinePlan.sourceAssetId === draft?.sourceAssetId
      && (!side || sameLabReference(refinePlan.mainFace, draft?.mainFace)));
    const inputCurrent = referencePlan(current.target)?.sourceAssetId === draft?.sourceAssetId
      && (!side || viewReady('side', current.target));
    return <dialog ref={refineDialog} className={styles.promptDialog} aria-labelledby="character-lab-refine-title">
      <header className={styles.promptHeader}><h2 id="character-lab-refine-title">{refineTitle}</h2>
        <button type="button" className={styles.iconButton} aria-label="关闭微调" onClick={() => setRefineOpen(false)}><X size={18} /></button>
      </header>
      <div className={styles.promptBody}>
        <div className={styles.refineSource}>
          <ReturnedImage src={characterLabMediaUrl(current.target.planId, current.target.cell)} alt={side ? '微调前的侧脸' : '微调前的正脸'} />
          <p>{side ? '以选定正脸锁定身份，只调整这张侧脸的局部细节。' : '保留这张脸的身份，只微调指定的细节。'}</p>
        </div>
        <label className={styles.field}><span>修改要求</span>
          <textarea rows={3} value={current.text} maxLength={3000} disabled={locked}
            placeholder={side ? '例如：稍微收一点下颌，保持鼻尖和侧脸方向' : '例如：鼻梁稍低一点，保留眼距和发型'}
            onChange={event => setRefinement({ ...current, text: event.target.value })} />
        </label>
        <button type="button" className={`${styles.primary} ${styles.generateAfterInput}`} disabled={locked || !current.text.trim() || !inputCurrent || pendingBlocks('faces', current.operation)}
          onClick={() => void generate('faces', current.operation, current)}>{busy ? busyCopy : `生成${draft?.count || 4}个方案`}</button>
        {error && <p role="alert">{error}</p>}
        {refinePlan && <p role="status" className={styles.hint}>{refineTask ? taskState[refineTask.status] || '状态待确认'
          : pendingPlanIds.includes(refinePlan.id) ? '原提交待确认' : '尚未提交'}{refineTask?.error && <> · {refineTask.error}</>}</p>}
        {refinePlan && resultReady && <div className={styles.refineChoices} style={{ gridTemplateColumns: `repeat(${refinePlan.count === 9 ? 3 : 2}, minmax(0, 1fr))` }}>
          {Array.from({ length: refinePlan.count }, (_, cell) => {
            const choice = { planId: refinePlan.id, cell };
            return <button type="button" key={cell} disabled={locked} onClick={() => {
              if (side) chooseView('side', choice); else selectFace(choice);
              setRefineOpen(false);
            }}><ReturnedImage src={characterLabMediaUrl(choice.planId, cell)} alt={`微调方案${cell + 1}`} />
              <span>{side ? '设为侧脸' : '设为正脸'} · {cell + 1}</span></button>;
          })}
        </div>}
      </div>
      <footer className={styles.promptFooter}>
        {renderPromptButton(current.operation)}
        <button type="button" onClick={() => setRefineOpen(false)}>关闭</button>

      </footer>
      {recipeTarget && renderRecipePanel()}
    </dialog>;
  }

  function renderHistoryCandidates() {
    if (!draft) return null;
    const group = bodyOpen ? 'body' : draft.stage !== 'result' ? 'faces' : historyGroup;
    const candidates = (historyOpen || group !== 'side' ? plans : viewOptions('side')).filter(plan => historyOpen || plan.sourceAssetId === draft.sourceAssetId && historyGroupOf(plan) === group);
    const viewed = inspectionId || (group === 'faces' ? draft.stage === 'result' ? frontShown?.planId : shownFacePlan?.id
      : group === 'body' ? bodyOpen ? bodyShown?.id : shownView('body-front')?.planId : group === 'side' ? shownView('side')?.planId : shownResultPlan?.id);
    const backViewed = !inspectionId && !bodyOpen && group === 'body' ? shownView('body-back')?.planId : undefined;
    const groups: Array<[HistoryGroup, string]> = [['faces', '正脸'], ['side', '侧脸'], ['body', '前后身']];
    if (resultPlans.length) groups.push(['legacy', '旧版整图']);
    return <section id="character-lab-history" className={styles.materialSection} aria-label="历史候选">
      <div className={styles.sectionTitle}><h2>{historyOpen ? '全部历史记录' : '历史候选'}</h2>
        {historyOpen && <button type="button" aria-label="收起全部历史记录" onClick={() => setHistoryOpen(false)}><X size={14} /></button>}
      </div>
      {!historyOpen && !bodyOpen && draft.stage === 'result' && <div className={styles.historyFilters} aria-label="历史候选部位">
        {groups.map(([id, label]) =>
          <button type="button" key={id} aria-pressed={group === id} disabled={locked} onClick={() => setHistoryGroup(id)}>{label}</button>)}
      </div>}
      {!candidates.length ? <p className={styles.hint}>暂无历史候选。</p> : <div className={styles.batchList}>{candidates.map(plan => {
        const title = promptTitles[plan.operation || plan.kind].replace('提示词', '');
        const label = `${title} · 第${historyBatchNumbers.get(plan.id)}组${plan.kind === 'faces' ? ` · ${plan.count}宫格` : ''}`;
        return <button type="button" key={plan.id} aria-pressed={viewed === plan.id || backViewed === plan.id} disabled={locked} onClick={() => browseHistoryPlan(plan)}>
          {tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={label} /> : <Grid2X2 size={22} />}
          <span>{label}<small>{taskState[tasks[plan.id]?.status || ''] || '未提交或待核对'} · <RelativeTime value={plan.createdAt} /></small></span>
        </button>;
      })}</div>}
    </section>;
  }

  function renderGenerationSettings() {
    if (!draft) return null;
    return <details className={styles.generationSettings} open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>模型与项目<ChevronDown size={14} /></summary><label className={styles.field}><span>模型</span><select disabled={locked} value={modelChoices.includes(draft.model) ? draft.model : ''} onChange={event => updateDraft({ model: event.target.value })}><option value="" disabled>{modelAvailabilityReason || "请选择已开放模型"}</option>{modelChoices.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model}</option>)}</select></label><label className={styles.field}><span>供应商</span><ImageGenerationChannelSelect channels={channels} model={draft.model} value={draft.channelId} disabled={locked} onChange={channelId => updateDraft({ channelId })} /></label><div className={styles.parameterPair}><label className={styles.field}><span>画质</span><select value={draft.quality} disabled={locked} onChange={event => updateDraft({ quality: event.target.value })}>{!qualityChoices.includes(draft.quality as never) && <option value={draft.quality}>{imageStudioQualityLabel(draft.model, draft.quality)}</option>}{qualityChoices.map(quality => <option key={quality} value={quality}>{imageStudioQualityLabel(draft.model, quality)}</option>)}</select></label><label className={styles.field}><span>分辨率</span><select value={draft.resolution} disabled={locked} onChange={event => updateDraft({ resolution: event.target.value })}>{!resolutionChoices.includes(draft.resolution as never) && <option value={draft.resolution}>{draft.resolution}</option>}{resolutionChoices.map(resolution => <option key={resolution} value={resolution}>{resolution}</option>)}</select></label></div><ImageUsageProjectSelect ownerId={ownerId} value={draft.projectId} disabled={locked} onChange={projectId => updateDraft({ projectId })} />{draft.context && <label className={styles.field}><span>拆分前共用补充（只读）</span><textarea rows={3} readOnly value={draft.context} /><small>保留原文供复制，不用于正脸、侧脸或前后身的新生成。</small></label>}</details>;
  }
}
