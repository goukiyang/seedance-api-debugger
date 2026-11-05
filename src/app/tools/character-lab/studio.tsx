'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy, Download, Grid2X2, History, ImagePlus, Loader2, Maximize2, Plus, RefreshCw, Save, Settings2, SlidersHorizontal, UserRound, X } from 'lucide-react';
import { useMaterialArrival } from '@/components/useMaterialArrival';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { ImageGenerationChannelSelect } from '@/components/ImageGenerationChannelSelect';
import { ImageUsageProjectSelect } from '@/components/ImageUsageProjectSelect';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { RelativeTime } from '@/components/RelativeTime';
import { ImageFeishuStatus } from '@/components/image-studio/ImageFeishuStatus';
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
import { faceLabPrompt, labDefaultViewPrompts, labViewPrompt, labViewPromptFields } from '@/lib/character-lab/prompts';
import { characterLabMediaUrl, characterLabSlot, characterLabStrength, sameLabReference, type CharacterLabOperation, type CharacterLabReference, type CharacterLabView, type CharacterLabBootstrap, type CharacterLabConfig, type CharacterLabDraft, type CharacterLabFace, type CharacterLabPlan, type CharacterLabPromptFields, type CharacterLabQuote, type CharacterLabStage, type CharacterLabTask, type CharacterLabWorkspace, type CharacterLabWorkspacePayload } from '@/lib/character-lab/types';
import styles from './studio.module.css';

const stages: Array<{ id: CharacterLabStage; label: string }> = [{ id: 'faces', label: '人脸生成' }, { id: 'selection', label: '方案选择' }, { id: 'result', label: '成品预览' }];
type PromptTarget = CharacterLabPlan['kind'] | CharacterLabOperation;
type Refinement = { operation: 'refine-face' | 'refine-side'; target: CharacterLabReference; text: string; planId?: string };
const viewTitles = { side: '侧脸', 'body-front': '正面全身', 'body-back': '背面全身' };
const promptTitles: Record<PromptTarget, string> = {
  faces: '人脸候选提示词', result: '旧版整图提示词',
  'refine-face': '正脸微调提示词', side: '侧脸提示词', 'refine-side': '侧脸微调提示词',
  'body-front': '正面全身提示词', 'body-back': '背面全身提示词',
};
function pendingLabPlans(payload: CharacterLabWorkspacePayload, pending: string[]) {
  return Array.from(new Set([...pending, ...payload.plans.filter(plan => payload.submissionByRequestId[plan.id] === 'submitting').map(plan => plan.id)]))
    .filter(id => !payload.taskByRequestId[id] && payload.submissionByRequestId[id] !== 'rejected');
}
const sharedStyleField = ['styleConstraints', '共用风格约束', '摄影质感、光线和统一画面要求'] as const;
const promptFields = {
  faces: [
    ['basePrompt', '明显变化 · 基础提示词', '明显变化档的候选生成规则'],
    ['characterContext', '角色上下文要求', '从原图理解角色时需要保留的身份与特征'],
    ['faceVariables', '明显变化 · 面部变量', '明显变化档的骨相和五官规则'],
    sharedStyleField,
  ],
  result: [
    ['resultPrompt', '成品生成规则', '面部一致性、服装与四格构图要求'],
    sharedStyleField,
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
  return { ...labDefaultViewPrompts, ...fields };
}
function ReturnedImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState('');
  return failed === src ? <span className={styles.imageUnavailable}>图片暂不可读取<small>可打开预览重试</small></span>
    : <img key={src} className={className} src={src} alt={alt} onError={() => setFailed(src)} />;
}

export default function CharacterLabStudio({ ownerId, isAdmin, initialWorkspaceId, initialPrompts }: { ownerId: string; isAdmin: boolean; initialWorkspaceId?: string; initialPrompts?: boolean }) {
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
  const [pendingPlanIds, setPendingPlanIds] = useState<string[]>([]);
  const [legacyResultOpen, setLegacyResultOpen] = useState(false);
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
      : [[labViewPromptFields[activePromptTarget], '生成规则', '只用于当前设置'], sharedStyleField];
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
  useDialogDismiss({ open: refinementVisible, dialogRef: refineDialog, nativeDialog: true, onDismiss: () => setRefineOpen(false) });
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
    setRefineOpen(false); setRefinement(null);
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
  }, [positionKey, pendingKey, writePending]);
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
      return !plan?.slotScoped || slot === 'legacy' || characterLabSlot(plan) === slot;
    });
  }
  async function generate(kind: CharacterLabPlan['kind'], operation?: CharacterLabOperation, refine?: Refinement) {
    await run('prepare', async () => {
      if (!workspaceRef.current || !draftRef.current) return;
      if (pendingBlocks(kind, operation)) throw new Error('这里的原提交待确认，请先核对原请求。');
      await saveDraft();
      const current = workspaceRef.current!, input = { ...draftRef.current! }, capturedScope = scope.current;
      const { plan } = await labApi<{ plan: CharacterLabPlan }>({
        action: 'prepare', workspaceId: current.id, requestId: crypto.randomUUID(), workbench: operation || kind === 'faces' ? 2 : undefined,
        kind, draft: input, operation, ...(refine ? { input: refine.target, description: refine.text } : {}),
      });
      assertActive(); if (capturedScope !== scope.current) return;
      const quote = await labApi<CharacterLabQuote>({ action: 'quote', planId: plan.id });
      assertActive(); if (capturedScope !== scope.current) return;
      if (!validImageUiQuote(quote)) throw new Error('报价已过期或不完整，请重新获取报价；尚未提交生成。');
      setPlans(previous => [plan, ...previous.filter(item => item.id !== plan.id)]);
      const label = refine ? '生成1张四宫格微调方案'
        : operation ? `生成1张${viewTitles[operation as CharacterLabView]}`
          : kind === 'faces' ? `生成1张${plan.count}宫格候选图，面部变化${characterLabStrength(plan.diversity)}` : '生成1张旧版整图';
      if (!await confirm(`${label}，${imageUiQuotePriceText(quote)}。已有图片保留。`, { title: '确认生成', confirmLabel: '开始生成' })) return;
      assertActive();
      if (capturedScope !== scope.current) throw new Error('当前角色已变化，请在原角色中查询计划。');
      if (!validImageUiQuote(quote)) throw new Error('报价已过期，请重新报价；尚未提交。');
      writePending([...pendingRef.current, plan.id], current.id);
      if (refine) setRefinement(previous => previous ? { ...previous, planId: plan.id } : previous);
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
      if (!operation) {
        const next = { ...draftRef.current!, ...(kind === 'faces' ? { facePlanId: plan.id, stage: 'faces' as const } : { resultPlanId: plan.id, stage: 'result' as const }) };
        draftRef.current = next; setDraft(next); setSaveState('dirty'); await saveDraft();
      }
      setNotice('生成任务已受理。'); void session.refreshCredits();
    });
  }
  const facePlans = plans.filter(plan => plan.kind === 'faces' && !plan.operation);
  const resultPlans = plans.filter(plan => plan.kind === 'result' && !plan.operation);
  const facePlan = facePlans.find(plan => plan.id === draft?.facePlanId) || facePlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const resultPlan = resultPlans.find(plan => plan.id === draft?.resultPlanId) || resultPlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const shownFacePlan = facePlan && tasks[facePlan.id]?.asset ? facePlan : facePlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const facePlanNumber = facePlan ? facePlans.length - facePlans.indexOf(facePlan) : null;
  const shownFacePlanNumber = shownFacePlan ? facePlans.length - facePlans.indexOf(shownFacePlan) : null;
  const shownResultPlan = resultPlan && tasks[resultPlan.id]?.asset ? resultPlan : resultPlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const currentPlan = draft?.stage === 'result' ? (legacyResultOpen ? resultPlan : undefined) : facePlan;
  const currentTask = currentPlan ? tasks[currentPlan.id] : null;
  const resultTask = shownResultPlan ? tasks[shownResultPlan.id] : null;
  const displayedOutputTask = draft?.stage === 'result' ? (legacyResultOpen ? resultTask : null) : shownFacePlan ? tasks[shownFacePlan.id] : null;
  const sendPresentationLabel = draft?.stage === 'result' ? '当前生成原图' : `候选整图（完整${shownFacePlan?.count || 4}宫格）`;
  const selectedResult = workspace?.savedResults.find(item => item.planId === shownResultPlan?.id);
  const workName = draft?.resultName || '';
  const resultName = workName.trim() || selectedResult?.name || workspace?.name || '角色参考图';
  const channels = useMemo(() => normalizeImageStudioChannels(bootstrap?.settings.imageChannels), [bootstrap?.settings.imageChannels]);
  const effectiveChannel = draft ? imageStudioEffectiveChannelId(channels, draft.model, draft.channelId, draft.quality) : 'original';
  const selectedChannel = channels.items.find(item => item.id === effectiveChannel);
  const capability = draft ? imageStudioChannelModel(selectedChannel, draft.model) : undefined;
  const legacyRoute = draft ? imageStudioUsesLegacyRoute(channels, draft.model, draft.channelId) : true;
  const modelChoices = imageStudioChannelModels(channels, IMAGE_STUDIO_MODELS);
  const qualityChoices = draft ? draft.model === 'gpt-image-2.5-sunburst' ? imageStudioNewQualityOptions(draft.model) : capability?.qualities ?? (legacyRoute ? IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[draft.model as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] : []) ?? [] : [];
  const resolutionChoices = draft ? capability?.resolutions ?? (legacyRoute ? IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[draft.model as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] : []) ?? [] : [];
  function selectFace(face: CharacterLabFace) {
    if (!draft) return;
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
          action: 'save-config', revision: bootstrap.config.revision, fields,
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
  const shownMainFace = draft?.stage === 'result' && legacyResultOpen && shownResultPlan ? shownResultPlan.mainFace : draft?.mainFace;
  const sourceId = draft?.stage === 'result' && legacyResultOpen && shownResultPlan ? shownResultPlan.sourceAssetId : draft?.stage === 'selection' && shownFacePlan ? shownFacePlan.sourceAssetId : draft?.sourceAssetId;
  const faceSourceMismatch = Boolean(shownFacePlan && draft && shownFacePlan.sourceAssetId !== draft.sourceAssetId);
  const sourceUrl = sourceId ? source && source.id === sourceId ? source.url : `/api/image-studio/assets/${encodeURIComponent(sourceId)}` : '';
  const sourceLabel = source && source.id === sourceId ? source.fileName : '生成时原始素材';
  const selectedFaces = draft ? [...(draft.mainFace ? [draft.mainFace] : []), ...draft.auxiliaryFaces] : [];
  const unresolved = pendingPlanIds.length > 0;
  const facePending = pendingBlocks('faces');
  const legacyPending = pendingBlocks('result');
  const viewSlots = ['side', 'body-front', 'body-back'] as const;
  const viewSelection = (slot: CharacterLabView) => draft?.views?.[slot];
  const referencePlan = (reference: CharacterLabReference | null | undefined) => plans.find(plan => plan.id === reference?.planId);
  const frontReady = Boolean(draft?.mainFace && referencePlan(draft.mainFace)?.sourceAssetId === draft.sourceAssetId && tasks[draft.mainFace.planId]?.asset);
  const viewReady = (slot: CharacterLabView, reference = viewSelection(slot)) => {
    const plan = referencePlan(reference);
    return Boolean(plan && characterLabSlot(plan) === slot && plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset
      && (slot !== 'side' || sameLabReference(plan.mainFace, draft?.mainFace)));
  };
  const sheetReady = frontReady && viewSlots.every(slot => viewReady(slot));
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
  }
  function showIndependentViews() {
    setLegacyResultOpen(false);
    updateDraft({ stage: 'result', views: draft?.views || {} });
  }
  function chooseView(slot: CharacterLabView, choice: CharacterLabReference) {
    if (viewReady(slot, choice)) updateDraft({ views: { ...draft?.views, [slot]: choice } });
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

  return <main className={styles.root} aria-busy={loading}>
    <header className={styles.header}>
      <div className={styles.brand}><UserRound size={21} /><strong>CHARACTER LAB</strong><span>角色参考图工作台</span></div>
      <nav className={styles.steps} aria-label="角色制作阶段">{stages.map((stage, index) => <button type="button" key={stage.id} aria-current={draft?.stage === stage.id ? 'step' : undefined} disabled={!draft || locked} onClick={() => updateDraft({ stage: stage.id })}><b>{draft && stages.findIndex(item => item.id === draft.stage) > index ? <Check size={15} /> : index + 1}</b><span>{stage.label}</span></button>)}</nav>
      <div className={styles.headerActions}>
        <label className={styles.workspaceLabel}><span className={styles.srOnly}>角色工作区</span><select value={workspace?.id || ''} disabled={locked || !bootstrap} onChange={event => void switchWorkspace(event.target.value)}><option value="" disabled>选择角色</option>{bootstrap?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className={styles.iconButton} disabled={locked || !bootstrap} onClick={() => void createWorkspace()} title="新建角色" aria-label="新建角色"><Plus size={18} /></button>
        <button type="button" aria-expanded={historyOpen} disabled={!workspace || locked} onClick={() => setHistoryOpen(value => !value)}><History size={16} /><span>历史记录</span></button>
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
      {historyOpen && <section className={styles.historyPanel} aria-label="角色生成历史"><header><h2>历史记录</h2><button type="button" className={styles.iconButton} onClick={() => setHistoryOpen(false)} aria-label="关闭历史记录"><X size={17} /></button></header>{!plans.length && <p>尚未生成候选或成品。</p>}<div className={styles.historyRows}>{plans.map(plan => <article className={styles.historyItem} key={plan.id}><button type="button" disabled={locked} onClick={() => {
        if ((plan.operation === 'refine-face' || plan.operation === 'refine-side') && plan.input && plan.sourceAssetId === draft.sourceAssetId) openRefinement(plan.operation, plan.input, plan);
        else if (plan.operation) showIndependentViews();
        else if (plan.kind === 'faces') updateDraft({ facePlanId: plan.id, stage: 'selection' });
        else { setLegacyResultOpen(true); updateDraft({ resultPlanId: plan.id, stage: 'result' }); }
        setHistoryOpen(false);
      }}>{tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={plan.kind === 'faces' ? '历史人脸候选' : '历史角色参考图'} /> : <span className={styles.historyPlaceholder}><Grid2X2 size={22} /></span>}<span><strong>{plan.operation ? promptTitles[plan.operation].replace('提示词', '') : plan.kind === 'faces' ? `${plan.count}宫格候选` : '旧版角色参考图'} · {taskState[tasks[plan.id]?.status || ''] || '尚未提交或待核对'}</strong></span></button><small><RelativeTime value={plan.createdAt} /> · 面部差异 {plan.diversity}%</small></article>)}</div></section>}
      <div className={styles.workbench}>
        <aside className={styles.materialRail}><section className={styles.materialSection}><h2>原始素材</h2>{sourceUrl ? <><button type="button" className={styles.sourceImage} data-material-arrived={draft.sourceAssetId && sourceArrival.arrived?.includes(draft.sourceAssetId) || undefined} onClick={() => setPreview({ src: sourceUrl, alt: '原始角色素材' })}><ReturnedImage src={sourceUrl} alt="原始角色素材" /></button><div className={styles.fileRow}><span title={sourceLabel}>{sourceLabel}</span></div></> : <button type="button" className={styles.uploadEmpty} disabled={locked} onClick={() => setPickerOpen(true)}><ImagePlus size={32} /><strong>添加原始素材</strong><span>上传或从素材库选择一张图片</span></button>}<button type="button" className={styles.outline} disabled={locked || unresolved} onClick={() => setPickerOpen(true)}><ImagePlus size={15} />{draft.sourceAssetId ? '更换原图' : '选择原图'}</button></section>
          {draft.stage === 'result' && shownMainFace && <section className={styles.materialSection}><div className={styles.sectionTitle}><h2>主面部 · {String(shownMainFace!.cell + 1).padStart(2, '0')}</h2><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}>更换方案<ArrowRight size={13} /></button></div><button type="button" className={styles.faceReference} onClick={() => setPreview({ src: characterLabMediaUrl(shownMainFace!.planId, shownMainFace!.cell), alt: '选定主面部' })}><ReturnedImage src={characterLabMediaUrl(shownMainFace!.planId, shownMainFace!.cell)} alt="选定主面部" /></button></section>}
          {draft.stage !== 'result' && facePlans.length > 0 && <section className={styles.materialSection}><h2>历史候选</h2><div className={styles.batchList}>{facePlans.map((plan, index) => <button type="button" key={plan.id} aria-pressed={facePlan?.id === plan.id} disabled={locked} onClick={() => updateDraft({ facePlanId: plan.id })}>{tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={`第${facePlans.length - index}组人脸候选`} /> : <Grid2X2 size={22} />}<span>第{facePlans.length - index}组 · {plan.count}宫格<small>{taskState[tasks[plan.id]?.status || ''] || '未提交或待核对'}</small></span></button>)}</div></section>}
        </aside>
        <section className={styles.canvasColumn} aria-label={draft.stage === 'result' ? '角色成品预览' : '人脸候选'}>
          <div className={styles.canvasHeading}><h2>{draft.stage === 'result' ? '角色参考图' : draft.stage === 'selection' ? '选择喜欢的面部方案' : '生成结果'}{draft.stage !== 'result' && facePlan && <span> · 第{facePlanNumber}组 · {facePlan.count}宫格</span>}</h2><div className={styles.canvasActions}>{draft.stage !== 'result' && shownFacePlan && (
            <button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(shownFacePlan.id), alt: '本批候选原图' })}><Maximize2 size={14} />查看整张宫格</button>
          )}{displayedOutputTask?.asset && <ImageFeishuStatus key={`${ownerId}:${displayedOutputTask.id}`} owner={ownerId} taskId={displayedOutputTask.id} presentationLabel={sendPresentationLabel} />}<button type="button" className={styles.iconButton} disabled={locked} onClick={() => void run('query', refreshTasks)} aria-label="查询生成状态" title="查询生成状态"><RefreshCw size={16} /></button></div></div>
          {currentPlan && !currentTask && <div className={styles.taskStatus}>{currentPlan.kind === 'faces' && <span>本次{currentPlan.count}宫格 · </span>}此计划尚未提交或提交结果待核对。下方已有结果保留。</div>}
          {currentTask && <div className={styles.taskStatus} role="status">
            {['queued', 'running'].includes(currentTask.status) && <Loader2 className={styles.spinner} size={15} />}
            <span>{currentPlan?.kind === 'faces' && <>第{facePlanNumber}组 · {currentPlan.count}宫格 · </>}{taskState[currentTask.status] || '状态待确认'}{currentTask.error && <> · {currentTask.error}</>}</span>
            {currentTask.resultDisposition && <span>图片已返回，请核对实际规格。</span>}
          </div>}
          {draft.stage !== 'result' && facePlan && shownFacePlan && facePlan.id !== shownFacePlan.id && <div className={styles.previousOutput}>
            <strong>当前显示第{shownFacePlanNumber}组 · {shownFacePlan.count}宫格旧图</strong>
            <span>第{facePlanNumber}组 · {facePlan.count}宫格尚无可显示的新图片。旧图生成于 <RelativeTime value={shownFacePlan.createdAt} />。</span>
          </div>}
          {draft.stage === 'result' ? !legacyResultOpen ? renderViewBoard() : shownResultPlan && resultTask?.asset ? <><div className={styles.resultArea}><button type="button" className={styles.resultImage} onClick={() => setPreview({ src: characterLabMediaUrl(shownResultPlan.id), alt: '角色四格参考图' })}><ReturnedImage src={characterLabMediaUrl(shownResultPlan.id)} alt="角色四格参考图：正面特写、侧面特写、正面全身、背面全身" /></button></div><div className={styles.canvasTools}><span>成图比例 2:3{resultTask.asset.width && resultTask.asset.height ? ` · 实际 ${resultTask.asset.width}×${resultTask.asset.height}` : ''}</span><button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(shownResultPlan.id), alt: '角色参考图' })}><Maximize2 size={15} />放大</button></div></> : <div className={styles.canvasEmpty}><Grid2X2 size={42} /><h3>{currentTask && ['queued', 'running'].includes(currentTask.status) ? '正在制作角色参考图' : '在这里预览角色参考图'}</h3><p>选定面部后，结合原图生成正面特写、侧面特写和正背全身。</p>{draft.mainFace && <button type="button" className={styles.primary} disabled={locked || unresolved} onClick={showIndependentViews}>制作角色参考图<ArrowRight size={16} /></button>}</div> : shownFacePlan ? <div className={styles.candidateGrid} style={{ gridTemplateColumns: `repeat(${shownFacePlan.count === 9 ? 3 : 2}, minmax(0, 1fr))` }}>{Array.from({ length: shownFacePlan.count }, (_, cell) => {
            const face = { planId: shownFacePlan.id, cell }, main = sameFace(draft.mainFace, face), auxiliary = draft.auxiliaryFaces.some(item => sameFace(item, face));
            return <article key={cell} className={styles.candidate} data-main={main} data-auxiliary={auxiliary}><button type="button" className={styles.candidateImage} disabled={locked} aria-pressed={main} aria-label={`选择候选${cell + 1}作为主面部`} onClick={() => selectFace(face)}><ReturnedImage src={characterLabMediaUrl(shownFacePlan.id, cell)} alt={`真人面部候选${cell + 1}`} /><span className={styles.cellNumber}>{String(cell + 1).padStart(2, '0')}</span>{main && <span className={styles.mainBadge}><Check size={12} />主面部</span>}{auxiliary && <span className={styles.auxBadge}>辅助参考</span>}</button><div className={styles.cellActions}><button type="button" disabled={locked} onClick={() => setPreview({ src: characterLabMediaUrl(shownFacePlan.id, cell), alt: `候选${cell + 1}` })}><Maximize2 size={13} />放大</button><button type="button" disabled={locked || main} aria-pressed={auxiliary} onClick={() => toggleAuxiliary(face)}>{auxiliary ? '移除辅助' : '作为辅助'}</button></div></article>;
          })}</div> : <div className={styles.canvasEmpty}><UserRound size={46} /><h3>{currentTask && ['queued', 'running'].includes(currentTask.status) ? '正在探索不同的面部方案' : '探索适合角色的真人面孔'}</h3><p>添加一张角色原图，调整面部差异，生成4宫格或9宫格候选。</p>{!draft.sourceAssetId && <button type="button" className={styles.outline} disabled={locked} onClick={() => setPickerOpen(true)}><ImagePlus size={16} />添加原始素材</button>}</div>}
          {draft.stage === 'result' && resultPlans.length > 0 && <div className={styles.versionStrip}><span>旧版整图</span>{resultPlans.map((plan, index) => <button type="button" key={plan.id} aria-pressed={shownResultPlan?.id === plan.id} disabled={locked} onClick={() => { setLegacyResultOpen(true); updateDraft({ resultPlanId: plan.id }); }}>{tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={`角色参考图v${resultPlans.length - index}`} /> : <Grid2X2 size={18} />}<span>v{resultPlans.length - index}</span></button>)}</div>}
        </section>
        <aside className={styles.controls}>
          {draft.stage === 'result' && !legacyResultOpen ? <>
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
          </> : draft.stage === 'result' ? <><section className={styles.resultState}><strong>旧版成品 {shownResultPlan ? `v${resultPlans.length - resultPlans.findIndex(item => item.id === shownResultPlan.id)}` : ''}</strong><span>{selectedResult ? '已保存' : resultTask?.asset ? '已生成' : '待生成'}</span></section><section><h2>保存与导出</h2><label className={styles.field}><span>作品名称</span><input value={workName} placeholder={selectedResult?.name || workspace.name} maxLength={80} onChange={event => updateDraft({ resultName: event.target.value })} /></label><div className={styles.field}><span>导出内容</span><div className={styles.segmented}>{([['sheet', '整图'], ['cells', '单张'], ['all', '全部']] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={exportMode === mode} onClick={() => setExportMode(mode)}>{label}</button>)}</div></div><div className={styles.exportDetails}><span>文件格式 <b>PNG{exportMode !== 'sheet' ? ' / ZIP' : ''}</b></span><span>图片尺寸 <b>原始尺寸</b></span></div><div className={styles.actionPair}><button type="button" className={styles.primary} disabled={locked || !shownResultPlan || !resultTask?.asset} onClick={() => void saveResult()}><Save size={16} />保存成品</button><button type="button" className={styles.outline} disabled={locked || !shownResultPlan || !resultTask?.asset} onClick={() => void exportResult()}><Download size={16} />导出图片</button></div><p className={styles.hint}>直接保存当前结果，无需重新生成。</p></section><details className={styles.adjustments}><summary><SlidersHorizontal size={16} />调整成品<ChevronDown size={15} /></summary><label className={styles.field}><span>调整要求</span><textarea rows={4} value={draft.adjustment} maxLength={3000} onChange={event => updateDraft({ adjustment: event.target.value })} placeholder="例如：侧面保持平视，露出完整发型" /></label><label className={styles.field}><span>调整位置</span><select value={draft.adjustmentCell ?? 'all'} onChange={event => updateDraft({ adjustmentCell: event.target.value === 'all' ? null : Number(event.target.value) })}><option value="all">全部四格</option>{['正面特写', '侧面特写', '正面全身', '背面全身'].map((label, index) => <option key={index} value={index}>{label}</option>)}</select></label>{renderPromptButton('result')}{renderGenerationSettings()}<button type="button" className={styles.outline} disabled={locked || legacyPending || !draft.mainFace || faceSourceMismatch} onClick={() => void generate('result')}><RefreshCw size={15} />生成新版本</button></details><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}><ArrowLeft size={15} />返回选择</button><button type="button" className={styles.outline} disabled={locked} onClick={showIndependentViews}>制作独立四格<ArrowRight size={15} /></button></> : <>
            {draft.stage === 'selection' && <section className={styles.selectedSection}><h2>已选 {selectedFaces.length} 个方案</h2>{faceSourceMismatch && <div className={styles.sourceMismatch}><p>这组候选来自另一张原图。</p><button type="button" disabled={locked} onClick={() => updateDraft({ sourceAssetId: shownFacePlan!.sourceAssetId, views: {} })}>使用本组原图</button></div>}{selectedFaces.length > 0 ? <div className={styles.selectedFaces}>{selectedFaces.map((face, index) => <div key={`${face.planId}:${face.cell}`} data-main={index === 0 && Boolean(draft.mainFace)}><button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(face.planId, face.cell), alt: index === 0 && draft.mainFace ? '主面部' : '辅助参考' })}><ReturnedImage src={characterLabMediaUrl(face.planId, face.cell)} alt={index === 0 && draft.mainFace ? '主面部' : '辅助参考'} /></button><span>{index === 0 && draft.mainFace ? '主面部' : '辅助参考'} {String(face.cell + 1).padStart(2, '0')}</span>{index > 0 && <button type="button" className={styles.removeAux} aria-label={`移除辅助参考${face.cell + 1}`} onClick={() => toggleAuxiliary(face)}><X size={13} /></button>}</div>)}</div> : <p className={styles.hint}>点击候选确定主面部，可另外添加辅助参考。</p>}<label className={styles.field}><span>辅助特征</span><textarea rows={3} maxLength={1000} value={draft.auxiliaryFeatures} onChange={event => updateDraft({ auxiliaryFeatures: event.target.value })} placeholder="例如：参考辅助方案的鼻梁与眼部气质" /></label><p className={styles.hint}>主面部确定身份，辅助参考提供特征方向。</p></section>}
            <section><div className={styles.settingsHeading}><h2>{draft.stage === 'faces' ? '生成设置' : '探索更多面孔'}</h2>{renderPromptButton('faces')}</div><div className={styles.segmented}>{([4, 9] as const).map(count => <button type="button" key={count} disabled={locked} aria-pressed={draft.count === count} onClick={() => updateDraft({ count })}><Grid2X2 size={16} />{count}宫格</button>)}</div><label className={styles.sliderLabel}><span>面部变化<b>{characterLabStrength(draft.diversity)}</b></span><input type="range" min="0" max="100" step="1" value={draft.diversity} aria-valuetext={characterLabStrength(draft.diversity)} disabled={locked} onChange={event => updateDraft({ diversity: Number(event.target.value) })} /><small><span>小幅</span><span>中等</span><span>明显</span></small></label><p className={styles.hint}>小幅围绕同一张脸做局部变化。设置用于下一批候选。</p>{draft.stage === 'faces' && <label className={styles.field}><span>角色补充要求</span><textarea rows={4} maxLength={3000} value={draft.context} disabled={locked} onChange={event => updateDraft({ context: event.target.value })} placeholder="例如：黑发、细框眼镜，沉静气质" /></label>}{renderGenerationSettings()}</section>
            {frontReady && draft.mainFace && <section className={styles.refineEntry}>
              <ReturnedImage src={characterLabMediaUrl(draft.mainFace.planId, draft.mainFace.cell)} alt="选定正脸" />
              <div><h2>选定正脸</h2><button type="button" className={styles.outline} disabled={locked} onClick={() => openRefinement('refine-face', draft.mainFace!)}>微调这张脸</button></div>
            </section>}
            <div className={styles.mainActions}>{draft.stage === 'faces' ? <><button type="button" className={shownFacePlan ? styles.outline : styles.primary} disabled={locked || facePending || !draft.sourceAssetId} onClick={() => void generate('faces')}><RefreshCw size={15} />{shownFacePlan ? '重新生成' : '生成人脸候选'}</button><button type="button" className={shownFacePlan ? styles.primary : ''} disabled={locked || !shownFacePlan} onClick={() => updateDraft({ stage: 'selection' })}>选择方案<ArrowRight size={16} /></button></> : <><button type="button" className={styles.outline} disabled={locked || facePending || !draft.sourceAssetId} onClick={() => void generate('faces')}><RefreshCw size={15} />生成另一组</button><button type="button" className={styles.primary} disabled={locked || !frontReady} onClick={showIndependentViews}>制作角色参考图<ArrowRight size={16} /></button><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'faces' })}><ArrowLeft size={15} />返回生成</button></>}</div>
          </>}
        </aside>
      </div>
      {Boolean(workspace.compositions?.length) && <section className={styles.historyPanel} aria-label="已保存的合成图">
        <header><h2>已保存的合成图</h2></header>
        <div className={styles.savedSheets}>{workspace.compositions?.map(item => {
          const url = compositionUrl(workspace.id, item.id);
          return <div key={item.id}><button type="button" onClick={() => setPreview({ src: url, alt: item.name })}>{item.name}</button>
            <a href={url + '&download=1'} download={item.name + '.png'}>下载</a></div>;
        })}</div>
      </section>}
    </>}
    <ResourceLibraryPicker open={pickerOpen} imageOnly target="image-studio" purpose="character-lab-source" contextKey={`${ownerId}:character-lab:${workspace?.id || 'draft'}`} title="选择角色原始素材" confirmLabel="使用这张原图" maxSelection={1} currentCount={0} currentAssetIds={[]} onClose={() => setPickerOpen(false)} onUploadFile={async (file: File, onProgress?: UploadProgressHandler) => { assertActive(); const capturedScope = scope.current; setUploading(true); try { const asset = await uploadFileAsAsset(file, { onProgress, ownerId }); if (capturedScope !== scope.current || !active.current) throw new Error('当前角色或账号已变化，图片没有替换到当前工作区'); return asset; } finally { if (alive.current) setUploading(false); } }} onConfirm={async (ids, assets) => { assertActive(); if (!draftRef.current || !ids[0] || busyRef.current) return false; const asset = assets?.find(item => item.id === ids[0]); setSource({ id: ids[0], url: asset?.originalUrl || `/api/image-studio/assets/${encodeURIComponent(ids[0])}`, thumbnailUrl: asset?.thumbnailUrl || '', fileName: asset?.fileName || '角色原始素材' }); updateDraft({ sourceAssetId: ids[0], facePlanId: null, resultPlanId: null, mainFace: null, auxiliaryFaces: [], views: {}, stage: 'faces' }); sourceArrival.mark([ids[0]]); return true; }} />
    {preview && sessionReady && <ZoomableImagePreview src={preview.src} alt={preview.alt} fileName="character-reference.png" imageSharing={false} onClose={() => setPreview(null)} />}
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
          {draft && activePromptTarget !== 'result' && <details className={styles.promptPreview}>
            <summary>查看本次规则预览</summary>
            <pre>{activePromptTarget === 'faces'
              ? faceLabPrompt(bootstrap.config, draft)
              : labViewPrompt(bootstrap.config, activePromptTarget, refinement?.operation === activePromptTarget ? refinement.text : '')}</pre>
          </details>}
          {activePromptFields.map(([field, title, placeholder]) => (
            <label className={styles.field} key={field}>
              <span>{title}</span>
              <textarea rows={field === 'resultPrompt' ? 6 : 4} maxLength={3000} value={configDraft[field]} placeholder={placeholder} disabled={Boolean(busy)} onChange={event => {
                const value = event.target.value;
                setConfigDraft(previous => previous ? { ...previous, [field]: value } : previous);
              }} />
              {field === 'styleConstraints' && <small>工作台各生成设置共用这条风格规则。</small>}
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
  </main>;

  function renderPromptButton(target: PromptTarget) {
    if (!isAdmin) return null;
    return <button type="button" className={styles.promptTrigger} aria-haspopup="dialog" aria-label={promptTitles[target]} disabled={locked || !configDraft} onClick={() => { setConfigError(''); setPromptTarget(target); }}>
      <Settings2 size={15} />{target === 'faces' ? '人脸提示词' : target === 'result' ? '整图提示词' : '提示词'}
    </button>;
  }

  function renderViewBoard() {
    const front = draft?.mainFace;
    return <div className={styles.viewBoard}>
      <article className={styles.viewSlot}>
        <div className={styles.settingsHeading}><h2>正脸</h2>{frontReady && <small>已选用</small>}</div>
        {frontReady && front ? <>
          <button type="button" className={styles.viewImage} onClick={() => setPreview({ src: characterLabMediaUrl(front.planId, front.cell), alt: '选定正脸' })}>
            <ReturnedImage src={characterLabMediaUrl(front.planId, front.cell)} alt="选定正脸" />
          </button>
          <div className={styles.viewActions}><button type="button" className={styles.outline} disabled={locked} onClick={() => openRefinement('refine-face', front)}>微调这张脸</button></div>
        </> : <div className={styles.viewEmpty}>先选定一张正脸</div>}
      </article>
      {viewSlots.map(slot => {
        const title = viewTitles[slot], selected = viewSelection(slot);
        const options = plans.filter(plan => plan.operation === slot && plan.sourceAssetId === draft?.sourceAssetId
          && (slot !== 'side' || sameLabReference(plan.mainFace, draft?.mainFace)));
        const latest = options.find(plan => tasks[plan.id] || pendingPlanIds.includes(plan.id));
        const latestTask = latest ? tasks[latest.id] : null;
        const available = options.filter(plan => tasks[plan.id]?.asset);
        const adopted = viewReady(slot);
        const shown: CharacterLabReference | undefined = adopted ? selected : available[0] ? { planId: available[0].id } : undefined;
        const src = shown ? characterLabMediaUrl(shown.planId, shown.cell) : '';
        const canGenerate = Boolean(draft?.sourceAssetId && (slot !== 'side' || frontReady));
        return <article className={styles.viewSlot} key={slot} data-body={slot !== 'side'}>
          <div className={styles.settingsHeading}><h2>{title}</h2>{renderPromptButton(slot)}</div>
          {shown ? <button type="button" className={styles.viewImage}
            onClick={() => slot === 'side' && !locked ? openRefinement('refine-side', shown) : setPreview({ src, alt: title })}>
            <ReturnedImage src={src} alt={title} />
          </button> : <div className={styles.viewEmpty}>{slot === 'side' && !frontReady ? '先选定正脸' : '待生成'}</div>}
          <div className={styles.viewActions}>
            <button type="button" className={styles.outline} disabled={locked || !canGenerate || pendingBlocks('result', slot)}
              onClick={() => void generate('result', slot)}>{shown ? '再生成' : '生成'}{title}</button>
            {shown && !adopted && <button type="button" className={styles.primary} disabled={locked} onClick={() => chooseView(slot, shown)}>选用这张</button>}
            {shown && slot === 'side' && <button type="button" disabled={locked} onClick={() => openRefinement('refine-side', shown)}>微调侧脸</button>}
            {shown && <a href={src + '&download=1'} download={title + '.png'}>下载</a>}
          </div>
          {(latest || selected) && <p className={styles.hint} role="status">
            {latest ? (latestTask ? taskState[latestTask.status] || '状态待确认' : '原提交待确认') : ''}
            {latestTask?.error && <> · {latestTask.error}</>}
            {adopted ? ' · 已选用' : selected && slot === 'side' ? ' · 旧侧脸保留在历史，请选用当前正脸对应的版本' : ''}
          </p>}
          {available.some(plan => plan.id !== shown?.planId) && <details className={styles.viewHistory}>
            <summary>选用其他版本</summary>
            <div>{available.filter(plan => plan.id !== shown?.planId).map((plan, index) => (
              <button type="button" key={plan.id} disabled={locked} onClick={() => chooseView(slot, { planId: plan.id })}>
                <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={title + '候选'} /><span>选用方案 {index + 1}</span>
              </button>
            ))}</div>
          </details>}
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
          <p>{side ? '以选定正脸锁定身份，只调整这张侧脸的局部细节。' : '保留这张脸的身份，给指定细节做四个微调方案。'}</p>
        </div>
        <label className={styles.field}><span>修改要求</span>
          <textarea rows={3} value={current.text} maxLength={3000} disabled={locked}
            placeholder={side ? '例如：稍微收一点下颌，保持鼻尖和侧脸方向' : '例如：鼻梁稍低一点，保留眼距和发型'}
            onChange={event => setRefinement({ ...current, text: event.target.value })} />
        </label>
        {refinePlan && <p role="status" className={styles.hint}>{refineTask ? taskState[refineTask.status] || '状态待确认'
          : pendingPlanIds.includes(refinePlan.id) ? '原提交待确认' : '尚未提交'}{refineTask?.error && <> · {refineTask.error}</>}</p>}
        {refinePlan && resultReady && <div className={styles.refineChoices}>
          {Array.from({ length: 4 }, (_, cell) => {
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
        {error && <p role="alert">{error}</p>}
        {renderPromptButton(current.operation)}
        <button type="button" onClick={() => setRefineOpen(false)}>关闭</button>
        <button type="button" className={styles.primary} disabled={locked || !current.text.trim() || !inputCurrent || pendingBlocks('faces', current.operation)}
          onClick={() => void generate('faces', current.operation, current)}>{busy ? busyCopy : '生成四个方案'}</button>
      </footer>
    </dialog>;
  }

  function renderGenerationSettings() {
    if (!draft) return null;
    return <details className={styles.generationSettings} open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>模型与项目<ChevronDown size={14} /></summary><label className={styles.field}><span>模型</span><select disabled={locked} value={draft.model} onChange={event => updateDraft({ model: event.target.value })}>{!modelChoices.includes(draft.model as typeof IMAGE_STUDIO_MODELS[number]) && <option value={draft.model}>{draft.model}</option>}{modelChoices.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model}</option>)}</select></label><label className={styles.field}><span>供应商</span><ImageGenerationChannelSelect channels={channels} model={draft.model} value={draft.channelId} disabled={locked} onChange={channelId => updateDraft({ channelId })} /></label><div className={styles.parameterPair}><label className={styles.field}><span>画质</span><select value={draft.quality} disabled={locked} onChange={event => updateDraft({ quality: event.target.value })}>{!qualityChoices.includes(draft.quality as never) && <option value={draft.quality}>{imageStudioQualityLabel(draft.model, draft.quality)}</option>}{qualityChoices.map(quality => <option key={quality} value={quality}>{imageStudioQualityLabel(draft.model, quality)}</option>)}</select></label><label className={styles.field}><span>分辨率</span><select value={draft.resolution} disabled={locked} onChange={event => updateDraft({ resolution: event.target.value })}>{!resolutionChoices.includes(draft.resolution as never) && <option value={draft.resolution}>{draft.resolution}</option>}{resolutionChoices.map(resolution => <option key={resolution} value={resolution}>{resolution}</option>)}</select></label></div><ImageUsageProjectSelect ownerId={ownerId} value={draft.projectId} disabled={locked} onChange={projectId => updateDraft({ projectId })} /></details>;
  }
}
