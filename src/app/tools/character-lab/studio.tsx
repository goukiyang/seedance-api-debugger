'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Download, Grid2X2, History, ImagePlus, Loader2, Maximize2, Plus, RefreshCw, Save, Settings2, SlidersHorizontal, UserRound, X } from 'lucide-react';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { ImageGenerationChannelSelect } from '@/components/ImageGenerationChannelSelect';
import { ImageUsageProjectSelect } from '@/components/ImageUsageProjectSelect';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { RelativeTime } from '@/components/RelativeTime';
import { ImageFeishuStatus } from '@/components/image-studio/ImageFeishuStatus';
import { useProductDialog } from '@/components/useProductDialog';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { uploadFileAsAsset, type UploadProgressHandler } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import { handImageDownloadToBrowser } from '@/lib/media/native-download';
import { imageUiQuoteFields, imageUiQuotePriceText, validImageUiQuote } from '@/app/image-studio/use-studio-batch';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, imageStudioNewQualityOptions, imageStudioQualityLabel } from '@/lib/image-studio/model-catalog';
import { imageStudioChannelModel, imageStudioChannelModels, imageStudioEffectiveChannelId, imageStudioUsesLegacyRoute, normalizeImageStudioChannels } from '@/lib/image-studio/channels';
import { characterLabMediaUrl, type CharacterLabBootstrap, type CharacterLabConfig, type CharacterLabDraft, type CharacterLabFace, type CharacterLabPlan, type CharacterLabPromptFields, type CharacterLabQuote, type CharacterLabStage, type CharacterLabTask, type CharacterLabWorkspace, type CharacterLabWorkspacePayload } from '@/lib/character-lab/types';
import styles from './studio.module.css';

const stages: Array<{ id: CharacterLabStage; label: string }> = [{ id: 'faces', label: '人脸生成' }, { id: 'selection', label: '方案选择' }, { id: 'result', label: '成品预览' }];
const promptFields: Array<[keyof CharacterLabPromptFields, string, string]> = [
  ['basePrompt', '基础提示词', '真人候选的通用生成规则'], ['characterContext', '角色上下文要求', '从原图理解角色时需要保留的身份与特征'],
  ['faceVariables', '面部变量', '脸型、骨相和五官比例的差异规则'], ['styleConstraints', '风格约束', '摄影质感、光线和统一画面要求'], ['resultPrompt', '成品生成规则', '面部一致性、服装与四格构图要求'],
];
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
  return { basePrompt: config.basePrompt, characterContext: config.characterContext, faceVariables: config.faceVariables, styleConstraints: config.styleConstraints, resultPrompt: config.resultPrompt };
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
  const [draft, setDraft] = useState<CharacterLabDraft | null>(null);
  const [plans, setPlans] = useState<CharacterLabPlan[]>([]);
  const [tasks, setTasks] = useState<Record<string, CharacterLabTask | null>>({});
  const [source, setSource] = useState<CharacterLabWorkspacePayload['sourceAsset']>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'failed'>('saved');
  const [saveConflict, setSaveConflict] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false), [uploading, setUploading] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [advanced, setAdvanced] = useState(false);
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'sheet' | 'cells' | 'all'>('all');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const [promptView, setPromptView] = useState(Boolean(initialPrompts && isAdmin));
  const [configDraft, setConfigDraft] = useState<CharacterLabPromptFields | null>(null), [configVersion, setConfigVersion] = useState<number | null>(null);
  const initialized = useRef(false);
  const workspaceRef = useRef(workspace), draftRef = useRef(draft), alive = useRef(true), busyRef = useRef(false), scope = useRef(0), loadSequence = useRef(0), savePromise = useRef<Promise<void> | null>(null), savedSignature = useRef(''), pendingRef = useRef<string | null>(null);
  workspaceRef.current = workspace; draftRef.current = draft; pendingRef.current = pendingPlanId;
  const sessionReady = session.hasLoadedUser && !session.userLoadError && !session.sessionChanged && session.user?.id === ownerId;
  const active = useRef(false); active.current = sessionReady && !isClientSessionBlocked();
  const positionKey = `sd2:character-lab:position:v1:${ownerId}`;
  const pendingKey = (id: string) => `sd2:character-lab:submission:v1:${ownerId}:${id}`;
  const dirty = Boolean(workspace && draft && savedSignature.current !== JSON.stringify([workspace.name, draft]));
  const configDirty = Boolean(configDraft && bootstrap && JSON.stringify(configDraft) !== JSON.stringify(fieldsOf(bootstrap.config)));
  usePageExitRisk({ unsaved: dirty && saveState !== 'saved' ? ['角色工作现场尚未保存'] : promptView && configDirty ? ['管理员提示词尚未保存'] : [], busy: busy === 'submit' || uploading ? ['角色任务提交或素材上传尚未确认'] : [], revision: JSON.stringify([workspace?.id, draft, promptView && configDraft]) });
  useEffect(() => { alive.current = true; return () => { alive.current = false; scope.current++; }; }, []);
  function assertActive() { if (!active.current || isClientSessionBlocked()) throw new Error('请先确认当前账号，工作现场已保留'); }
  function updateDraft(patch: Partial<CharacterLabDraft>) {
    if (!active.current || busyRef.current) return;
    setDraft(current => current ? { ...current, ...patch } : current); setSaveState('dirty'); setNotice('');
  }
  function rememberPending(id: string | null, workspaceId: string) {
    if (id) localStorage.setItem(pendingKey(workspaceId), id); else { try { localStorage.removeItem(pendingKey(workspaceId)); } catch { /* A confirmed server receipt remains authoritative. */ } }
    pendingRef.current = id; setPendingPlanId(id);
  }
  const acceptWorkspace = useCallback((value: CharacterLabWorkspacePayload) => {
    workspaceRef.current = value.workspace; draftRef.current = value.workspace.draft;
    savedSignature.current = JSON.stringify([value.workspace.name, value.workspace.draft]);
    setWorkspace(value.workspace); setDraft(value.workspace.draft); setPlans(value.plans); setTasks(value.taskByRequestId); setSource(value.sourceAsset); setSaveState('saved'); setSaveConflict(false);
    const serverUnknown = value.plans.find(plan => value.submissionByRequestId[plan.id] === 'submitting' && !value.taskByRequestId[plan.id])?.id;
    let unresolved = serverUnknown || null;
    try {
      localStorage.setItem(positionKey, value.workspace.id);
      const pending = localStorage.getItem(pendingKey(value.workspace.id));
      if (pending && !value.taskByRequestId[pending] && value.submissionByRequestId[pending] !== 'rejected') unresolved = pending;
      if (pending && !unresolved) localStorage.removeItem(pendingKey(value.workspace.id));
    } catch { setNotice('浏览器无法记住最后位置；服务器已保存的工作区仍可手动打开。'); }
    pendingRef.current = unresolved; setPendingPlanId(unresolved);
    const address = new URL(window.location.href); address.searchParams.set('workspace', value.workspace.id); window.history.replaceState(window.history.state, '', address);
    setBootstrap(current => current ? { ...current, workspaces: [value.workspace, ...current.workspaces.filter(item => item.id !== value.workspace.id)] } : current);
  }, [positionKey]);
  async function openWorkspace(id: string) {
    assertActive(); const sequence = ++loadSequence.current; scope.current++; setLoading(true); setError('');
    try { const value = await labApi<CharacterLabWorkspacePayload>(undefined, `?workspace=${encodeURIComponent(id)}`); if (alive.current && sequence === loadSequence.current && active.current) acceptWorkspace(value); }
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
        setBootstrap(value); setConfigDraft(fieldsOf(value.config)); setConfigVersion(value.config.revision);
        let saved = '';
        try { saved = localStorage.getItem(positionKey) || ''; } catch { /* The project selector remains usable. */ }
        const requested = initialWorkspaceId || saved;
        const id = value.workspaces.find(item => item.id === requested)?.id || (!initialWorkspaceId ? value.workspaces[0]?.id : undefined);
        if (initialWorkspaceId && !id) setError('指定角色工作区不存在或已无权访问，请从角色列表重新选择。');
        if (id) {
          const payload = await labApi<CharacterLabWorkspacePayload>(undefined, `?workspace=${encodeURIComponent(id)}`);
          if (alive.current && active.current && sequence === loadSequence.current) acceptWorkspace(payload);
        }
      } catch (cause) { if (alive.current && sequence === loadSequence.current) setError(readableError(cause)); }
      finally { if (alive.current && sequence === loadSequence.current) setLoading(false); }
    })();
  }, [ownerId, sessionReady, initialWorkspaceId, positionKey, acceptWorkspace]); // Read-only recovery never submits a task.
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
    const result = await labApi<CharacterLabWorkspacePayload>(undefined, `?workspace=${encodeURIComponent(id)}`);
    if (!alive.current || capturedScope !== scope.current || !active.current) return;
    setPlans(result.plans); setTasks(result.taskByRequestId);
    if (pendingRef.current && (result.taskByRequestId[pendingRef.current] || result.submissionByRequestId[pendingRef.current] === 'rejected')) {
      try { localStorage.removeItem(pendingKey(id)); } catch { /* Server state has confirmed this request. */ }
      const recoveredId = pendingRef.current;
      const found = Boolean(result.taskByRequestId[recoveredId]);
      const recoveredPlan = result.plans.find(plan => plan.id === recoveredId);
      if (found && recoveredPlan && draftRef.current) {
        const next = { ...draftRef.current, ...(recoveredPlan.kind === 'faces' ? { facePlanId: recoveredId, stage: 'faces' as const } : { resultPlanId: recoveredId, stage: 'result' as const }) };
        draftRef.current = next; setDraft(next); setSaveState('dirty');
      }
      pendingRef.current = null; setPendingPlanId(null); setNotice(found ? '已核对到原任务，继续查看处理结果。' : '服务器已确认原提交未被受理，可以调整后重新生成。'); void session.refreshCredits();
    }
  }, [ownerId, session.refreshCredits]);
  const hasRunning = Object.values(tasks).some(task => task && ['queued', 'running'].includes(task.status));
  useEffect(() => {
    if (!workspace || !sessionReady || (!hasRunning && !pendingPlanId)) return;
    let checking = false, unknownChecks = 0;
    const timer = setInterval(() => {
      if (document.hidden || checking || (pendingRef.current && unknownChecks >= 12 && !hasRunning)) return;
      checking = true; if (pendingRef.current) unknownChecks++;
      void refreshTasks().catch(() => {}).finally(() => { checking = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [workspace?.id, sessionReady, hasRunning, pendingPlanId, refreshTasks]);
  async function run(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setNotice('');
    try { assertActive(); await action(); } catch (cause) { if (alive.current) setError(readableError(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(''); }
  }
  async function createWorkspace() {
    const name = await askName('角色名称', '未命名角色', { title: '新建角色', confirmLabel: '创建角色', maxLength: 80 });
    if (name === null) return;
    await run('create', async () => { await saveDraft(); const result = await labApi<{ workspace: CharacterLabWorkspace }>({ action: 'create-workspace', id: crypto.randomUUID(), name }); await openWorkspace(result.workspace.id); });
  }
  async function switchWorkspace(id: string) {
    if (id === workspace?.id) return;
    await run('open', async () => { await saveDraft(); await openWorkspace(id); });
  }
  async function generate(kind: 'faces' | 'result') {
    await run('prepare', async () => {
      if (!workspaceRef.current || !draftRef.current) return;
      if (pendingRef.current) throw new Error('原提交结果待确认，请先核对原请求；已有结果和输入保留。');
      await saveDraft();
      const current = workspaceRef.current!, input = { ...draftRef.current! }, capturedScope = scope.current;
      const { plan } = await labApi<{ plan: CharacterLabPlan }>({ action: 'prepare', workspaceId: current.id, requestId: crypto.randomUUID(), kind, draft: input });
      assertActive(); if (capturedScope !== scope.current) return;
      const quote = await labApi<CharacterLabQuote>({ action: 'quote', planId: plan.id });
      assertActive(); if (capturedScope !== scope.current) return;
      if (!validImageUiQuote(quote)) throw new Error('报价已过期或不完整，请重新获取报价；尚未提交生成。');
      setPlans(previous => [plan, ...previous.filter(item => item.id !== plan.id)]);
      if (!await confirm(`${kind === 'faces' ? `生成1张${input.count}宫格候选图，面部差异${input.diversity}%` : '生成1张2:3角色参考图'}，${imageUiQuotePriceText(quote)}。已有结果和历史版本保留。`, { title: '确认生成', confirmLabel: '开始生成' })) return;
      assertActive();
      if (capturedScope !== scope.current) throw new Error('当前角色已变化，请在原角色中查询计划。');
      if (!validImageUiQuote(quote)) throw new Error('报价已过期，请重新报价；尚未提交。');
      rememberPending(plan.id, current.id); // Persist before the potentially billable request.
      setBusy('submit');
      try {
        await labApi({ action: 'submit', planId: plan.id, ...imageUiQuoteFields(quote) });
        rememberPending(null, current.id);
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'submitted' in cause && cause.submitted === false) rememberPending(null, current.id);
        throw cause;
      } finally { await refreshTasks().catch(() => {}); }
      if (capturedScope !== scope.current || !active.current) return;
      const next = { ...draftRef.current!, ...(kind === 'faces' ? { facePlanId: plan.id, stage: 'faces' as const } : { resultPlanId: plan.id, stage: 'result' as const }) };
      draftRef.current = next; setDraft(next); setSaveState('dirty'); await saveDraft();
      setNotice('生成任务已受理，可以继续查看已有结果。'); void session.refreshCredits();
    });
  }
  const facePlans = plans.filter(plan => plan.kind === 'faces');
  const resultPlans = plans.filter(plan => plan.kind === 'result');
  const facePlan = facePlans.find(plan => plan.id === draft?.facePlanId) || facePlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const resultPlan = resultPlans.find(plan => plan.id === draft?.resultPlanId) || resultPlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const shownFacePlan = facePlan && tasks[facePlan.id]?.asset ? facePlan : facePlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const shownResultPlan = resultPlan && tasks[resultPlan.id]?.asset ? resultPlan : resultPlans.find(plan => plan.sourceAssetId === draft?.sourceAssetId && tasks[plan.id]?.asset);
  const currentPlan = draft?.stage === 'result' ? resultPlan : facePlan;
  const currentTask = currentPlan ? tasks[currentPlan.id] : null;
  const resultTask = shownResultPlan ? tasks[shownResultPlan.id] : null;
  const displayedOutputTask = draft?.stage === 'result' ? resultTask : shownFacePlan ? tasks[shownFacePlan.id] : null;
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
  function closePrompts() { setPromptView(false); const address = new URL(window.location.href); address.searchParams.delete('view'); window.history.replaceState(window.history.state, '', address); }
  function showPrompts() { if (!bootstrap || !isAdmin) return; if (!configDraft) { setConfigDraft(fieldsOf(bootstrap.config)); setConfigVersion(bootstrap.config.revision); } setPromptView(true); const address = new URL(window.location.href); address.searchParams.set('view', 'prompts'); window.history.replaceState(window.history.state, '', address); }
  async function saveConfig() {
    await run('config', async () => {
      if (!bootstrap || !configDraft) return;
      const result = await labApi<{ config: CharacterLabConfig; configVersions: CharacterLabConfig[] }>({ action: 'save-config', revision: bootstrap.config.revision, fields: configDraft });
      setBootstrap(current => current ? { ...current, ...result } : current); setConfigDraft(fieldsOf(result.config)); setConfigVersion(result.config.revision); closePrompts(); setNotice('提示词新版本已保存，将用于之后的新生成。');
    });
  }
  const locked = Boolean(busy) || uploading || loading || !sessionReady;
  const shownMainFace = draft?.stage === 'result' && shownResultPlan ? shownResultPlan.mainFace : draft?.mainFace;
  const sourceId = draft?.stage === 'result' && shownResultPlan ? shownResultPlan.sourceAssetId : draft?.stage === 'selection' && shownFacePlan ? shownFacePlan.sourceAssetId : draft?.sourceAssetId;
  const faceSourceMismatch = Boolean(shownFacePlan && draft && shownFacePlan.sourceAssetId !== draft.sourceAssetId);
  const sourceUrl = sourceId ? source && source.id === sourceId ? source.url : `/api/image-studio/assets/${encodeURIComponent(sourceId)}` : '';
  const sourceLabel = source && source.id === sourceId ? source.fileName : '生成时原始素材';
  const selectedFaces = draft ? [...(draft.mainFace ? [draft.mainFace] : []), ...draft.auxiliaryFaces] : [];
  const unresolved = Boolean(pendingPlanId);
  const busyCopy = ({ prepare: '正在准备生成与报价…', submit: '正在确认原请求…', config: '正在保存提示词…', export: '正在准备下载…' } as Record<string, string>)[busy] || (busy ? '正在处理…' : '');

  return <main className={styles.root} aria-busy={loading}>
    <header className={styles.header}>
      <div className={styles.brand}><UserRound size={21} /><strong>CHARACTER LAB</strong><span>角色参考图工作台</span></div>
      <nav className={styles.steps} aria-label="角色制作阶段">{stages.map((stage, index) => <button type="button" key={stage.id} aria-current={draft?.stage === stage.id ? 'step' : undefined} disabled={!draft || locked} onClick={() => { closePrompts(); updateDraft({ stage: stage.id }); }}><b>{draft && stages.findIndex(item => item.id === draft.stage) > index ? <Check size={15} /> : index + 1}</b><span>{stage.label}</span></button>)}</nav>
      <div className={styles.headerActions}>
        <label className={styles.workspaceLabel}><span className={styles.srOnly}>角色工作区</span><select value={workspace?.id || ''} disabled={locked || !bootstrap} onChange={event => void switchWorkspace(event.target.value)}><option value="" disabled>选择角色</option>{bootstrap?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className={styles.iconButton} disabled={locked || !bootstrap} onClick={() => void createWorkspace()} title="新建角色" aria-label="新建角色"><Plus size={18} /></button>
        {isAdmin && <button type="button" disabled={locked || !bootstrap} onClick={showPrompts}><Settings2 size={16} /><span>提示词管理</span></button>}
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
    {!sessionReady ? <div className={styles.welcome}><UserRound size={36} /><p>正在核对当前账号，工作现场已保留。</p></div> : loading && !workspace ? <div className={styles.loading}><div /><div /><div /><span>正在恢复角色工作区…</span></div> : promptView && bootstrap && configDraft ? <section className={styles.promptView}>
      <aside className={styles.promptAside}><button type="button" onClick={closePrompts}><ArrowLeft size={16} />返回工作台</button><h2>提示词版本</h2>{[bootstrap.config, ...bootstrap.configVersions.filter(version => version.revision !== bootstrap.config.revision)].map(version => <div className={styles.promptVersion} key={version.revision}><button type="button" aria-pressed={configVersion === version.revision} onClick={() => { setConfigDraft(fieldsOf(version)); setConfigVersion(version.revision); }}><strong>v{version.revision}{version.revision === bootstrap.config.revision ? ' · 当前' : ''}</strong></button>{version.updatedAt && <RelativeTime value={version.updatedAt} />}</div>)}</aside>
      <div className={styles.promptEditor}><header><h1>生成上下文与提示词</h1><span>管理员 · {configVersion ? `基于v${configVersion}` : '默认规则'}</span></header><p>通用规则用于之后的新生成。每个角色的个人补充在工作台中填写。</p>{promptFields.map(([field, title, placeholder]) => <label className={styles.field} key={field}><span>{title}</span><textarea rows={field === 'resultPrompt' ? 6 : 4} maxLength={3000} value={configDraft[field]} placeholder={placeholder} disabled={Boolean(busy)} onChange={event => setConfigDraft(previous => previous ? { ...previous, [field]: event.target.value } : previous)} /></label>)}<footer><span>历史结果和已受理任务保留原规则。</span><button type="button" disabled={Boolean(busy)} onClick={closePrompts}>取消</button><button type="button" className={styles.primary} disabled={Boolean(busy) || !configDirty} onClick={() => void saveConfig()}><Save size={16} />保存新版本</button></footer></div>
    </section> : !workspace || !draft ? <section className={styles.welcome}><ImagePlus size={44} /><h1>从一张角色原图开始</h1><p>探索不同的真人面孔，再制作完整的角色参考图。</p><button type="button" className={styles.primary} disabled={locked || !bootstrap} onClick={() => void createWorkspace()}><Plus size={17} />新建角色</button>{error && <button type="button" onClick={() => window.location.reload()}>重新读取</button>}</section> : <>
      {historyOpen && <section className={styles.historyPanel} aria-label="角色生成历史"><header><h2>历史记录</h2><button type="button" className={styles.iconButton} onClick={() => setHistoryOpen(false)} aria-label="关闭历史记录"><X size={17} /></button></header>{!plans.length && <p>尚未生成候选或成品。</p>}<div className={styles.historyRows}>{plans.map(plan => <article className={styles.historyItem} key={plan.id}><button type="button" disabled={locked} onClick={() => { updateDraft(plan.kind === 'faces' ? { facePlanId: plan.id, stage: 'selection' } : { resultPlanId: plan.id, stage: 'result' }); setHistoryOpen(false); }}>{tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={plan.kind === 'faces' ? '历史人脸候选' : '历史角色参考图'} /> : <span className={styles.historyPlaceholder}><Grid2X2 size={22} /></span>}<span><strong>{plan.kind === 'faces' ? `${plan.count}宫格候选` : '角色参考图'} · {taskState[tasks[plan.id]?.status || ''] || '尚未提交或待核对'}</strong></span></button><small><RelativeTime value={plan.createdAt} /> · 面部差异 {plan.diversity}%</small></article>)}</div></section>}
      <div className={styles.workbench}>
        <aside className={styles.materialRail}><section className={styles.materialSection}><h2>原始素材</h2>{sourceUrl ? <><button type="button" className={styles.sourceImage} onClick={() => setPreview({ src: sourceUrl, alt: '原始角色素材' })}><ReturnedImage src={sourceUrl} alt="原始角色素材" /></button><div className={styles.fileRow}><span title={sourceLabel}>{sourceLabel}</span></div></> : <button type="button" className={styles.uploadEmpty} disabled={locked} onClick={() => setPickerOpen(true)}><ImagePlus size={32} /><strong>添加原始素材</strong><span>上传或从素材库选择一张图片</span></button>}<button type="button" className={styles.outline} disabled={locked || unresolved} onClick={() => setPickerOpen(true)}><ImagePlus size={15} />{draft.sourceAssetId ? '更换原图' : '选择原图'}</button></section>
          {draft.stage === 'result' && shownMainFace && <section className={styles.materialSection}><div className={styles.sectionTitle}><h2>主面部 · {String(shownMainFace!.cell + 1).padStart(2, '0')}</h2><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}>更换方案<ArrowRight size={13} /></button></div><button type="button" className={styles.faceReference} onClick={() => setPreview({ src: characterLabMediaUrl(shownMainFace!.planId, shownMainFace!.cell), alt: '选定主面部' })}><ReturnedImage src={characterLabMediaUrl(shownMainFace!.planId, shownMainFace!.cell)} alt="选定主面部" /></button></section>}
          {draft.stage !== 'result' && facePlans.length > 0 && <section className={styles.materialSection}><h2>历史候选</h2><div className={styles.batchList}>{facePlans.map((plan, index) => <button type="button" key={plan.id} aria-pressed={facePlan?.id === plan.id} disabled={locked} onClick={() => updateDraft({ facePlanId: plan.id })}>{tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={`第${facePlans.length - index}组人脸候选`} /> : <Grid2X2 size={22} />}<span>第{facePlans.length - index}组<small>{taskState[tasks[plan.id]?.status || ''] || '未提交或待核对'}</small></span></button>)}</div></section>}
        </aside>
        <section className={styles.canvasColumn} aria-label={draft.stage === 'result' ? '角色成品预览' : '人脸候选'}>
          <div className={styles.canvasHeading}><h2>{draft.stage === 'result' ? '角色参考图' : draft.stage === 'selection' ? '选择喜欢的面部方案' : '生成结果'}{draft.stage !== 'result' && shownFacePlan && <span> · {shownFacePlan.count}个候选</span>}</h2><div className={styles.canvasActions}>{displayedOutputTask?.asset && <ImageFeishuStatus key={`${ownerId}:${displayedOutputTask.id}`} owner={ownerId} taskId={displayedOutputTask.id} presentationLabel={sendPresentationLabel} />}<button type="button" className={styles.iconButton} disabled={locked} onClick={() => void run('query', refreshTasks)} aria-label="查询生成状态" title="查询生成状态"><RefreshCw size={16} /></button></div></div>
          {currentPlan && !currentTask && <div className={styles.taskStatus}>此计划尚未提交或提交结果待核对。下方已有结果保留。</div>}
          {currentTask && <div className={styles.taskStatus} role="status">{['queued', 'running'].includes(currentTask.status) && <Loader2 className={styles.spinner} size={15} />}<span>{taskState[currentTask.status] || '状态待确认'}{currentTask.error ? ` · ${currentTask.error}` : ''}</span>{currentTask.resultDisposition && <span>图片已返回，请核对实际规格。</span>}</div>}
          {draft.stage === 'result' ? shownResultPlan && resultTask?.asset ? <><div className={styles.resultArea}><button type="button" className={styles.resultImage} onClick={() => setPreview({ src: characterLabMediaUrl(shownResultPlan.id), alt: '角色四格参考图' })}><ReturnedImage src={characterLabMediaUrl(shownResultPlan.id)} alt="角色四格参考图：正面特写、侧面特写、正面全身、背面全身" /></button></div><div className={styles.canvasTools}><span>成图比例 2:3{resultTask.asset.width && resultTask.asset.height ? ` · 实际 ${resultTask.asset.width}×${resultTask.asset.height}` : ''}</span><button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(shownResultPlan.id), alt: '角色参考图' })}><Maximize2 size={15} />放大</button></div></> : <div className={styles.canvasEmpty}><Grid2X2 size={42} /><h3>{currentTask && ['queued', 'running'].includes(currentTask.status) ? '正在制作角色参考图' : '在这里预览角色参考图'}</h3><p>选定面部后，结合原图生成正面特写、侧面特写和正背全身。</p>{draft.mainFace && <button type="button" className={styles.primary} disabled={locked || unresolved} onClick={() => void generate('result')}>生成角色参考图<ArrowRight size={16} /></button>}</div> : shownFacePlan ? <div className={styles.candidateGrid} style={{ gridTemplateColumns: `repeat(${shownFacePlan.count === 9 ? 3 : 2}, minmax(0, 1fr))` }}>{Array.from({ length: shownFacePlan.count }, (_, cell) => {
            const face = { planId: shownFacePlan.id, cell }, main = sameFace(draft.mainFace, face), auxiliary = draft.auxiliaryFaces.some(item => sameFace(item, face));
            return <article key={cell} className={styles.candidate} data-main={main} data-auxiliary={auxiliary}><button type="button" className={styles.candidateImage} disabled={locked} aria-pressed={main} aria-label={`选择候选${cell + 1}作为主面部`} onClick={() => selectFace(face)}><ReturnedImage src={characterLabMediaUrl(shownFacePlan.id, cell)} alt={`真人面部候选${cell + 1}`} /><span className={styles.cellNumber}>{String(cell + 1).padStart(2, '0')}</span>{main && <span className={styles.mainBadge}><Check size={12} />主面部</span>}{auxiliary && <span className={styles.auxBadge}>辅助参考</span>}</button><div className={styles.cellActions}><button type="button" disabled={locked} onClick={() => setPreview({ src: characterLabMediaUrl(shownFacePlan.id, cell), alt: `候选${cell + 1}` })}><Maximize2 size={13} />放大</button><button type="button" disabled={locked || main} aria-pressed={auxiliary} onClick={() => toggleAuxiliary(face)}>{auxiliary ? '移除辅助' : '作为辅助'}</button></div></article>;
          })}</div> : <div className={styles.canvasEmpty}><UserRound size={46} /><h3>{currentTask && ['queued', 'running'].includes(currentTask.status) ? '正在探索不同的面部方案' : '探索适合角色的真人面孔'}</h3><p>添加一张角色原图，调整面部差异，生成4宫格或9宫格候选。</p>{!draft.sourceAssetId && <button type="button" className={styles.outline} disabled={locked} onClick={() => setPickerOpen(true)}><ImagePlus size={16} />添加原始素材</button>}</div>}
          {draft.stage === 'result' && resultPlans.length > 0 && <div className={styles.versionStrip}><span>历史版本</span>{resultPlans.map((plan, index) => <button type="button" key={plan.id} aria-pressed={shownResultPlan?.id === plan.id} disabled={locked} onClick={() => updateDraft({ resultPlanId: plan.id })}>{tasks[plan.id]?.asset ? <ReturnedImage src={characterLabMediaUrl(plan.id)} alt={`角色参考图v${resultPlans.length - index}`} /> : <Grid2X2 size={18} />}<span>v{resultPlans.length - index}</span></button>)}</div>}
        </section>
        <aside className={styles.controls}>
          {draft.stage === 'result' ? <><section className={styles.resultState}><strong>当前成品 {shownResultPlan ? `v${resultPlans.length - resultPlans.findIndex(item => item.id === shownResultPlan.id)}` : ''}</strong><span>{selectedResult ? '已保存' : resultTask?.asset ? '已生成' : '待生成'}</span></section><section><h2>保存与导出</h2><label className={styles.field}><span>作品名称</span><input value={workName} placeholder={selectedResult?.name || workspace.name} maxLength={80} onChange={event => updateDraft({ resultName: event.target.value })} /></label><div className={styles.field}><span>导出内容</span><div className={styles.segmented}>{([['sheet', '整图'], ['cells', '单张'], ['all', '全部']] as const).map(([mode, label]) => <button type="button" key={mode} aria-pressed={exportMode === mode} onClick={() => setExportMode(mode)}>{label}</button>)}</div></div><div className={styles.exportDetails}><span>文件格式 <b>PNG{exportMode !== 'sheet' ? ' / ZIP' : ''}</b></span><span>图片尺寸 <b>原始尺寸</b></span></div><div className={styles.actionPair}><button type="button" className={styles.primary} disabled={locked || !shownResultPlan || !resultTask?.asset} onClick={() => void saveResult()}><Save size={16} />保存成品</button><button type="button" className={styles.outline} disabled={locked || !shownResultPlan || !resultTask?.asset} onClick={() => void exportResult()}><Download size={16} />导出图片</button></div><p className={styles.hint}>直接保存当前结果，无需重新生成。</p></section><details className={styles.adjustments}><summary><SlidersHorizontal size={16} />调整成品<ChevronDown size={15} /></summary><label className={styles.field}><span>调整要求</span><textarea rows={4} value={draft.adjustment} maxLength={3000} onChange={event => updateDraft({ adjustment: event.target.value })} placeholder="例如：侧面保持平视，露出完整发型" /></label><label className={styles.field}><span>调整位置</span><select value={draft.adjustmentCell ?? 'all'} onChange={event => updateDraft({ adjustmentCell: event.target.value === 'all' ? null : Number(event.target.value) })}><option value="all">全部四格</option>{['正面特写', '侧面特写', '正面全身', '背面全身'].map((label, index) => <option key={index} value={index}>{label}</option>)}</select></label>{renderGenerationSettings()}<button type="button" className={styles.outline} disabled={locked || unresolved || !draft.mainFace || faceSourceMismatch} onClick={() => void generate('result')}><RefreshCw size={15} />生成新版本</button></details><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'selection' })}><ArrowLeft size={15} />返回选择</button></> : <>
            {draft.stage === 'selection' && <section className={styles.selectedSection}><h2>已选 {selectedFaces.length} 个方案</h2>{faceSourceMismatch && <div className={styles.sourceMismatch}><p>这组候选来自另一张原图。</p><button type="button" disabled={locked} onClick={() => updateDraft({ sourceAssetId: shownFacePlan!.sourceAssetId })}>使用本组原图</button></div>}{selectedFaces.length > 0 ? <div className={styles.selectedFaces}>{selectedFaces.map((face, index) => <div key={`${face.planId}:${face.cell}`} data-main={index === 0 && Boolean(draft.mainFace)}><button type="button" onClick={() => setPreview({ src: characterLabMediaUrl(face.planId, face.cell), alt: index === 0 && draft.mainFace ? '主面部' : '辅助参考' })}><ReturnedImage src={characterLabMediaUrl(face.planId, face.cell)} alt={index === 0 && draft.mainFace ? '主面部' : '辅助参考'} /></button><span>{index === 0 && draft.mainFace ? '主面部' : '辅助参考'} {String(face.cell + 1).padStart(2, '0')}</span>{index > 0 && <button type="button" className={styles.removeAux} aria-label={`移除辅助参考${face.cell + 1}`} onClick={() => toggleAuxiliary(face)}><X size={13} /></button>}</div>)}</div> : <p className={styles.hint}>点击候选确定主面部，可另外添加辅助参考。</p>}<label className={styles.field}><span>辅助特征</span><textarea rows={3} maxLength={1000} value={draft.auxiliaryFeatures} onChange={event => updateDraft({ auxiliaryFeatures: event.target.value })} placeholder="例如：参考辅助方案的鼻梁与眼部气质" /></label><p className={styles.hint}>主面部确定身份，辅助参考提供特征方向。</p></section>}
            <section><h2>{draft.stage === 'faces' ? '生成设置' : '探索更多面孔'}</h2>{draft.stage === 'faces' && <div className={styles.segmented}>{([4, 9] as const).map(count => <button type="button" key={count} disabled={locked} aria-pressed={draft.count === count} onClick={() => updateDraft({ count })}><Grid2X2 size={16} />{count}宫格</button>)}</div>}<label className={styles.sliderLabel}><span>面部差异<b>{draft.diversity}%</b></span><input type="range" min="0" max="100" step="1" value={draft.diversity} aria-valuetext={`${draft.diversity}%，${draft.diversity < 34 ? '小幅变化' : draft.diversity < 67 ? '中等变化' : '较大变化'}`} disabled={locked} onChange={event => updateDraft({ diversity: Number(event.target.value) })} /><small><span>小</span><span>大</span></small></label><p className={styles.hint}>改变脸型、骨相与五官比例。调整后用于下一次生成。</p>{draft.stage === 'faces' && <label className={styles.field}><span>角色补充要求</span><textarea rows={4} maxLength={3000} value={draft.context} disabled={locked} onChange={event => updateDraft({ context: event.target.value })} placeholder="例如：黑发、细框眼镜，沉静气质" /></label>}{isAdmin && <button type="button" className={styles.outline} disabled={locked} onClick={showPrompts}><Settings2 size={16} />提示词管理</button>}{renderGenerationSettings()}</section>
            <div className={styles.mainActions}>{draft.stage === 'faces' ? <><button type="button" className={shownFacePlan ? styles.outline : styles.primary} disabled={locked || unresolved || !draft.sourceAssetId} onClick={() => void generate('faces')}><RefreshCw size={15} />{shownFacePlan ? '重新生成' : '生成人脸候选'}</button><button type="button" className={shownFacePlan ? styles.primary : ''} disabled={locked || !shownFacePlan} onClick={() => updateDraft({ stage: 'selection' })}>选择方案<ArrowRight size={16} /></button></> : <><button type="button" className={styles.outline} disabled={locked || unresolved || !draft.sourceAssetId} onClick={() => void generate('faces')}><RefreshCw size={15} />生成另一组</button><button type="button" className={styles.primary} disabled={locked || unresolved || !draft.mainFace || faceSourceMismatch} onClick={() => void generate('result')}>生成角色参考图<ArrowRight size={16} /></button><button type="button" disabled={locked} onClick={() => updateDraft({ stage: 'faces' })}><ArrowLeft size={15} />返回生成</button></>}</div>
          </>}
        </aside>
      </div>
    </>}
    <ResourceLibraryPicker open={pickerOpen} imageOnly target="image-studio" purpose="character-lab-source" contextKey={`${ownerId}:character-lab:${workspace?.id || 'draft'}`} title="选择角色原始素材" confirmLabel="使用这张原图" maxSelection={1} currentCount={0} currentAssetIds={[]} onClose={() => setPickerOpen(false)} onUploadFile={async (file: File, onProgress?: UploadProgressHandler) => { assertActive(); const capturedScope = scope.current; setUploading(true); try { const asset = await uploadFileAsAsset(file, { onProgress, ownerId }); if (capturedScope !== scope.current || !active.current) throw new Error('当前角色或账号已变化，图片没有替换到当前工作区'); return asset; } finally { if (alive.current) setUploading(false); } }} onConfirm={async (ids, assets) => { assertActive(); if (!draftRef.current || !ids[0] || busyRef.current) return false; const asset = assets?.find(item => item.id === ids[0]); setSource({ id: ids[0], url: asset?.originalUrl || `/api/image-studio/assets/${encodeURIComponent(ids[0])}`, thumbnailUrl: asset?.thumbnailUrl || '', fileName: asset?.fileName || '角色原始素材' }); updateDraft({ sourceAssetId: ids[0], facePlanId: null, resultPlanId: null, mainFace: null, auxiliaryFaces: [], stage: 'faces' }); return true; }} />
    {preview && sessionReady && <ZoomableImagePreview src={preview.src} alt={preview.alt} fileName="character-reference.png" imageSharing={false} onClose={() => setPreview(null)} />}
    {productDialog}
  </main>;

  function renderGenerationSettings() {
    if (!draft) return null;
    return <details className={styles.generationSettings} open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>模型与项目<ChevronDown size={14} /></summary><label className={styles.field}><span>模型</span><select disabled={locked} value={draft.model} onChange={event => updateDraft({ model: event.target.value })}>{!modelChoices.includes(draft.model as typeof IMAGE_STUDIO_MODELS[number]) && <option value={draft.model}>{draft.model}</option>}{modelChoices.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model}</option>)}</select></label><label className={styles.field}><span>供应商</span><ImageGenerationChannelSelect channels={channels} model={draft.model} value={draft.channelId} disabled={locked} onChange={channelId => updateDraft({ channelId })} /></label><div className={styles.parameterPair}><label className={styles.field}><span>画质</span><select value={draft.quality} disabled={locked} onChange={event => updateDraft({ quality: event.target.value })}>{!qualityChoices.includes(draft.quality as never) && <option value={draft.quality}>{imageStudioQualityLabel(draft.model, draft.quality)}</option>}{qualityChoices.map(quality => <option key={quality} value={quality}>{imageStudioQualityLabel(draft.model, quality)}</option>)}</select></label><label className={styles.field}><span>分辨率</span><select value={draft.resolution} disabled={locked} onChange={event => updateDraft({ resolution: event.target.value })}>{!resolutionChoices.includes(draft.resolution as never) && <option value={draft.resolution}>{draft.resolution}</option>}{resolutionChoices.map(resolution => <option key={resolution} value={resolution}>{resolution}</option>)}</select></label></div><ImageUsageProjectSelect ownerId={ownerId} value={draft.projectId} disabled={locked} onChange={projectId => updateDraft({ projectId })} /></details>;
  }
}
