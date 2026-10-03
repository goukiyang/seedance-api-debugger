'use client';

import { useProductDialog } from '@/components/useProductDialog';
import ContentReactions from '@/components/content-reactions/ContentReactions';

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type SetStateAction } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Archive, ArrowDown, ArrowUp, Check, CircleAlert, Eye, Film, FolderOpen,
  Image as ImageIcon, ImagePlus, LoaderCircle, Plus, Save, Search, Settings, Sparkles, Trash2, X,
} from 'lucide-react';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { RelativeTime } from '@/components/RelativeTime';
import { normalizeH3VideoConfig, h3DisabledReason, type H3VideoConfig } from '@/components/H3MachineStatus';
import { SEEDANCE_VIDEO_MODEL_OPTIONS } from '@/lib/provider/seedance-models';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
import MediaPreview from '@/components/MediaPreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import { UploadedImagePicker, type UploadedAssetSelection, type UploadedImagePickerConfirmResult } from '@/components/UploadedImagePicker';
import { getStudioVideoDurationMax } from '@/lib/template-studio-video-handoff';
import { uploadFileAsAsset, type UploadProgressHandler } from '@/lib/http/file-upload';
import type {
  CreateStudioDraftRequest,
  CreateStudioRunRequest,
  CreateStudioRunResponse,
  CreateStudioTemplateRequest,
  StudioApiError,
  StudioAssetInput,
  StudioCapabilitiesResponse,
  StudioDraftDto,
  StudioDraftListResponse,
  StudioJsonValue,
  StudioRunDetailResponse,
  StudioRunDto,
  StudioRunListResponse,
  StudioRunStatus,
  StudioTemplateDetailResponse,
  StudioTemplateDto,
  StudioTemplateField,
  StudioTemplateRecipe,
  TemplateListResponse,
  UpdateStudioDraftRequest,
  UpdateStudioTemplateRequest,
} from '@/lib/template-studio/types';
import styles from './template-studio.module.css';
import VideoContextEditor from './VideoContextEditor';
import VideoPromptResult from './VideoPromptResult';
import { isStudioTextModel, studioTextModelLabel, STUDIO_TEXT_MODELS } from '@/lib/template-studio/text-models';

type Props = { userId: string };
type StudioView = 'templates' | 'prompts' | 'results';
type ResultTab = 'prompt' | 'video';
type StatusFilter = '' | StudioRunStatus;
type TemplateFilters = { search: string; group: string };
type RunFilters = { templateId: string; from: string; to: string; status: StatusFilter };
type FeedbackTone = 'progress' | 'info' | 'success' | 'warning' | 'error';
type FeedbackMessage = { message: string; tone: FeedbackTone };
type SaveState = { label: string; tone?: FeedbackTone };
type RunDetail = StudioRunDetailResponse;

const API = '/api/template-studio';
const RUN_STATUSES: Array<{ value: StatusFilter; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '处理中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'uncertain', label: '结果待确认' },
  { value: 'cancelled', label: '已取消' },
];
const GENERATION_MODES = [
  ['all_in_one_reference', '参考素材'],
  ['first_last_frame', '首尾帧'],
  ['smart_multi_frame', '多帧参考'],
] as const;
const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'];

class ApiFailure extends Error {
  status: number;
  code?: StudioApiError['code'];
  userMessage?: string;

  constructor(status: number, code?: StudioApiError['code'], userMessage?: string) {
    super(userMessage || '请求未完成');
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
  }
}

function safeApiMessage(status: number, body: unknown) {
  if (status === 500 || status === 502 || status === 504) return undefined;
  const apiError = body && typeof body === 'object' ? body as StudioApiError : undefined;
  const candidate = apiError?.error?.trim();
  if (!apiError?.code || !candidate || candidate.length > 240) return undefined;
  return status >= 400 && status < 500 || status === 503 ? candidate : undefined;
}

async function requestJson<T>(url: string, init?: RequestInit, expectedStatus?: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw new ApiFailure(0, 'UNAVAILABLE');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const apiError = body && typeof body === 'object' ? body as StudioApiError : undefined;
    throw new ApiFailure(response.status, apiError?.code, safeApiMessage(response.status, body));
  }
  if (body === null) throw new ApiFailure(0, 'UNAVAILABLE', '服务返回不完整，操作结果尚未确认，请先查询记录。');
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new ApiFailure(response.status, 'INVALID', '服务未返回完整的新模块，当前编辑仍保留；请稍后重试。');
  }
  return body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function completeDraftFromResponse(body: unknown): StudioDraftDto | null {
  const candidate = isRecord(body) && 'draft' in body ? body.draft : body;
  if (!isRecord(candidate)) return null;
  const assets = candidate.assets;
  const recipe = candidate.recipe;
  const template = candidate.template;
  const completeAssets = Array.isArray(assets) && assets.every((asset) => isRecord(asset)
    && typeof asset.assetId === 'string' && Boolean(asset.assetId.trim())
    && (asset.role === 'reference' || asset.role === 'first' || asset.role === 'last')
    && (asset.type === 'image' || asset.type === 'video' || asset.type === 'audio')
    && (asset.slotKey === undefined || (typeof asset.slotKey === 'string' && Boolean(asset.slotKey.trim()))));
  const completeRecipe = recipe === null || (isRecord(recipe)
    && typeof recipe.instruction === 'string'
    && Array.isArray(recipe.fields)
    && recipe.fields.every(isRecord)
    && Array.isArray(recipe.assetSlots)
    && recipe.assetSlots.every(isRecord)
    && isRecord(recipe.defaultParameters));
  const completeTemplate = template === null || (isRecord(template)
    && typeof template.templateId === 'string' && Boolean(template.templateId.trim())
    && (template.templateSource === 'legacy' || template.templateSource === 'studio')
    && ((typeof template.versionId === 'string' && Boolean(template.versionId.trim())) || template.versionId === null)
    && (template.versionNumber === null || (typeof template.versionNumber === 'number' && Number.isInteger(template.versionNumber)))
    && typeof template.templateName === 'string' && Boolean(template.templateName.trim()));
  if (typeof candidate.id !== 'string' || !candidate.id.trim()
    || typeof candidate.name !== 'string' || !candidate.name.trim()
    || typeof candidate.groupName !== 'string' || !candidate.groupName.trim()
    || typeof candidate.prompt !== 'string'
    || !isRecord(candidate.values)
    || !completeAssets
    || !isRecord(candidate.parameters)
    || !completeRecipe
    || !completeTemplate
    || (recipe === null) !== (template === null)
    || typeof candidate.revision !== 'number'
    || !Number.isInteger(candidate.revision) || candidate.revision < 1
    || typeof candidate.createdAt !== 'string' || !candidate.createdAt
    || typeof candidate.updatedAt !== 'string' || !candidate.updatedAt) return null;
  return candidate as unknown as StudioDraftDto;
}

function messageForFailure(error: unknown) {
  if (error instanceof ApiFailure && error.status === 405) return '工作台接口配置不一致，当前内容已保留在本机；请稍后重试或联系维护人员。';
  if (!(error instanceof ApiFailure)) return '操作没有完成，请稍后重试。';
  if (error.userMessage) return error.userMessage;
  if (error.status === 401 || error.code === 'UNAUTHENTICATED') return '登录状态已失效，当前内容已暂存在本机；重新登录后可恢复。';
  if (error.status === 403 || error.code === 'FORBIDDEN') return '当前账号没有这项操作的权限。';
  if (error.status === 404 || error.code === 'NOT_FOUND') return '这份记录当前不可用，请返回列表后重新载入。';
  if (error.status === 409 || error.code === 'CONFLICT') return '内容版本有变化，当前编辑仍保留在本机；请先查看冲突处理选项。';
  if (error.status === 0) return '连接中断，当前操作没有得到确认。';
  if (error.status === 429) return '操作过于频繁，请稍后再试。';
  if (error.status >= 500) return '服务暂时无法处理请求，请检查内容后重试。';
  return '操作没有完成。当前内容已保留，可检查后再试。';
}

function statusLabel(status: string) {
  return RUN_STATUSES.find((item) => item.value === status)?.label || '状态待识别';
}

function statusClass(status: string) {
  if (status === 'succeeded') return styles.statusSuccess;
  if (status === 'failed' || status === 'cancelled') return styles.statusError;
  if (status === 'uncertain') return styles.statusWarning;
  if (status === 'queued' || status === 'running') return styles.statusActive;
  return '';
}

function videoTaskStage(task: RunDetail['tasks'][number]) {
  if (task.status === 'failed') return { key: 'failed', label: '生成失败' };
  if (task.status === 'cancelled') return { key: 'cancelled', label: '已取消' };
  if (task.status === 'queued' || task.status === 'submitted') return { key: 'queued', label: '排队中' };
  if (task.status === 'running') return { key: 'running', label: '生成中' };
  if (task.status !== 'succeeded') return { key: 'unknown', label: '视频状态待确认' };
  const delivery = videoDeliveryStageForTask({ local_status: task.status, delivery_status: task.deliveryStatus, result_video_url: task.playUrl });
  if (delivery.key === 'ready') return { key: 'ready', label: '视频文件已就绪' };
  if (delivery.key === 'failed') return { key: 'stopped', label: '视频已生成，文件准备失败' };
  if (delivery.key === 'preparing') return { key: 'preparing', label: '视频已生成，文件准备中' };
  return { key: 'unknown', label: '视频已生成，文件状态待确认' };
}

function videoSummary(run: StudioRunDto, detail?: RunDetail | null) {
  if (!detail || detail.run.id !== run.id || detail.run.taskCount !== run.taskCount) {
    return run.taskCount === 0 ? '尚未生成视频' : '视频状态待确认，请打开记录查询';
  }
  if (!detail.tasks.length) return '尚未生成视频';
  const labels: Record<string, string> = { ready: '文件就绪', preparing: '文件准备中', stopped: '文件准备失败', queued: '排队中', running: '生成中', failed: '生成失败', cancelled: '已取消', unknown: '状态待确认' };
  const counts = new Map<string, number>();
  for (const task of detail.tasks) {
    const key = videoTaskStage(task).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts).map(([key, count]) => `${count}个${labels[key]}`).join('，');
}

function requestKey(userId: string, draftId: string) {
  return `sd2-template-studio-recovery:${encodeURIComponent(userId)}:${encodeURIComponent(draftId || 'new')}`;
}

function saveRecovery(userId: string, draft: StudioDraftDto | null) {
  if (!draft || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(requestKey(userId, draft.id), JSON.stringify({ savedAt: new Date().toISOString(), draft }));
  } catch { /* Keep the visible draft available even when local storage is full. */ }
}

function clearRecovery(userId: string, draftId: string) {
  try { window.localStorage.removeItem(requestKey(userId, draftId)); } catch { /* Recovery is best-effort. */ }
}

function readRecovery(userId: string, draftId: string): StudioDraftDto | null {
  try {
    const raw = window.localStorage.getItem(requestKey(userId, draftId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { draft?: StudioDraftDto };
    return parsed.draft?.id === draftId ? parsed.draft : null;
  } catch { return null; }
}

function templateRecoveryKey(userId: string, templateId: string) {
  return `sd2-template-studio-template-recovery:${encodeURIComponent(userId)}:${encodeURIComponent(templateId)}`;
}

function saveTemplateRecovery(userId: string, template: StudioTemplateDto) {
  try { window.localStorage.setItem(templateRecoveryKey(userId, template.id), JSON.stringify(template)); } catch { /* Keep the editor state available in memory. */ }
}

function clearTemplateRecovery(userId: string, templateId: string) {
  try { window.localStorage.removeItem(templateRecoveryKey(userId, templateId)); } catch { /* Recovery is best-effort. */ }
}

function templateEditSignature(template: StudioTemplateDto) {
  return JSON.stringify({ name: template.name, description: template.description, groupName: template.groupName, recipe: template.recipe });
}

function readTemplateRecovery(userId: string, templateId: string): StudioTemplateDto | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(templateRecoveryKey(userId, templateId)) || 'null') as StudioTemplateDto | null;
    return parsed?.id === templateId ? parsed : null;
  } catch { return null; }
}

function routeWith(searchParams: URLSearchParams, patch: Record<string, string | null>) {
  const next = new URLSearchParams(searchParams);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  }
  return `/template-studio?${next.toString()}`;
}

function statusFilter(value: string | null): StatusFilter {
  return RUN_STATUSES.some((item) => item.value === value) ? value as StatusFilter : '';
}

function fieldValue(values: Record<string, StudioJsonValue>, field: StudioTemplateField): StudioJsonValue {
  return values[field.key] ?? field.defaultValue ?? '';
}

function composeDraftPrompt(draft: StudioDraftDto) {
  return [
    ...(draft.recipe?.fields || []).flatMap((field) => draft.values[field.key] === undefined
      ? []
      : [`${field.label}: ${String(draft.values[field.key])}`]),
    draft.prompt.trim(),
  ].filter((part): part is string => typeof part === 'string' && Boolean(part.trim())).join('\n\n');
}

function stringValue(value: StudioJsonValue) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function fieldError(field: StudioTemplateField, value: StudioJsonValue) {
  const empty = value == null || value === '';
  if ('required' in field && field.required && empty) return '请填写此项';
  if (field.type === 'text' || field.type === 'textarea') {
    if (field.maxLength && typeof value === 'string' && value.length > field.maxLength) return `最多 ${field.maxLength} 个字符`;
  }
  if (field.type === 'number' && typeof value === 'number') {
    if (field.min != null && value < field.min) return `不能小于 ${field.min}`;
    if (field.max != null && value > field.max) return `不能大于 ${field.max}`;
  }
  return '';
}

function missingAssetSlots(recipe: StudioTemplateRecipe | null, assets: StudioAssetInput[]) {
  return (recipe?.assetSlots || []).filter((slot) => {
    const matching = assets.filter((asset) => assetSlotKey(asset) === slot.key && asset.role === slot.role && slot.types.includes(asset.type));
    return Boolean(slot.required && matching.length === 0) || (slot.maxItems != null && matching.length > slot.maxItems);
  });
}

function assetSlotKey(asset: StudioAssetInput) {
  const slotKey = 'slotKey' in asset ? asset.slotKey : undefined;
  return typeof slotKey === 'string' ? slotKey : '';
}

function runQuery(filters: RunFilters, cursor?: string | null) {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (filters.status) query.set('status', filters.status);
  if (filters.templateId) query.set('template_id', filters.templateId);
  if (filters.from) query.set('created_after', filters.from);
  if (filters.to) query.set('created_before', filters.to);
  return query.toString();
}

export default function VideoTemplateWorkbench({ userId }: Props) {
  const { confirm, productDialog } = useProductDialog();
  const router = useRouter();
  const searchParams = useSearchParams();
  useRememberedScroll(`video-studio:${userId}:${searchParams.toString()}`);
  const viewValue = searchParams.get('view') || '';
  const view: StudioView = viewValue === 'prompts' ? 'prompts' : viewValue === 'results' || viewValue === 'run' ? 'results' : 'templates';
  const routedDraftId = searchParams.get('draftId') || searchParams.get('moduleId') || '';
  const routedRunId = searchParams.get('runId') || '';
  const routedTemplateId = searchParams.get('templateId') || '';
  const templateSourceValue = searchParams.get('templateSource') || '';
  const [templateFilters, setTemplateFilters] = useState<TemplateFilters>({ search: '', group: '' });
  const [appliedTemplateFilters, setAppliedTemplateFilters] = useState<TemplateFilters>({ search: '', group: '' });
  const [templates, setTemplates] = useState<StudioTemplateDto[]>([]);
  const [templateCursor, setTemplateCursor] = useState<string | null>(null);
  const templateCursorRef = useRef<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [drafts, setDrafts] = useState<StudioDraftDto[]>([]);
  const [draftCursor, setDraftCursor] = useState<string | null>(null);
  const draftCursorRef = useRef<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draft, setDraft] = useState<StudioDraftDto | null>(null);
  const draftRef = useRef<StudioDraftDto | null>(null);
  const savedSignature = useRef('');
  const blockedSaveSignature = useRef('');
  const savingDraftIds = useRef(new Set<string>());
  const [saveState, setSaveState] = useState<SaveState>({ label: '草稿未打开' });
  const [conflict, setConflict] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [runs, setRuns] = useState<StudioRunDto[]>([]);
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const runCursorRef = useRef<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState('');
  const [runFilters, setRunFilters] = useState<RunFilters>({
    templateId: '', from: '', to: '', status: statusFilter(searchParams.get('status')),
  });
  const [appliedRunFilters, setAppliedRunFilters] = useState<RunFilters>({
    templateId: '', from: '', to: '', status: statusFilter(searchParams.get('status')),
  });
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [capabilities, setCapabilities] = useState<StudioCapabilitiesResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [videoConfig, setVideoConfig] = useState<H3VideoConfig | null>(null);
  const [videoCatalogError, setVideoCatalogError] = useState('');
  const [videoCatalogBusy, setVideoCatalogBusy] = useState(false);
  const [videoCatalogRevision, setVideoCatalogRevision] = useState(0);
  const videoCatalogScope = useRef(userId);
  const draftCreationLock = useRef(false);
  const [copyingRunId, setCopyingRunId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [contextEditor, setContextEditor] = useState<{ draftId?: string } | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>('prompt');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSlotKey, setPickerSlotKey] = useState<string | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);
  const [templateDetail, setTemplateDetail] = useState<StudioTemplateDetailResponse | null>(null);
  const [templateDetailBusy, setTemplateDetailBusy] = useState(false);
  const [templateEdit, setTemplateEdit] = useState<StudioTemplateDto | null>(null);
  const templateEditBaseline = useRef<string | null>(null);
  const templateEditBackdropRef = useRef<HTMLDivElement>(null);
  const templateEditDialogRef = useRef<HTMLElement>(null);
  const [templateConflict, setTemplateConflict] = useState<{ id: string; source: StudioTemplateDto['source'] } | null>(null);
  const [templateRecoveryAvailable, setTemplateRecoveryAvailable] = useState(false);
  const [templateEditBusy, setTemplateEditBusy] = useState(false);
  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const createTemplateBackdropRef = useRef<HTMLDivElement>(null);
  const createTemplateDialogRef = useRef<HTMLElement>(null);
  const createTemplateDraftRef = useRef<string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateGroup, setNewTemplateGroup] = useState('');
  const [newTemplateInstruction, setNewTemplateInstruction] = useState('');
  const [createTemplateBusy, setCreateTemplateBusy] = useState(false);
  const [pendingRun, setPendingRun] = useState<{ requestId: string; draftId: string; revision: number; mode: 'direct' | 'llm'; llmModel?: string; inputSignature: string } | null>(null);
  const [requestUnknown, setRequestUnknown] = useState(false);
  const modelScope = `sd2-video-text-model:${userId}:${routedDraftId || 'new'}`;
  const [modelChoice, setModelChoice] = useState<{ scope: string; value: string } | null>(null);
  const [modelRecovery, setModelRecovery] = useState<{ scope: string; value: string } | null>(null);
  const defaultLlmModel = capabilities?.defaultLlmModel || 'gpt-5.5';
  const llmModel = requestUnknown && pendingRun?.draftId === routedDraftId && pendingRun.llmModel
    ? pendingRun.llmModel
    : modelChoice?.scope === modelScope ? modelChoice.value : defaultLlmModel;
  useEffect(() => {
    try {
      const value = localStorage.getItem(modelScope);
      setModelRecovery(isStudioTextModel(value) ? { scope: modelScope, value } : null);
    } catch { setModelRecovery(null); }
  }, [modelScope]);
  function chooseLlmModel(value: string) {
    if (!isStudioTextModel(value)) return;
    setModelChoice({ scope: modelScope, value });
    setModelRecovery(null);
    try { localStorage.setItem(modelScope, value); }
    catch { setNotice('本机无法保留模型选择，本次生成仍可使用。'); }
  }
  const submitting = useRef(false);
  const pendingKey = `sd2-video-pending:${userId}`;
  useEffect(() => {
    try {
      const operation = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (operation?.requestId && operation?.draftId && Number.isInteger(operation.revision)) {
        setPendingRun(operation); setRequestUnknown(true);
      }
    } catch { /* No pending request to restore. */ }
  }, [pendingKey]);
  const templateSequence = useRef(0);
  const draftListSequence = useRef(0);
  const draftDetailSequence = useRef(0);
  const draftEditSequence = useRef<{ key: string; sequence: number }>({ key: '', sequence: 0 });
  const runSequence = useRef(0);
  const detailSequence = useRef(0);
  const templateDetailSequence = useRef(0);
  const currentUserId = useRef(userId);
  currentUserId.current = userId;
  const currentDraftId = useRef(routedDraftId);
  currentDraftId.current = routedDraftId;
  const routedTemplateSource = templateSourceValue === 'legacy' || templateSourceValue === 'studio'
    ? templateSourceValue
    : templates.find((item) => item.id === routedTemplateId)?.source || 'studio';
  const activeTemplate = useMemo(() => templates.find((item) => item.id === routedTemplateId && item.source === routedTemplateSource) || null, [routedTemplateId, routedTemplateSource, templates]);
  const activeDraft = draft?.id === routedDraftId ? draft : null;
  const videoProvider = stringValue(activeDraft?.parameters.provider ?? '');
  const savedVideoModel = stringValue(activeDraft?.parameters.model ?? '');
  const savedLora = stringValue(activeDraft?.parameters.h3LoraId ?? '');
  const videoModelOptions = videoProvider === 'seedance' ? SEEDANCE_VIDEO_MODEL_OPTIONS
    : videoProvider === 'h3' && videoConfig?.ready ? [{ id: 'h3', label: 'H3 本地模型' }] : [];
  const loraOptions = videoProvider === 'h3' && videoConfig?.ready ? videoConfig.lora_options : [];
  useDialogDismiss({
    open: Boolean(templateEdit),
    dialogRef: templateEditDialogRef,
    dismissSurfaceRef: templateEditBackdropRef,
    onDismiss: closeTemplateEditor,
    dismissOnOutside: !templateEditBusy,
    dismissOnEscape: !templateEditBusy,
  });
  useDialogDismiss({
    open: createTemplateOpen && Boolean(activeDraft),
    dialogRef: createTemplateDialogRef,
    dismissSurfaceRef: createTemplateBackdropRef,
    onDismiss: () => setCreateTemplateOpen(false),
    dismissOnOutside: !createTemplateBusy,
    dismissOnEscape: !createTemplateBusy,
  });
  const activeRunDetail = runDetail?.run.id === routedRunId ? runDetail : null;
  const moduleRun = activeDraft && activeRunDetail && activeRunDetail.run.draftId === activeDraft.id ? activeRunDetail.run
    : runs.find(item => item.draftId === activeDraft?.id && (!routedRunId || item.id === routedRunId));
  const currentRouteKey = `${view}:${routedDraftId || ''}:${routedTemplateId || ''}:${routedRunId || ''}`;
  const currentRouteKeyRef = useRef(currentRouteKey);
  currentRouteKeyRef.current = currentRouteKey;
  const promptRuns = useMemo(() => {
    if (view === 'results') return runs;
    return runs.filter((run) => run.status === 'failed' || run.status === 'uncertain' || !run.mode || run.mode === 'llm' || Boolean(run.prompt));
  }, [runs, view]);
  const uniqueTemplates = useMemo(() => {
    const seen = new Set<string>();
    return drafts.flatMap((item) => {
      const template = item.template;
      const key = template ? `${template.templateSource}:${template.templateId}` : '';
      if (!template || seen.has(key)) return [];
      seen.add(key);
      return [{ id: template.templateId, source: template.templateSource, key, name: template.templateName }];
    });
  }, [drafts]);

  const setCurrentDraft = useCallback((value: SetStateAction<StudioDraftDto | null>) => {
    if (typeof value === 'function') {
      const next = value(draftRef.current);
      draftRef.current = next;
      setDraft(next);
      return;
    }
    draftRef.current = value;
    setDraft(value);
  }, []);

  const navigate = useCallback((patch: Record<string, string | null>, replace = false) => {
    const href = routeWith(new URLSearchParams(searchParams.toString()), patch);
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [router, searchParams]);

  const setView = (nextView: StudioView) => {
    const patch: Record<string, string | null> = { type: 'video', view: nextView, runId: null };
    if (nextView !== 'templates') {
      patch.templateId = null;
      patch.templateSource = null;
    }
    navigate(patch);
  };

  const handleAuthExpired = useCallback((error: unknown) => {
    if (!(error instanceof ApiFailure) || error.status !== 401) return;
    setAuthExpired(true);
    const latest = draftRef.current;
    saveRecovery(userId, latest);
    setRecoveryAvailable(Boolean(latest));
  }, [userId]);

  useEffect(() => {
    currentUserId.current = userId;
    return () => {
      const latest = draftRef.current;
      if (currentUserId.current === userId && latest && JSON.stringify(latest) !== savedSignature.current) saveRecovery(userId, latest);
    };
  }, [userId]);

  useEffect(() => () => {
    const latest = draftRef.current;
    if (latest && currentUserId.current === userId && JSON.stringify(latest) !== savedSignature.current) saveRecovery(userId, latest);
  }, [currentRouteKey, userId]);

  useEffect(() => {
    let cancelled = false;
    void requestJson<StudioCapabilitiesResponse>(`${API}/capabilities`).then((value) => {
      if (!cancelled && currentUserId.current === userId) setCapabilities(value);
    }).catch((error) => {
      if (!cancelled && currentUserId.current === userId) {
        handleAuthExpired(error);
        setCapabilityError(messageForFailure(error));
      }
    });
    return () => { cancelled = true; };
  }, [handleAuthExpired, userId]);

  useEffect(() => {
    const controller = new AbortController();
    if (videoCatalogScope.current !== userId) {
      videoCatalogScope.current = userId;
      setVideoConfig(null);
    }
    setVideoCatalogBusy(true);
    setVideoCatalogError('');
    void requestJson<{ h3_video?: unknown }>('/api/config', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || currentUserId.current !== userId) return;
      if (!isRecord(value.h3_video) || !Array.isArray(value.h3_video.lora_options) || !Array.isArray(value.h3_video.preset_options)) throw new Error('模型目录返回不完整');
      const config = normalizeH3VideoConfig(value.h3_video);
      if (!config) throw new Error('模型目录返回不完整');
      setVideoConfig(config);
    }).catch(() => {
      if (!controller.signal.aborted && currentUserId.current === userId) setVideoCatalogError('视频选项目录读取失败，已有选择仍保留。');
    }).finally(() => { if (!controller.signal.aborted) setVideoCatalogBusy(false); });
    return () => controller.abort();
  }, [userId, videoCatalogRevision]);

  const loadTemplates = useCallback(async (append = false) => {
    const sequence = ++templateSequence.current;
    const cursor = append ? templateCursorRef.current : null;
    if (append && !cursor) return;
    setTemplateBusy(true);
    setTemplateError('');
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    if (appliedTemplateFilters.search.trim()) query.set('search', appliedTemplateFilters.search.trim());
    if (appliedTemplateFilters.group) query.set('group', appliedTemplateFilters.group);
    try {
      const queryString = query.toString();
      const page = await requestJson<TemplateListResponse>(`${API}/templates${queryString ? `?${queryString}` : ''}`);
      if (sequence !== templateSequence.current || currentUserId.current !== userId) return;
      setTemplates((current) => {
        const next = append ? [...current, ...page.items] : page.items;
        const seen = new Set<string>();
        return next.filter((item) => {
          const key = `${item.source}:${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
      templateCursorRef.current = page.nextCursor;
      setTemplateCursor(page.nextCursor);
    } catch (error) {
      if (sequence === templateSequence.current && currentUserId.current === userId) {
        handleAuthExpired(error);
        setTemplateError(messageForFailure(error));
      }
    } finally {
      if (sequence === templateSequence.current) setTemplateBusy(false);
    }
  }, [appliedTemplateFilters, handleAuthExpired, userId]);

  useEffect(() => {
    setTemplates([]);
    templateCursorRef.current = null;
    setTemplateCursor(null);
    void loadTemplates();
  }, [appliedTemplateFilters, loadTemplates]);

  const loadDrafts = useCallback(async (append = false) => {
    const cursor = append ? draftCursorRef.current : null;
    if (append && !cursor) return;
    const sequence = ++draftListSequence.current;
    setDraftBusy(true);
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    try {
      const queryString = query.toString();
      const page = await requestJson<StudioDraftListResponse>(`${API}/drafts${queryString ? `?${queryString}` : ''}`);
      if (sequence !== draftListSequence.current || currentUserId.current !== userId) return;
      setDrafts((current) => {
        const next = append ? [...current, ...page.items] : page.items;
        const seen = new Set<string>();
        return next.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      });
      draftCursorRef.current = page.nextCursor;
      setDraftCursor(page.nextCursor);
    } catch (error) {
      if (sequence === draftListSequence.current && currentUserId.current === userId) {
        handleAuthExpired(error);
        setNotice(messageForFailure(error));
      }
    } finally {
      if (sequence === draftListSequence.current) setDraftBusy(false);
    }
  }, [handleAuthExpired, userId]);

  useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  const loadRuns = useCallback(async (append = false) => {
    const cursor = append ? runCursorRef.current : null;
    if (append && !cursor) return;
    const sequence = ++runSequence.current;
    setRunBusy(true);
    setRunError('');
    try {
      const query = runQuery(appliedRunFilters, cursor);
      const page = await requestJson<StudioRunListResponse>(`${API}/runs${query ? `?${query}` : ''}`);
      if (sequence !== runSequence.current || currentUserId.current !== userId) return;
      setRuns((current) => {
        const moduleRecords = currentRouteKeyRef.current.startsWith('templates:') ? current.filter(item => item.draftId === currentDraftId.current) : [];
        const next = append ? [...current, ...page.items] : [...page.items, ...moduleRecords];
        const seen = new Set<string>();
        return next.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      });
      runCursorRef.current = page.nextCursor;
      setRunCursor(page.nextCursor);
    } catch (error) {
      if (sequence === runSequence.current && currentUserId.current === userId) {
        handleAuthExpired(error);
        setRunError(messageForFailure(error));
      }
    } finally {
      if (sequence === runSequence.current) setRunBusy(false);
    }
  }, [appliedRunFilters, handleAuthExpired, userId]);

  useEffect(() => {
    setRuns([]);
    runCursorRef.current = null;
    setRunCursor(null);
    void loadRuns();
  }, [loadRuns, view]);

  useEffect(() => {
    if (!routedDraftId) return;
    const controller = new AbortController();
    void requestJson<StudioRunListResponse>(`${API}/runs?draft_id=${encodeURIComponent(routedDraftId)}`, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted && currentUserId.current === userId) setRuns(current => [...page.items, ...current.filter(item => !page.items.some(incoming => incoming.id === item.id))]);
    }).catch(error => { if (!controller.signal.aborted) setRunError(messageForFailure(error)); });
    return () => controller.abort();
  }, [routedDraftId, userId]);

  const pollingRun = moduleRun || activeRunDetail?.run;
  useEffect(() => {
    if (!pollingRun || !['queued', 'running'].includes(pollingRun.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await requestJson<RunDetail>(`${API}/runs/${encodeURIComponent(pollingRun.id)}`);
        if (cancelled) return;
        setRuns(current => current.map(item => item.id === value.run.id ? value.run : item));
        setRunDetail(current => current?.run.id === value.run.id ? value : current);
        if (['queued', 'running'].includes(value.run.status)) timer = setTimeout(poll, 3000);
      } catch {
        if (!cancelled) { setNotice('状态读取暂时失败，正在继续查询；请勿重复提交。'); timer = setTimeout(poll, 6000); }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pollingRun?.id, pollingRun?.status]);

  useEffect(() => {
    if (!routedDraftId) {
      setCurrentDraft(null);
      setConflict(false);
      setSaveState({ label: '草稿未打开' });
      setRecoveryAvailable(false);
      return;
    }
    const controller = new AbortController();
    const sequence = ++draftDetailSequence.current;
    const draftKey = `${userId}:${routedDraftId}`;
    const draftAtRequestStart = draftRef.current?.id === routedDraftId ? draftRef.current : null;
    const draftSnapshotAtRequestStart = draftAtRequestStart ? JSON.stringify(draftAtRequestStart) : null;
    const dirtyAtRequestStart = Boolean(draftAtRequestStart && draftSnapshotAtRequestStart !== savedSignature.current);
    const editSequenceAtRequestStart = draftEditSequence.current.key === draftKey ? draftEditSequence.current.sequence : 0;
    if (!dirtyAtRequestStart) setSaveState({ label: '正在打开草稿' });
    void requestJson<StudioDraftDto | { draft: StudioDraftDto }>(`${API}/drafts/${encodeURIComponent(routedDraftId)}`, { signal: controller.signal }).then((body) => {
      const loaded = 'draft' in body ? body.draft : body;
      if (sequence !== draftDetailSequence.current || currentUserId.current !== userId || currentDraftId.current !== loaded.id) return;
      const currentDraft = draftRef.current;
      if (currentDraft?.id === loaded.id) {
        const currentEditSequence = draftEditSequence.current.key === draftKey ? draftEditSequence.current.sequence : 0;
        const changedDuringLoad = !draftAtRequestStart
          || dirtyAtRequestStart
          || currentEditSequence !== editSequenceAtRequestStart
          || JSON.stringify(currentDraft) !== draftSnapshotAtRequestStart;
        if (changedDuringLoad) return;
      }
      const local = readRecovery(userId, loaded.id);
      if (!local && loaded.prompt.trim()) saveRecovery(userId, loaded);
      const defaults = draftAtRequestStart ? loaded : { ...loaded, prompt: '', values: Object.fromEntries((loaded.recipe?.fields || []).flatMap(field => field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]])) };
      setCurrentDraft(defaults);
      savedSignature.current = JSON.stringify(defaults);
      blockedSaveSignature.current = '';
      setConflict(false);
      setSaveState({ label: '已载入默认输入', tone: 'success' });
      setRecoveryAvailable(Boolean(readRecovery(userId, loaded.id)));
      setAuthExpired(false);
    }).catch((error) => {
      if (!controller.signal.aborted && sequence === draftDetailSequence.current && currentUserId.current === userId) {
        handleAuthExpired(error);
        setSaveState({ label: messageForFailure(error), tone: 'error' });
      }
    });
    return () => controller.abort();
  }, [handleAuthExpired, routedDraftId, setCurrentDraft, userId]);

  useEffect(() => {
    if (!routedRunId) {
      setRunDetail(null);
      setDetailError('');
      return;
    }
    const controller = new AbortController();
    const sequence = ++detailSequence.current;
    setDetailBusy(true);
    setDetailError('');
    void requestJson<RunDetail>(`${API}/runs/${encodeURIComponent(routedRunId)}`, { signal: controller.signal }).then((value) => {
      if (sequence !== detailSequence.current || currentUserId.current !== userId) return;
      setRunDetail(value);
    }).catch((error) => {
      if (!controller.signal.aborted && sequence === detailSequence.current && currentUserId.current === userId) {
        handleAuthExpired(error);
        setDetailError(messageForFailure(error));
      }
    }).finally(() => {
      if (sequence === detailSequence.current) setDetailBusy(false);
    });
    return () => controller.abort();
  }, [handleAuthExpired, routedRunId, userId]);

  useEffect(() => {
    setTemplateRecoveryAvailable(Boolean(routedTemplateId && readTemplateRecovery(userId, routedTemplateId)));
  }, [routedTemplateId, userId]);

  useEffect(() => {
    if (!routedTemplateId || !activeTemplate?.canManage) {
      setTemplateDetail(null);
      return;
    }
    const controller = new AbortController();
    const sequence = ++templateDetailSequence.current;
    setTemplateDetailBusy(true);
    setTemplateDetail(null);
    const query = new URLSearchParams({ source: routedTemplateSource });
    void requestJson<StudioTemplateDetailResponse>(`${API}/templates/${encodeURIComponent(routedTemplateId)}?${query}`, { signal: controller.signal }).then((value) => {
      if (sequence === templateDetailSequence.current && currentUserId.current === userId) setTemplateDetail(value);
    }).catch((error) => {
      if (sequence === templateDetailSequence.current && currentUserId.current === userId) {
        setTemplateDetail(null);
        handleAuthExpired(error);
        setNotice(messageForFailure(error));
      }
    }).finally(() => {
      if (sequence === templateDetailSequence.current) setTemplateDetailBusy(false);
    });
    return () => controller.abort();
  }, [activeTemplate?.canManage, handleAuthExpired, routedTemplateId, routedTemplateSource, userId]);

  const saveDraft = useCallback(async (candidate: StudioDraftDto, manual = false) => {
    if (savingDraftIds.current.has(candidate.id) || currentUserId.current !== userId || currentDraftId.current !== candidate.id) return false;
    if (blockedSaveSignature.current === `${candidate.id}:${candidate.revision}`) return false;
    savingDraftIds.current.add(candidate.id);
    if (currentDraftId.current === candidate.id) setSaveState({ label: '正在保存', tone: 'progress' });
    const payload: UpdateStudioDraftRequest = {
      name: candidate.name,
      groupName: candidate.groupName,
      prompt: candidate.prompt,
      values: candidate.values,
      assets: candidate.assets,
      parameters: candidate.parameters,
      revision: candidate.revision,
    };
    try {
      const body = await requestJson<StudioDraftDto | { draft: StudioDraftDto }>(`${API}/drafts/${encodeURIComponent(candidate.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = 'draft' in body ? body.draft : body;
      if (currentUserId.current !== userId) return false;
      setCurrentDraft((current) => current?.id === saved.id ? { ...current, revision: saved.revision, updatedAt: saved.updatedAt, recipe: saved.recipe, template: saved.template } : current);
      savedSignature.current = JSON.stringify({ ...candidate, revision: saved.revision, updatedAt: saved.updatedAt });
      blockedSaveSignature.current = '';
      const latest = draftRef.current;
      const changedWhileSaving = latest?.id === saved.id && JSON.stringify(latest) !== JSON.stringify({ ...candidate, revision: saved.revision, updatedAt: saved.updatedAt });
      if (changedWhileSaving && latest) saveRecovery(userId, { ...latest, revision: saved.revision, updatedAt: saved.updatedAt });
      else saveRecovery(userId, saved);
      if (currentDraftId.current === saved.id) {
        setConflict(false);
        setRecoveryAvailable(changedWhileSaving);
        setAuthExpired(false);
        setSaveState(changedWhileSaving ? { label: '有新改动，继续保存', tone: 'info' } : { label: manual ? '已保存' : '自动保存完成', tone: 'success' });
      }
      setDrafts((current) => current.map((item) => item.id === saved.id ? { ...item, name: saved.name, groupName: saved.groupName, revision: saved.revision, updatedAt: saved.updatedAt } : item));
      return !changedWhileSaving;
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 409) {
        blockedSaveSignature.current = `${candidate.id}:${candidate.revision}`;
        const latest = draftRef.current?.id === candidate.id ? draftRef.current : candidate;
        saveRecovery(userId, latest);
        if (currentDraftId.current === candidate.id) {
          setRecoveryAvailable(true);
          setConflict(true);
        }
      }
      if (error instanceof ApiFailure && error.status === 401) {
        saveRecovery(userId, draftRef.current?.id === candidate.id ? draftRef.current : candidate);
        if (currentDraftId.current === candidate.id) setAuthExpired(true);
      }
      if (error instanceof ApiFailure && error.status === 405) {
        saveRecovery(userId, draftRef.current?.id === candidate.id ? draftRef.current : candidate);
        if (currentDraftId.current === candidate.id) setRecoveryAvailable(true);
      }
      if (currentDraftId.current === candidate.id) {
        setSaveState({ label: messageForFailure(error), tone: error instanceof ApiFailure && error.status === 409 ? 'warning' : 'error' });
      }
      return false;
    } finally {
      savingDraftIds.current.delete(candidate.id);
    }
  }, [setCurrentDraft, userId]);

  useEffect(() => {
    if (!activeDraft) return;
    const signature = JSON.stringify(activeDraft);
    if (signature === savedSignature.current || blockedSaveSignature.current === `${activeDraft.id}:${activeDraft.revision}`) return;
    const timer = window.setTimeout(() => { void saveDraft(activeDraft); }, 750);
    return () => window.clearTimeout(timer);
  }, [activeDraft, saveDraft]);

  function updateDraft(transform: (current: StudioDraftDto) => StudioDraftDto) {
    const draftAtEdit = draftRef.current;
    if (!draftAtEdit) return;
    markDraftEdited(draftAtEdit.id);
    setCurrentDraft((current) => {
      if (!current) return current;
      return transform(current);
    });
    saveRecovery(userId, draftRef.current);
    setSaveState({ label: '有未保存改动' });
  }

  function markDraftEdited(draftId: string) {
    const key = `${userId}:${draftId}`;
    const current = draftEditSequence.current;
    draftEditSequence.current = {
      key,
      sequence: current.key === key ? current.sequence + 1 : 1,
    };
  }

  async function createDraft(input: CreateStudioDraftRequest = {}) {
    if (draftCreationLock.current) return null;
    draftCreationLock.current = true;
    const startRoute = currentRouteKeyRef.current;
    setWorking(true);
    setNotice('');
    try {
      const body = await requestJson<unknown>(`${API}/drafts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }, 201);
      if (currentUserId.current !== userId) return null;
      const created = completeDraftFromResponse(body);
      if (!created) {
        setNotice('服务未返回完整的新模块，当前编辑仍保留；请稍后重试。');
        return null;
      }
      if (currentRouteKeyRef.current !== startRoute) {
        void loadDrafts();
        setNotice('新模块已保存；你切换的页面保持不变，可从“我的模块”打开它。');
        return null;
      }
      setCurrentDraft(created);
      savedSignature.current = JSON.stringify(created);
      blockedSaveSignature.current = '';
      setConflict(false);
      setSaveState({ label: '已保存', tone: 'success' });
      setDrafts((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      navigate({
        type: 'video', view: 'templates', draftId: created.id, moduleId: created.id,
        runId: null, templateId: null, templateSource: null,
      }, true);
      setResultTab('prompt');
      return created;
    } catch (error) {
      if (currentUserId.current !== userId) return null;
      handleAuthExpired(error);
      setNotice(messageForFailure(error));
      return null;
    } finally { draftCreationLock.current = false; setWorking(false); }
  }

  async function createBlankDraft() {
    await createDraft({ name: '未命名模块', groupName: '未分组' });
  }

  async function applyTemplate(template: StudioTemplateDto) {
    if (template.applyMode === 'legacy-route') {
      if (!template.applyUrl) {
        setNotice('这份旧版模板暂时没有可用的原生成入口。');
        return;
      }
      try {
        const target = new URL(template.applyUrl, window.location.origin);
        if (target.origin !== window.location.origin || target.pathname !== '/template-generate' || target.searchParams.get('templateId') !== template.id) {
          setNotice('这份旧版模板的兼容入口无效，请返回列表重试。');
          return;
        }
        router.push(`${target.pathname}${target.search}`);
      } catch {
        setNotice('这份旧版模板的兼容入口无效，请返回列表重试。');
      }
      return;
    }
    if (template.applyMode !== 'studio-draft') {
      setNotice('这份模板暂不支持当前工作台的应用方式。');
      return;
    }
    if (!template.recipe || template.status === 'archived') {
      setNotice('这份模板当前不可应用，请返回列表重新选择。');
      return;
    }
    await createDraft({ templateId: template.id, templateSource: template.source });
  }

  async function refreshDraft() {
    if (!activeDraft) return;
    const draftId = activeDraft.id;
    setWorking(true);
    try {
      const body = await requestJson<StudioDraftDto | { draft: StudioDraftDto }>(`${API}/drafts/${encodeURIComponent(draftId)}`);
      if (currentUserId.current !== userId || currentDraftId.current !== draftId) return;
      const latest = 'draft' in body ? body.draft : body;
      setCurrentDraft(latest);
      savedSignature.current = JSON.stringify(latest);
      blockedSaveSignature.current = '';
      setConflict(false);
      setSaveState({ label: '已载入服务器版本', tone: 'success' });
      clearRecovery(userId, latest.id);
      setRecoveryAvailable(false);
    } catch (error) {
      if (currentUserId.current === userId && currentDraftId.current === draftId) {
        handleAuthExpired(error);
        setNotice(messageForFailure(error));
      }
    }
    finally { setWorking(false); }
  }

  function restoreLocalDraft() {
    if (!activeDraft) return;
    const local = readRecovery(userId, activeDraft.id);
    if (!local) { setRecoveryAvailable(false); return; }
    markDraftEdited(local.id);
    const outdated = local.revision !== activeDraft.revision;
    setCurrentDraft({ ...activeDraft, prompt: local.prompt, values: local.values, assets: local.assets, parameters: local.parameters });
    blockedSaveSignature.current = outdated ? `${activeDraft.id}:${activeDraft.revision}` : '';
    setConflict(outdated);
    setRecoveryAvailable(false);
    setSaveState({ label: outdated ? '本机内容已恢复，需处理版本冲突' : '已恢复上一次输入', tone: outdated ? 'warning' : 'success' });
  }

  async function saveRecoveredAsNewDraft() {
    if (!activeDraft) return;
    const local = { ...activeDraft };
    const created = await createDraft({
      fromDraftId: local.id,
      recovery: {
        name: `${local.name}（副本）`,
        groupName: local.groupName,
        prompt: local.prompt,
        values: local.values,
        assets: local.assets,
        parameters: local.parameters,
      },
    });
    if (!created) return;
    clearRecovery(userId, local.id);
    setRecoveryAvailable(false);
    setConflict(false);
    setNotice('本机内容已另存为新模块；原草稿和历史记录未覆盖。');
  }

  async function addAssets(selection: UploadedAssetSelection[], slotKey: string | null = null): Promise<UploadedImagePickerConfirmResult> {
    if (!activeDraft || selection.length === 0) return { success: false, message: '请先选择要加入的素材。' };
    const slot = activeDraft.recipe?.assetSlots.find((item) => item.key === slotKey) || null;
    if (slotKey && !slot) {
      return { success: false, message: '这个素材槽位已变化，请重新打开模板。' };
    }
    if (slot && selection.some((item) => !slot.types.includes(item.type))) {
      return { success: false, message: `${slot.label}不支持所选素材类型，请调整选择后重试。` };
    }
    const existing = new Set(activeDraft.assets.map((item) => item.assetId));
    const uniqueSelection = selection.filter((item) => !existing.has(item.id));
    const alreadyBound = slot ? activeDraft.assets.filter((item) => assetSlotKey(item) === slot.key && item.role === slot.role && slot.types.includes(item.type)).length : 0;
    const capacity = Math.max(0, Math.min(
      12 - activeDraft.assets.length,
      slot?.maxItems == null ? Number.MAX_SAFE_INTEGER : slot.maxItems - alreadyBound,
    ));
    if (uniqueSelection.length > capacity) {
      return {
        success: false,
        message: `${slot?.label || '当前模块'}最多还能添加 ${capacity} 个素材，请减少选择后重试。`,
      };
    }
    const additions = uniqueSelection.map((item) => ({
      assetId: item.id,
      role: slot?.role || 'reference',
      type: item.type,
      ...(slot ? { slotKey: slot.key } : {}),
    }));
    if (additions.length !== uniqueSelection.length) {
      return { success: false, message: '部分素材暂时无法加入，请重新选择后重试。' };
    }
    if (additions.length) updateDraft((current) => ({ ...current, assets: [...current.assets, ...additions] }));
    return { success: true };
  }

  async function uploadFile(file: File, onProgress?: UploadProgressHandler) {
    const result = await uploadFileAsAsset(file, {
      fallbackToRaw: true,
      onProgress,
      invalidJsonMessage: '素材上传服务暂时无法响应，请刷新或重新登录后重试。',
    });
    if (!result.id) throw new Error('素材没有返回可用记录');
    return result.id;
  }

  async function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFile = Array.from(event.clipboardData.items)
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!imageFile) return;
    event.preventDefault();
    if (!activeDraft) return;
    setAssetBusy(true);
    setNotice('');
    try {
      const assetId = await uploadFile(imageFile);
      if (currentUserId.current !== userId || draftRef.current?.id !== activeDraft.id) return;
      updateDraft((current) => ({
        ...current,
        assets: [...current.assets, { assetId, role: 'reference', type: 'image' }],
      }));
      setNotice('已把剪贴板图片加入参考素材。');
    } catch (error) { setNotice(messageForFailure(error)); }
    finally { setAssetBusy(false); }
  }

  function changeAsset(index: number, patch: Partial<StudioAssetInput>) {
    updateDraft((current) => ({
      ...current,
      assets: current.assets.map((asset, position) => position === index ? { ...asset, ...patch } : asset),
    }));
  }

  function bindAssetToSlot(index: number, slotKey: string) {
    if (!activeDraft) return;
    const asset = activeDraft.assets[index];
    const slot = activeDraft.recipe?.assetSlots.find((item) => item.key === slotKey) || null;
    if (slot && !slot.types.includes(asset.type)) {
      setNotice(`${slot.label}不支持此素材类型。`);
      return;
    }
    if (slot) {
      const currentCount = activeDraft.assets.filter((item, position) => position !== index && assetSlotKey(item) === slot.key).length;
      if (slot.maxItems != null && currentCount >= slot.maxItems) {
        setNotice(`${slot.label}已达到 ${slot.maxItems} 个素材的上限。`);
        return;
      }
    }
    updateDraft((current) => ({
      ...current,
      assets: current.assets.map((item, position) => position !== index
        ? item
        : slot
          ? { ...item, role: slot.role, slotKey: slot.key }
          : { ...item, role: 'reference' as const, slotKey: undefined }),
    }));
  }

  function moveAsset(index: number, direction: -1 | 1) {
    if (!activeDraft) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= activeDraft.assets.length) return;
    updateDraft((current) => {
      const assets = [...current.assets];
      [assets[index], assets[nextIndex]] = [assets[nextIndex], assets[index]];
      return { ...current, assets };
    });
  }

  function removeAsset(index: number) {
    updateDraft((current) => ({ ...current, assets: current.assets.filter((_, position) => position !== index) }));
  }

  async function queryRequest(requestId: string) {
    const operation = pendingRun?.requestId === requestId ? pendingRun : null;
    const routeAtStart = currentRouteKeyRef.current;
    setWorking(true);
    setNotice('正在查询本次请求');
    try {
      const query = new URLSearchParams({ request_id: requestId });
      const value = await requestJson<StudioRunListResponse>(`${API}/runs?${query}`);
      if (currentUserId.current !== userId) return;
      const match = value.items.find((item) => item.requestId === requestId);
      if (match) {
        setRuns((current) => [match, ...current.filter((item) => item.id !== match.id)]);
        setPendingRun(null);
        sessionStorage.removeItem(pendingKey);
        setRequestUnknown(false);
        if (operation && currentDraftId.current === operation.draftId && currentRouteKeyRef.current === routeAtStart) {
          navigate({
            type: 'video', view: 'templates', runId: match.id, draftId: match.draftId,
            moduleId: match.draftId, templateId: null, templateSource: null,
          }, true);
          setNotice(`本次请求状态：${statusLabel(match.status)}。`);
        } else {
          setNotice(`本次请求状态：${statusLabel(match.status)}。当前模块保持不变。`);
        }
      } else {
        setRequestUnknown(true);
        setNotice('暂未查到这次请求。若内容未改变，可按原请求号重试；编辑过的内容需另建请求。');
      }
    } catch (error) {
      if (currentUserId.current !== userId) return;
      setRequestUnknown(true);
      handleAuthExpired(error);
      setNotice(messageForFailure(error));
    } finally { setWorking(false); }
  }

  async function submitRun(mode: 'direct' | 'llm', reuseRequest = false) {
    if (!activeDraft || submitting.current) return;
    if (mode === 'llm' && capabilities?.llmEnabled !== true) return;
    if (!reuseRequest && mode === 'llm' && moduleRun && ['queued', 'running', 'uncertain'].includes(moduleRun.status)) {
      setNotice('上一条文案尚未完成或结果待确认，请先查看记录。'); return;
    }
    if (pendingRun && requestUnknown && !reuseRequest) {
      setNotice('请先查询未确认的请求；确认后再用当前内容发起新请求。');
      return;
    }
    const recipe = activeDraft.recipe;
    const errors = recipe?.fields.map((field) => ({ field, message: fieldError(field, fieldValue(activeDraft.values, field)) })).filter((item) => item.message) || [];
    const missingSlots = missingAssetSlots(recipe, activeDraft.assets);
    if (mode === 'direct' && (errors.length || missingSlots.length)) {
      setNotice(errors[0]?.message || `还缺少素材：${missingSlots.map((slot) => slot.label).join('、')}`);
      return;
    }
    if (!composeDraftPrompt(activeDraft)) {
      setNotice('请先填写提示词，或使用模板中已有的要求。');
      return;
    }
    submitting.current = true;
    setWorking(true);
    for (let i = 0; i < 50 && savingDraftIds.current.has(activeDraft.id); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (savingDraftIds.current.has(activeDraft.id)) { setNotice('草稿仍在保存，请稍后再试。'); submitting.current = false; setWorking(false); return; }
    const latestDraft = draftRef.current;
    if (!latestDraft || latestDraft.id !== activeDraft.id) { submitting.current = false; setWorking(false); return; }
    const saved = reuseRequest || await saveDraft(latestDraft, true);
    if (!saved) { submitting.current = false; setWorking(false); return; }
    const current = draftRef.current;
    if (!current || current.id !== activeDraft.id) { submitting.current = false; setWorking(false); return; }
    const inputSignature = JSON.stringify({ name: current.name, groupName: current.groupName, prompt: current.prompt, values: current.values, assets: current.assets, parameters: current.parameters });
    if (reuseRequest && (!pendingRun || pendingRun.inputSignature !== inputSignature || pendingRun.draftId !== current.id || pendingRun.mode !== mode || (pendingRun.llmModel && pendingRun.llmModel !== llmModel))) {
      setNotice('当前内容已变化，请先查询原请求；不能按旧请求号提交新内容。'); submitting.current = false; setWorking(false); return;
    }
    const operation = reuseRequest && pendingRun
      ? pendingRun
      : { requestId: crypto.randomUUID(), draftId: current.id, revision: current.revision, mode, ...(mode === 'llm' ? { llmModel } : {}), inputSignature };
    const routeAtStart = currentRouteKeyRef.current;
    setPendingRun(operation);
    setRequestUnknown(false);
    setWorking(true);
    setNotice(mode === 'direct' ? '正在保存本次直接套用记录。' : '正在提交提示词整理。');
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(operation));
      const body: CreateStudioRunRequest = {
        draftId: operation.draftId,
        revision: operation.revision,
        requestId: operation.requestId,
        mode: operation.mode,
        ...(operation.llmModel ? { llmModel: operation.llmModel } : {}),
      };
      const response = await requestJson<CreateStudioRunResponse>(`${API}/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.run?.id) throw new ApiFailure(0, 'UNAVAILABLE', '未收到完整任务信息，请先查询这次请求。');
      if (currentUserId.current !== userId) return;
      const run = response.run;
      setRuns((currentRuns) => [run, ...currentRuns.filter((item) => item.id !== run.id)]);
      setPendingRun(null);
      sessionStorage.removeItem(pendingKey);
      setRequestUnknown(false);
      const latest = draftRef.current;
      const latestSignature = latest?.id === current.id ? JSON.stringify({ name: latest.name, groupName: latest.groupName, prompt: latest.prompt, values: latest.values, assets: latest.assets, parameters: latest.parameters }) : '';
      if (currentDraftId.current === current.id && currentRouteKeyRef.current === routeAtStart && latestSignature === inputSignature) {
        navigate({
          type: 'video', view: 'templates', runId: run.id, draftId: current.id,
          moduleId: current.id, templateId: null, templateSource: null,
        }, true);
        setNotice(run.status === 'succeeded' ? '已保存本次记录。' : `请求已记录：${statusLabel(run.status)}。`);
      } else {
        setNotice('请求已记录；你当前的模块和新编辑保持不变。');
      }
    } catch (error) {
      if (currentUserId.current !== userId) return;
      const isUnknown = error instanceof ApiFailure && (error.status === 0 || (error.status >= 500 && error.status !== 503));
      setRequestUnknown(isUnknown);
      if (!isUnknown) { sessionStorage.removeItem(pendingKey); setPendingRun(null); }
      if (error instanceof ApiFailure && error.status === 401) {
        handleAuthExpired(error);
        if (draftRef.current?.id !== current.id) saveRecovery(userId, current);
      }
      setNotice(messageForFailure(error));
    } finally { submitting.current = false; setWorking(false); }
  }

  async function cancelRun(run: StudioRunDto) {
    if (run.status !== 'queued') return;
    setWorking(true);
    try {
      const body = await requestJson<StudioRunDto | { run: StudioRunDto }>(`${API}/runs/${encodeURIComponent(run.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
      });
      const updated = 'run' in body ? body.run : body;
      setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRunDetail((current) => current?.run.id === updated.id ? { ...current, run: updated } : current);
      setNotice('排队任务已取消。');
    } catch (error) { setNotice(messageForFailure(error)); }
    finally { setWorking(false); }
  }

  async function continueGeneration(run: StudioRunDto, finalText: string) {
    const savedPrompt = finalText;
    if (!savedPrompt) { setNotice('这条记录没有可继续使用的已保存文本。'); return; }
    if (run.status !== 'succeeded') { setNotice('这条记录还没有成功完成，请先查看状态后再继续。'); return; }
    setWorking(true);
    try {
    const revision = await requestJson<{ runId: string }>(`${API}/runs/${encodeURIComponent(run.id)}/handoff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: savedPrompt }),
    });
    const returnView = view;
    const returnTo = `/template-studio?type=video&view=${returnView}&runId=${encodeURIComponent(run.id)}&draftId=${encodeURIComponent(run.draftId)}&moduleId=${encodeURIComponent(run.draftId)}`;
    const query = new URLSearchParams({
      template_studio_run_id: revision.runId,
      template_studio_return_to: returnTo,
    });
    router.push(`/generate?${query.toString()}`);
    } catch (error) { setNotice(messageForFailure(error)); }
    finally { setWorking(false); }
  }

  async function copyRunToDraft(detail: RunDetail) {
    if (draftCreationLock.current) return;
    setCopyingRunId(detail.run.id);
    try {
      const created = await createDraft({ fromRunId: detail.run.id });
      if (!created) return;
      setNotice('已用历史输入新建模块，尚未生成或扣费；接下来可编辑并主动生成文案。');
    } finally { setCopyingRunId(null); }
  }

  async function openRun(run: StudioRunDto) {
    navigate({
      type: 'video', view: view === 'templates' ? 'results' : view, runId: run.id,
      draftId: run.draftId, moduleId: run.draftId, templateId: null, templateSource: null,
    });
  }

  async function refreshRunDetail(run: StudioRunDto) {
    const sequence = ++detailSequence.current;
    const routeAtStart = currentRouteKeyRef.current;
    setDetailBusy(true);
    setDetailError('');
    try {
      const value = await requestJson<RunDetail>(`${API}/runs/${encodeURIComponent(run.id)}`);
      if (sequence !== detailSequence.current || currentUserId.current !== userId || currentRouteKeyRef.current !== routeAtStart) return;
      setRunDetail(value);
      setRuns((current) => current.map((item) => item.id === value.run.id ? value.run : item));
    } catch (error) {
      if (sequence === detailSequence.current && currentUserId.current === userId && currentRouteKeyRef.current === routeAtStart) {
        handleAuthExpired(error);
        setDetailError(messageForFailure(error));
      }
    } finally {
      if (sequence === detailSequence.current) setDetailBusy(false);
    }
  }

  async function openTemplateDetail(template: StudioTemplateDto) {
    setTemplateConflict(null);
    setTemplateRecoveryAvailable(Boolean(readTemplateRecovery(userId, template.id)));
    navigate({
      type: 'video', view: 'templates', templateId: template.id, templateSource: template.source,
      draftId: null, moduleId: null, runId: null,
    });
  }

  function beginTemplateEdit(template: StudioTemplateDto) {
    const recovery = readTemplateRecovery(userId, template.id);
    templateEditBaseline.current = templateEditSignature(template);
    setTemplateEdit(recovery || template);
    setTemplateRecoveryAvailable(false);
  }

  async function closeTemplateEditor() {
    if (!templateEdit || templateEditBusy) return;
    const dirty = templateEditBaseline.current === null
      || templateEditSignature(templateEdit) !== templateEditBaseline.current;
    if (dirty) {
      saveTemplateRecovery(userId, templateEdit);
      setTemplateRecoveryAvailable(true);
      if (!(await confirm('当前模板编辑尚未保存。关闭后会保留为本机草稿，可稍后恢复。是否关闭？', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    } else {
      clearTemplateRecovery(userId, templateEdit.id);
      setTemplateRecoveryAvailable(false);
    }
    templateEditBaseline.current = null;
    setTemplateEdit(null);
  }

  function restoreTemplateEdit() {
    if (!routedTemplateId) return;
    const local = readTemplateRecovery(userId, routedTemplateId);
    if (!local) { setTemplateRecoveryAvailable(false); return; }
    const baseline = templates.find((item) => item.id === local.id && item.source === local.source);
    templateEditBaseline.current = baseline ? templateEditSignature(baseline) : null;
    setTemplateEdit(local);
    setTemplateRecoveryAvailable(false);
  }

  async function reloadConflictedTemplate() {
    if (!templateConflict) return;
    if (templateEdit?.id === templateConflict.id && !(await confirm('重新载入会放弃当前模板编辑，是否继续？', { title: '重新载入', confirmLabel: '放弃修改并载入' }))) return;
    const routeAtStart = currentRouteKeyRef.current;
    setTemplateEditBusy(true);
    try {
      const query = new URLSearchParams({ source: templateConflict.source });
      const latest = await requestJson<StudioTemplateDetailResponse>(`${API}/templates/${encodeURIComponent(templateConflict.id)}?${query}`);
      if (currentUserId.current !== userId || currentRouteKeyRef.current !== routeAtStart || latest.template.id !== templateConflict.id) return;
      setTemplates((current) => {
        const found = current.some((item) => item.id === latest.template.id && item.source === latest.template.source);
        return found
          ? current.map((item) => item.id === latest.template.id && item.source === latest.template.source ? latest.template : item)
          : [latest.template, ...current];
      });
      setTemplateDetail(latest);
      if (templateEdit?.id === templateConflict.id) {
        templateEditBaseline.current = null;
        setTemplateEdit(null);
      }
      clearTemplateRecovery(userId, latest.template.id);
      setTemplateRecoveryAvailable(false);
      setTemplateConflict(null);
      setNotice('已载入模板最新版本；请检查后重新编辑或执行操作。');
    } catch (error) {
      if (currentUserId.current === userId && currentRouteKeyRef.current === routeAtStart) handleAuthExpired(error);
      if (currentRouteKeyRef.current === routeAtStart && error instanceof ApiFailure && error.status === 401 && templateEdit) {
        saveTemplateRecovery(userId, templateEdit);
        setTemplateRecoveryAvailable(true);
      }
      if (currentRouteKeyRef.current === routeAtStart) setNotice(messageForFailure(error));
    } finally {
      setTemplateEditBusy(false);
    }
  }

  async function saveTemplateEdit() {
    if (!templateEdit) return;
    setTemplateEditBusy(true);
    try {
      const body: UpdateStudioTemplateRequest = {
        action: 'update',
        expectedRevision: templateEdit.revision,
        name: templateEdit.name,
        description: templateEdit.description,
        groupName: templateEdit.groupName,
        recipe: templateEdit.recipe || { instruction: '', fields: [], assetSlots: [], defaultParameters: {} },
      };
      const response = await requestJson<StudioTemplateDto | { template: StudioTemplateDto }>(`${API}/templates/${encodeURIComponent(templateEdit.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const saved = 'template' in response ? response.template : response;
      setTemplates((current) => current.map((item) => item.id === saved.id ? saved : item));
      templateEditBaseline.current = null;
      setTemplateEdit(null);
      setTemplateConflict(null);
      clearTemplateRecovery(userId, saved.id);
      setTemplateRecoveryAvailable(false);
      setNotice('模板草稿已保存。');
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 409 || error.code === 'CONFLICT')) {
        setTemplateConflict({ id: templateEdit.id, source: templateEdit.source });
        saveTemplateRecovery(userId, templateEdit);
        setTemplateRecoveryAvailable(true);
      }
      if (error instanceof ApiFailure && error.status === 401) {
        saveTemplateRecovery(userId, templateEdit);
        setTemplateRecoveryAvailable(true);
        handleAuthExpired(error);
      }
      setNotice(messageForFailure(error));
    }
    finally { setTemplateEditBusy(false); }
  }

  async function publishTemplate(template: StudioTemplateDto) {
    if (!template.canPublish) return;
    const confirmed = (await confirm(`发布「${template.name}」后，其他有权使用的内部成员可以应用此版本。`, { title: '发布模板', confirmLabel: '发布模板' }));
    if (!confirmed) return;
    setTemplateEditBusy(true);
    try {
      const response = await requestJson<StudioTemplateDto | { template: StudioTemplateDto }>(`${API}/templates/${encodeURIComponent(template.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', expectedRevision: template.revision, expectedVersionId: template.version?.id || null }),
      });
      const saved = 'template' in response ? response.template : response;
      setTemplates((current) => current.map((item) => item.id === saved.id ? saved : item));
      setTemplateDetail((current) => current?.template.id === saved.id ? { ...current, template: saved } : current);
      setTemplateConflict(null);
      setNotice('模板已发布。');
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 409 || error.code === 'CONFLICT')) setTemplateConflict({ id: template.id, source: template.source });
      handleAuthExpired(error);
      setNotice(messageForFailure(error));
    }
    finally { setTemplateEditBusy(false); }
  }

  async function archiveTemplate(template: StudioTemplateDto) {
    if (!template.canManage) return;
    const confirmed = (await confirm(`停用「${template.name}」后，新用户将不能再应用它；已有历史记录保留。`, { title: '停用模板', confirmLabel: '停用模板', danger: true }));
    if (!confirmed) return;
    setTemplateEditBusy(true);
    try {
      const response = await requestJson<StudioTemplateDto | { template: StudioTemplateDto }>(`${API}/templates/${encodeURIComponent(template.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive', expectedRevision: template.revision }),
      });
      const saved = 'template' in response ? response.template : response;
      setTemplates((current) => current.map((item) => item.id === saved.id ? saved : item));
      setTemplateDetail((current) => current?.template.id === saved.id ? { ...current, template: saved } : current);
      setTemplateConflict(null);
      setNotice('模板已停用，历史记录仍可查看。');
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 409 || error.code === 'CONFLICT')) setTemplateConflict({ id: template.id, source: template.source });
      handleAuthExpired(error);
      setNotice(messageForFailure(error));
    }
    finally { setTemplateEditBusy(false); }
  }

  async function createPersonalTemplate() {
    if (!activeDraft || capabilities?.canCreatePrivateTemplates !== true) return;
    const instruction = newTemplateInstruction.trim();
    if (!instruction) {
      setNotice('请填写个人模板的固定要求。');
      return;
    }
    const recipe = activeDraft.recipe
      ? { ...activeDraft.recipe, instruction }
      : { instruction, fields: [], assetSlots: [], defaultParameters: activeDraft.parameters };
    const request: CreateStudioTemplateRequest = {
      name: newTemplateName.trim() || activeDraft.name,
      description: null,
      groupName: newTemplateGroup.trim() || activeDraft.groupName || '未分组',
      recipe,
    };
    setCreateTemplateBusy(true);
    try {
      const response = await requestJson<StudioTemplateDto | { template: StudioTemplateDto }>(`${API}/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      const template = 'template' in response ? response.template : response;
      setTemplates((current) => [template, ...current.filter((item) => item.id !== template.id)]);
      setCreateTemplateOpen(false);
      createTemplateDraftRef.current = null;
      setNewTemplateName('');
      setNewTemplateGroup('');
      setNewTemplateInstruction('');
      setNotice('已另存为个人模板。');
      navigate({ type: 'video', view: 'templates', templateId: null, templateSource: null, runId: null }, true);
    } catch (error) {
      handleAuthExpired(error);
      setNotice(messageForFailure(error));
    }
    finally { setCreateTemplateBusy(false); }
  }

  function applyFilters() {
    setAppliedTemplateFilters({ ...templateFilters });
  }

  function applyRunFilters() {
    navigate({ status: runFilters.status || null }, true);
    setAppliedRunFilters({ ...runFilters });
  }

  function updateField(field: StudioTemplateField, value: StudioJsonValue) {
    updateDraft((current) => ({ ...current, values: { ...current.values, [field.key]: value } }));
  }

  function updateParameter(key: string, value: StudioJsonValue | undefined) {
    updateDraft((current) => {
      const parameters = { ...current.parameters };
      if (value === undefined) delete parameters[key];
      else parameters[key] = value;
      return { ...current, parameters };
    });
  }

  const recipeSlots = activeDraft?.recipe?.assetSlots || [];
  const pickerSlot = activeDraft?.recipe?.assetSlots.find((item) => item.key === pickerSlotKey) || null;
  const pickerSlotCount = pickerSlot && activeDraft
    ? activeDraft.assets.filter((item) => assetSlotKey(item) === pickerSlot.key && item.role === pickerSlot.role && pickerSlot.types.includes(item.type)).length
    : 0;
  const pickerSelectionCapacity = activeDraft
    ? Math.max(0, Math.min(12 - activeDraft.assets.length, pickerSlot?.maxItems == null ? Number.MAX_SAFE_INTEGER : pickerSlot.maxItems - pickerSlotCount))
    : 0;
  const assetRows = activeDraft?.assets.map((asset, index) => ({ asset, index })) || [];
  const renderAssetRow = ({ asset, index }: { asset: StudioAssetInput; index: number }) => {
    const assignedSlotKey = assetSlotKey(asset);
    const matchingSlot = recipeSlots.find((slot) => slot.key === assignedSlotKey) || null;
    const assetTypeLabel = asset.type === 'image' ? '图片' : asset.type === 'video' ? '视频' : '音频';
    return (
      <div className={styles.assetRow} key={`${asset.assetId}-${index}`}>
        <span className={styles.assetType} aria-label={`${assetTypeLabel}素材`}>{asset.type === 'image' ? <ImageIcon size={14} /> : asset.type === 'video' ? <Film size={14} /> : <span>A</span>}</span>
        <span className={styles.assetName}>{assetTypeLabel}素材 {index + 1}{matchingSlot ? ` · ${matchingSlot.label}` : ''}</span>
        {recipeSlots.length > 0 ? (
          <>
            <label className={styles.visuallyHidden} htmlFor={`studio-asset-slot-${index}`}>素材 {index + 1} 绑定的模板槽位</label>
            <select id={`studio-asset-slot-${index}`} value={matchingSlot?.key || ''} onChange={(event) => bindAssetToSlot(index, event.target.value)}>
              <option value="">未绑定槽位</option>
              {recipeSlots.filter((slot) => slot.types.includes(asset.type)).map((slot) => {
                const count = assetRows.filter((row) => row.index !== index && assetSlotKey(row.asset) === slot.key).length;
                const full = slot.maxItems != null && count >= slot.maxItems;
                return <option key={slot.key} value={slot.key} disabled={full && slot.key !== matchingSlot?.key}>{slot.label}{slot.required ? ' · 必填' : ''}</option>;
              })}
            </select>
          </>
        ) : (
          <>
            <label className={styles.visuallyHidden} htmlFor={`studio-asset-role-${index}`}>素材 {index + 1} 的使用位置</label>
            <select id={`studio-asset-role-${index}`} value={asset.role} onChange={(event) => changeAsset(index, { role: event.target.value as StudioAssetInput['role'] })}>
              <option value="reference">参考素材</option>
              <option value="first" disabled={asset.type !== 'image'}>首帧</option>
              <option value="last" disabled={asset.type !== 'image'}>尾帧</option>
            </select>
          </>
        )}
        <div className={styles.assetActions}>
          <button className={styles.iconButton} type="button" title="上移" aria-label={`素材 ${index + 1} 上移`} disabled={index === 0} onClick={() => moveAsset(index, -1)}><ArrowUp size={14} /></button>
          <button className={styles.iconButton} type="button" title="下移" aria-label={`素材 ${index + 1} 下移`} disabled={index === assetRows.length - 1} onClick={() => moveAsset(index, 1)}><ArrowDown size={14} /></button>
          <button className={`${styles.iconButton} ${styles.dangerButton}`} type="button" title="移除素材" aria-label={`移除素材 ${index + 1}`} onClick={() => removeAsset(index)}><Trash2 size={14} /></button>
        </div>
      </div>
    );
  };

  const fieldErrors = activeDraft?.recipe?.fields.map((field) => ({ field, message: fieldError(field, fieldValue(activeDraft.values, field)) })).filter((item) => item.message) || [];
  const missingSlots = missingAssetSlots(activeDraft?.recipe || null, activeDraft?.assets || []);
  const inputBlocker: FeedbackMessage | null = working ? { message: '正在处理，请等待本次操作完成。', tone: 'progress' }
    : assetBusy ? { message: '素材还在处理，请等待素材加入后继续。', tone: 'progress' }
    : authExpired ? { message: '登录已失效，请重新登录；当前草稿保留。', tone: 'warning' }
    : conflict ? { message: '草稿与服务器版本冲突，请先处理页面上的版本冲突提示。', tone: 'warning' }
    : pendingRun && requestUnknown ? { message: '上次提交结果尚未确认，请先点击“查询这次请求”，避免重复提交。', tone: 'warning' }
    : null;
  const directBlocker: FeedbackMessage | null = inputBlocker || (fieldErrors.length
    ? { message: '请补齐模板输入。', tone: 'warning' }
    : missingSlots.length ? { message: `请添加必填素材：${missingSlots.map(slot => slot.label).join('、')}`, tone: 'warning' }
    : activeDraft && !composeDraftPrompt(activeDraft) ? { message: '请先填写本次需求。', tone: 'info' } : null);
  const llmBlocker: FeedbackMessage | null = inputBlocker || (moduleRun && ['queued', 'running', 'uncertain'].includes(moduleRun.status)
    ? moduleRun.status === 'uncertain'
      ? { message: '上一条文案结果待确认，请先联系管理员核对，避免重复费用。', tone: 'warning' }
      : { message: '已有文案正在处理，请等待结果或在历史中取消排队。', tone: 'progress' }
    : !capabilities
      ? capabilityError ? { message: capabilityError, tone: 'error' } : { message: '正在读取文字服务配置，请稍候。', tone: 'progress' }
      : !capabilities.llmEnabled
        ? capabilityError ? { message: capabilityError, tone: 'error' } : { message: capabilities.llmReason || '当前暂不可生成文案。', tone: 'warning' }
        : activeDraft && !composeDraftPrompt(activeDraft) ? { message: '请先填写本次需求。', tone: 'info' } : null);
  const assetIds = activeDraft?.assets.map((item) => item.assetId) || [];
  const loginNext = `/template-studio?${searchParams.toString()}`;

  return <>{productDialog}{((
    <section className={styles.videoWorkbench} aria-label="视频模板工作区">
      <header className={styles.videoHeader}>
        <nav className={styles.viewTabs} aria-label="视频工作区" role="tablist">
          {([
            ['templates', '模板'], ['prompts', '我的提示词'], ['results', '视频结果'],
          ] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? styles.activeView : ''} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </nav>
        <div className={styles.headerActions}>
          {capabilities?.canManageTemplates && <button type="button" className={styles.quietButton} onClick={() => setContextEditor({})}><Settings size={15} />通用上下文</button>}
          <span className={styles.saveState} role="status" data-tone={saveState.tone}>{saveState.label}</span>
          <button className={styles.primaryButton} type="button" onClick={() => void createBlankDraft()} disabled={working}>
            <Plus size={16} aria-hidden="true" /> 新建空白模块
          </button>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar} data-remember-scroll="video-groups">
          {view === 'templates' ? (
            <>
              <section className={styles.sidebarSection} aria-label="模板目录">
                <div className={styles.sectionHeading}><h2>可用模板</h2><span>{templateBusy ? '读取中' : ''}</span></div>
                <form className={styles.searchRow} onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
                  <label className={styles.visuallyHidden} htmlFor="studio-template-search">搜索模板</label>
                  <input id="studio-template-search" value={templateFilters.search} onChange={(event) => setTemplateFilters((current) => ({ ...current, search: event.target.value }))} placeholder="搜索模板" />
                  <button className={styles.iconButton} type="submit" title="搜索模板" aria-label="搜索模板"><Search size={16} /></button>
                </form>
                <label className={styles.visuallyHidden} htmlFor="studio-template-group">按用途分组</label>
                <select id="studio-template-group" value={templateFilters.group} onChange={(event) => { const next = { ...templateFilters, group: event.target.value }; setTemplateFilters(next); setAppliedTemplateFilters(next); }}>
                  <option value="">全部分组</option>
                  {Array.from(new Set(templates.map((item) => item.groupName).filter(Boolean))).map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
                {templateError && <div className={styles.calloutError}>{templateError}<button type="button" className={styles.quietButton} onClick={() => void loadTemplates()}>重试</button></div>}
                <div className={styles.list}>
                  {templates.map((template) => (
                    <div key={`${template.source}:${template.id}`} style={{ display: 'grid', minWidth: 0 }}><button type="button" className={styles.listItem} aria-current={template.id === routedTemplateId && template.source === routedTemplateSource} onClick={() => void openTemplateDetail(template)}>
                      <span className={styles.listItemTitle}>{template.name || '未命名模板'}</span>
                      <span className={styles.listItemMeta}><span>{template.groupName || '未分组'}</span><span>V{template.version?.number || '草稿'}</span><span className={`${styles.status} ${statusClass(template.status)}`}>{template.status === 'published' ? '可用' : template.status === 'archived' ? '已停用' : '草稿'}</span></span>
                      {template.owner && <span className={styles.owner}><UserIdentityBadge size="sm" user={{ name: template.owner.displayName, avatar_url: template.owner.avatarUrl }} /></span>}
                    </button>
                    {template.status !== 'archived' && <ContentReactions contentKey={`${template.source === 'legacy' ? 'legacy_template' : 'video_template'}:${template.id}`} />}
                    </div>
                  ))}
                  {!templateBusy && templates.length === 0 && <div className={styles.emptyState}><Film size={21} /><strong>还没有可用模板</strong><span>可以先新建空白模块，写下提示词并保存。</span></div>}
                </div>
                {templateCursor && <div className={styles.loadMore}><button className={styles.quietButton} type="button" disabled={templateBusy} onClick={() => void loadTemplates(true)}>{templateBusy ? '正在读取' : '加载更多模板'}</button></div>}
                {templateBusy && templates.length === 0 && <div className={styles.saveState} role="status" data-tone="progress">正在加载模板…</div>}
              </section>
              <section className={styles.sidebarSection} aria-label="我的模块">
                <div className={styles.sectionHeading}><h2>我的模块</h2><button className={styles.iconButton} type="button" title="刷新模块" aria-label="刷新模块" onClick={() => void loadDrafts()}><FolderOpen size={15} /></button></div>
                <div className={styles.list}>
                  {drafts.map((item) => (
                    <div key={item.id} style={{ display: 'grid', minWidth: 0 }}><button type="button" className={styles.listItem} aria-current={item.id === routedDraftId} onClick={() => navigate({ type: 'video', view: 'templates', draftId: item.id, moduleId: item.id, runId: null, templateId: null, templateSource: null })}>
                      <span className={styles.listItemTitle}>{item.name || '未命名模块'}</span>
                      <span className={styles.listItemMeta}><span>{item.groupName || '未分组'}</span><span>修订 {item.revision}</span></span>
                    </button><span className={styles.recordTime}><RelativeTime value={item.updatedAt} /></span><ContentReactions contentKey={`video_draft:${item.id}`} /></div>
                  ))}
                  {!draftBusy && drafts.length === 0 && <span className={styles.saveState}>保存的模块会显示在这里。</span>}
                </div>
                {draftCursor && <div className={styles.loadMore}><button className={styles.quietButton} type="button" disabled={draftBusy} onClick={() => void loadDrafts(true)}>{draftBusy ? '正在读取' : '加载更多模块'}</button></div>}
              </section>
            </>
          ) : (
            <section className={styles.sidebarSection} aria-label={view === 'prompts' ? '提示词历史筛选' : '视频结果筛选'}>
              <div className={styles.sectionHeading}><h2>{view === 'prompts' ? '我的提示词' : '视频结果'}</h2><button className={styles.iconButton} type="button" title="重新载入" aria-label="重新载入" onClick={() => void loadRuns()}><LoaderCircle size={15} /></button></div>
              <div className={styles.filterRow}>
                <label className={styles.visuallyHidden} htmlFor="studio-run-status">文案状态</label>
                <select id="studio-run-status" value={runFilters.status} onChange={(event) => setRunFilters((current) => ({ ...current, status: statusFilter(event.target.value) }))}>
                  {RUN_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.value ? `文案：${option.label}` : '全部文案状态'}</option>)}
                </select>
                <label className={styles.visuallyHidden} htmlFor="studio-run-template">按模板筛选</label>
                <select id="studio-run-template" value={runFilters.templateId} onChange={(event) => setRunFilters((current) => ({ ...current, templateId: event.target.value }))}>
                  <option value="">全部模板</option>
                  {uniqueTemplates.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
                </select>
              </div>
              <div className={styles.filterRow}>
                <label className={styles.visuallyHidden} htmlFor="studio-run-from">开始日期</label>
                <input id="studio-run-from" type="date" value={runFilters.from} onChange={(event) => setRunFilters((current) => ({ ...current, from: event.target.value }))} />
                <label className={styles.visuallyHidden} htmlFor="studio-run-to">结束日期</label>
                <input id="studio-run-to" type="date" value={runFilters.to} onChange={(event) => setRunFilters((current) => ({ ...current, to: event.target.value }))} />
              </div>
              <button className={styles.filterButton} type="button" onClick={applyRunFilters}>应用筛选</button>
              {runError && <div className={styles.calloutError}>{runError}<button type="button" className={styles.quietButton} onClick={() => void loadRuns()}>重试</button></div>}
              <div className={styles.list}>
                {promptRuns.map((run) => (
                  <div key={run.id}>
                  <button type="button" className={`${styles.listItem} ${styles.runListItem}`} aria-current={run.id === routedRunId} onClick={() => void openRun(run)}>
                    {run.thumbnailUrl ? <img className={styles.runThumb} src={run.thumbnailUrl} alt="视频结果缩略图" loading="lazy" /> : <span className={styles.runThumbPlaceholder}>暂无截图/预览不可用</span>}
                    <span className={styles.runListContent}><span className={styles.listItemTitle}>{run.prompt?.trim().slice(0, 72) || (run.mode === 'llm' ? '提示词整理记录' : '直接使用记录')}</span><span className={styles.listItemMeta}><span className={`${styles.status} ${statusClass(run.status)}`}>文案{statusLabel(run.status)}</span></span>{view === 'results' && <span className={styles.listItemMeta}>{videoSummary(run, activeRunDetail)}</span>}</span>
                  </button>
                  <span className={styles.recordTime}><RelativeTime value={run.createdAt} /></span>
                  </div>
                ))}
                {!runBusy && promptRuns.length === 0 && !runError && <div className={styles.emptyState}><CircleAlert size={20} /><strong>暂无匹配记录</strong><span>可以清除部分筛选条件后再查。</span></div>}
              </div>
              {runCursor && <div className={styles.loadMore}><button className={styles.quietButton} type="button" disabled={runBusy} onClick={() => void loadRuns(true)}>{runBusy ? '正在读取' : '加载更多记录'}</button></div>}
              {runBusy && runs.length === 0 && <div className={styles.saveState} role="status" data-tone="progress">正在读取记录…</div>}
            </section>
          )}
        </aside>

        <main className={styles.content}>
          {notice && <div className={styles.callout} role="status"><span>{notice}</span><button className={styles.iconButton} type="button" aria-label="关闭提示" title="关闭提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
          {authExpired && <div className={`${styles.callout} ${styles.calloutWarning}`} role="alert"><span>{recoveryAvailable || templateRecoveryAvailable ? '登录已失效，本机副本已保留；重新登录后可恢复编辑。' : '登录已失效，请重新登录后继续操作。'}</span><div className={styles.promptTools}>{recoveryAvailable && <button className={styles.quietButton} type="button" onClick={restoreLocalDraft}>恢复本机内容</button>}{templateRecoveryAvailable && <button className={styles.quietButton} type="button" onClick={restoreTemplateEdit}>恢复模板编辑</button>}<a className={styles.calloutLink} href={`/login?next=${encodeURIComponent(loginNext)}`}>重新登录</a></div></div>}
          {templateRecoveryAvailable && !authExpired && !templateEdit && <div className={styles.callout}><span>检测到此模板有尚未恢复的本机编辑。</span><button className={styles.quietButton} type="button" onClick={restoreTemplateEdit}>恢复模板编辑</button></div>}
          {view === 'templates' ? (
            activeDraft ? (
              <>
                {conflict && (
                  <div className={`${styles.callout} ${styles.calloutWarning}`} role="alert">
                    <span><strong>草稿版本冲突。</strong>本机内容已保留，不能静默覆盖服务器版本。</span>
                    <div className={styles.promptTools}>
                      {recoveryAvailable && <button className={styles.quietButton} type="button" onClick={restoreLocalDraft}>恢复本机内容</button>}
                      <button className={styles.quietButton} type="button" onClick={() => void refreshDraft()}>载入服务器版本</button>
                      <button className={styles.quietButton} type="button" onClick={() => void saveRecoveredAsNewDraft()}>本机内容另存为新模块</button>
                    </div>
                  </div>
                )}
                {recoveryAvailable && !conflict && <div className={styles.callout}><span>上次输入已保留。</span><button className={styles.quietButton} type="button" onClick={restoreLocalDraft}>恢复上一次</button></div>}
                <div className={styles.contentHeader}>
                  <div>
                    <h2>{activeDraft.name || '未命名模块'}</h2>
                    <p>{activeDraft.template ? `${activeDraft.template.templateName} · 固定版本 V${activeDraft.template.versionNumber || '未知'}` : '空白模块'} · 修订 {activeDraft.revision}</p>
                  </div>
                  <div className={styles.headerActions}>
                    {!activeDraft.id.startsWith('local-') && <ContentReactions contentKey={`video_draft:${activeDraft.id}`} />}
                    <button type="button" className={styles.quietButton} onClick={() => setContextEditor({ draftId: activeDraft.id })}><Settings size={15} />模块上下文</button>
                    <button className={styles.quietButton} type="button" disabled={working || savingDraftIds.current.has(activeDraft.id)} onClick={() => void saveDraft(activeDraft, true)}><Save size={15} />保存</button>
                    {capabilities?.canCreatePrivateTemplates && <button className={styles.quietButton} type="button" onClick={() => {
                      const id = activeDraft.id;
                      void requestJson<{ context?: string }>(`${API}/context?draftId=${encodeURIComponent(id)}`).then(value => {
                        if (currentDraftId.current !== id) return;
                        if (createTemplateDraftRef.current !== id) {
                          createTemplateDraftRef.current = id;
                          setNewTemplateName(activeDraft.name);
                          setNewTemplateGroup(activeDraft.groupName);
                          setNewTemplateInstruction(value.context || '');
                        }
                        setCreateTemplateOpen(true);
                      }).catch(error => setNotice(messageForFailure(error)));
                    }}>另存为个人模板</button>}
                  </div>
                </div>
                <div className={styles.editorGrid}>
                  <div className={styles.formColumn}>
                    <div className={styles.twoFields}>
                      <div className={styles.field}><label htmlFor="studio-draft-name">模块名称</label><input id="studio-draft-name" value={activeDraft.name} maxLength={120} onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))} /></div>
                      <div className={styles.field}><label htmlFor="studio-draft-group">用途分组</label><input id="studio-draft-group" value={activeDraft.groupName} maxLength={80} onChange={(event) => updateDraft((current) => ({ ...current, groupName: event.target.value }))} /></div>
                    </div>
                    {activeDraft.recipe?.fields.length ? (
                      <div className={styles.fieldGrid}>
                        {activeDraft.recipe.fields.map((field) => {
                          const value = fieldValue(activeDraft.values, field);
                          const error = fieldError(field, value);
                          const controlId = `studio-value-${field.key}`;
                          return (
                            <div className={styles.field} key={field.key}>
                              <label htmlFor={controlId}>{field.label}{'required' in field && field.required ? ' *' : ''}</label>
                              {field.type === 'textarea' ? (
                                <textarea id={controlId} maxLength={field.maxLength} value={stringValue(value)} onChange={(event) => updateField(field, event.target.value)} />
                              ) : field.type === 'select' ? (
                                <select id={controlId} value={stringValue(value)} onChange={(event) => updateField(field, event.target.value)}>
                                  <option value="">请选择</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                                </select>
                              ) : field.type === 'number' ? (
                                <input id={controlId} type="number" min={field.min} max={field.max} value={typeof value === 'number' ? value : ''} onChange={(event) => updateField(field, event.target.value === '' ? '' : Number(event.target.value))} />
                              ) : field.type === 'toggle' ? (
                                <label className={styles.owner}><input id={controlId} type="checkbox" checked={Boolean(value)} onChange={(event) => updateField(field, event.target.checked)} />{field.label}</label>
                              ) : (
                                <input id={controlId} type="text" maxLength={field.maxLength} value={stringValue(value)} onChange={(event) => updateField(field, event.target.value)} />
                              )}
                              {error && <span className={styles.fieldError}>{error}</span>}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className={styles.field}>
                      <label htmlFor="studio-prompt">本次需求</label>
                      <textarea id="studio-prompt" value={activeDraft.prompt} maxLength={12000} onPaste={(event) => { void pasteImage(event); }} onChange={(event) => updateDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder="这次想拍什么？描述主体、场景、动作或镜头" />
                      {activeDraft.recipe?.fields.length ? <span className={styles.fieldHint}>已填写的模板字段会随本次操作保存。</span> : null}
                    </div>
                    <details className={styles.sectionRule}>
                      <summary>参考素材与视频参数（可选）</summary>
                      <p className={styles.fieldHint}>文案生成仅使用文字说明，不读取图片内容。素材与参数供后续视频生成使用。</p>
                    <section className={styles.sectionRule} aria-label="参考素材">
                      <div className={styles.sectionTitle}><span>素材与模板槽位</span>{recipeSlots.length === 0 && <button className={styles.quietButton} type="button" onClick={() => { setPickerSlotKey(null); setPickerOpen(true); }} disabled={assetBusy || activeDraft.assets.length >= 12}><ImagePlus size={15} />添加素材</button>}</div>
                      {missingSlots.length > 0 && <div className={`${styles.callout} ${styles.calloutWarning}`}>仍缺少必填素材：{missingSlots.map((slot) => slot.label).join('、')}</div>}
                      {recipeSlots.map((slot) => {
                        const slotRows = assetRows.filter(({ asset }) => assetSlotKey(asset) === slot.key);
                        const isMissing = slot.required && slotRows.length === 0;
                        return (
                          <section className={styles.assetSlot} key={slot.key} aria-label={`${slot.label}${slot.required ? '，必填' : ''}`}>
                            <div className={styles.assetSlotHeader}>
                              <div><strong>{slot.label}</strong><span>{slot.required ? '必填' : '可选'} · {slotRows.length}/{slot.maxItems || '不限'} · {slot.types.map((type) => type === 'image' ? '图片' : type === 'video' ? '视频' : '音频').join('、')}</span></div>
                              <button className={styles.quietButton} type="button" onClick={() => { setPickerSlotKey(slot.key); setPickerOpen(true); }} disabled={assetBusy || activeDraft.assets.length >= 12 || (slot.maxItems != null && slotRows.length >= slot.maxItems)}><ImagePlus size={15} />添加到此槽位</button>
                            </div>
                            {slotRows.length ? <div className={styles.assetList}>{slotRows.map(renderAssetRow)}</div> : <div className={isMissing ? styles.assetSlotMissing : styles.assetSlotEmpty}>{isMissing ? '必填素材尚未添加' : '此槽位还没有素材'}</div>}
                          </section>
                        );
                      })}
                      {recipeSlots.length > 0 && (
                        <section className={styles.assetSlot} aria-label="未绑定槽位的素材">
                          <div className={styles.assetSlotHeader}>
                            <div><strong>未绑定槽位</strong><span>选择素材后，可在右侧指定用途</span></div>
                            <button className={styles.quietButton} type="button" onClick={() => { setPickerSlotKey(null); setPickerOpen(true); }} disabled={assetBusy || activeDraft.assets.length >= 12}><ImagePlus size={15} />添加素材</button>
                          </div>
                          {assetRows.filter(({ asset }) => !recipeSlots.some((slot) => slot.key === assetSlotKey(asset))).length
                            ? <div className={styles.assetList}>{assetRows.filter(({ asset }) => !recipeSlots.some((slot) => slot.key === assetSlotKey(asset))).map(renderAssetRow)}</div>
                            : <div className={styles.assetSlotEmpty}>素材会按 asset ID 校验账号权限；此处不会复制或转移素材所有权。</div>}
                        </section>
                      )}
                      {recipeSlots.length === 0 && (activeDraft.assets.length === 0
                        ? <div className={styles.assetEmpty}>{assetBusy ? '素材正在加入…' : '还没有添加素材'}</div>
                        : <div className={styles.assetList}>{assetRows.map(renderAssetRow)}</div>)}
                    </section>
                    <section className={styles.sectionRule} aria-label="生成参数">
                      <div className={styles.sectionTitle}><span>生成参数</span><span className={styles.fieldHint}>将随草稿与历史快照保存</span></div>
                      <div className={styles.parameterGrid}>
                        <div className={styles.field}><label htmlFor="studio-param-provider">服务通道</label><select id="studio-param-provider" value={videoProvider} onChange={(event) => updateParameter('provider', event.target.value || undefined)}><option value="">沿用生成页选择</option><option value="seedance">Seedance</option><option value="h3">H3</option>{videoProvider && !['seedance', 'h3'].includes(videoProvider) && <option value={videoProvider} disabled>已保存通道：{videoProvider}（暂不可识别）</option>}</select></div>
                        <div className={styles.field}><label htmlFor="studio-param-model">视频模型</label><select id="studio-param-model" value={savedVideoModel} onChange={(event) => updateParameter('model', event.target.value || undefined)}>
                          <option value="">沿用生成页选择</option>
                          {savedVideoModel && !videoModelOptions.some(option => option.id === savedVideoModel) && <option value={savedVideoModel} disabled>已保存：{savedVideoModel}（当前不可选，值保留）</option>}
                          {videoModelOptions.map(option => <option key={option.id} value={option.id} disabled={videoProvider === 'h3' && (videoCatalogBusy || Boolean(videoCatalogError))}>{option.label} · {videoProvider === 'h3' ? 'H3通道' : 'Seedance通道'}</option>)}
                        </select>{!videoProvider && <span className={styles.fieldHint}>选定通道后才显示适用模型；现有值不会自动改写。</span>}
                        {savedVideoModel && !videoModelOptions.some(option => option.id === savedVideoModel) && <span className={styles.fieldHint}>此模型不在当前可用目录中；仍保留原编号，请确认通道或重新选择。</span>}
                        </div>
                        <div className={styles.field}><label htmlFor="studio-param-mode">生成方式</label><select id="studio-param-mode" value={stringValue(activeDraft.parameters.generationMode ?? 'all_in_one_reference')} onChange={(event) => updateParameter('generationMode', event.target.value)}>{GENERATION_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                        <div className={styles.field}><label htmlFor="studio-param-ratio">画面比例</label><select id="studio-param-ratio" value={stringValue(activeDraft.parameters.ratio ?? '16:9')} onChange={(event) => updateParameter('ratio', event.target.value)}>{VIDEO_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
                        <div className={styles.field}><label htmlFor="studio-param-duration">时长（秒）</label><input id="studio-param-duration" type="number" min={4} max={getStudioVideoDurationMax(activeDraft.parameters)} step={1} value={typeof activeDraft.parameters.duration === 'number' ? activeDraft.parameters.duration : 5} onChange={(event) => updateParameter('duration', event.target.value === '' ? undefined : Number(event.target.value))} /></div>
                        <div className={styles.field}><label htmlFor="studio-param-resolution">清晰度</label><select id="studio-param-resolution" value={stringValue(activeDraft.parameters.resolution ?? '480p')} onChange={(event) => updateParameter('resolution', event.target.value)}>{VIDEO_RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
                        <div className={styles.field}><label htmlFor="studio-param-seed">随机种子</label><input id="studio-param-seed" type="number" min={-1} step={1} value={typeof activeDraft.parameters.seed === 'number' ? activeDraft.parameters.seed : -1} onChange={(event) => updateParameter('seed', event.target.value === '' ? undefined : Number(event.target.value))} /></div>
                        <div className={styles.field}><label htmlFor="studio-param-lora">H3 LoRA</label><select id="studio-param-lora" value={savedLora} onChange={(event) => updateParameter('h3LoraId', event.target.value || undefined)}>
                          <option value="">不指定</option>
                          {savedLora && !loraOptions.some(option => option.id === savedLora) && <option value={savedLora} disabled>已保存：{savedLora}（当前不可选，值保留）</option>}
                          {loraOptions.map(option => <option key={option.id} value={option.id} disabled={videoCatalogBusy || Boolean(videoCatalogError)}>{option.label} · H3通道</option>)}
                        </select>
                        {videoProvider !== 'h3' && <span className={styles.fieldHint}>LoRA仅适用于H3通道，已保存编号仍保留。</span>}
                        {videoProvider === 'h3' && !videoCatalogBusy && !videoCatalogError && !videoConfig?.ready && <span className={styles.fieldHint}>{h3DisabledReason(videoConfig)}；旧值未清除。</span>}
                        {savedLora && !loraOptions.some(option => option.id === savedLora) && <span className={styles.fieldHint}>当前目录无法确认此编号，未自动替换。</span>}
                        {videoProvider === 'h3' && !loraOptions.length && <details><summary>高级：LoRA编号</summary><input aria-label="LoRA编号" value={savedLora} onChange={event => updateParameter('h3LoraId', event.target.value || undefined)} placeholder="不指定" /><span className={styles.fieldHint}>目录尚不可用，可保留或填写已知编号；不代表服务已可用。</span></details>}
                        </div>
                      </div>
                      {videoCatalogBusy && <span className={styles.fieldHint} role="status">正在读取视频选项目录…</span>}
                      {videoCatalogError && <div className={styles.calloutWarning} role="alert">{videoCatalogError}<button type="button" className={styles.quietButton} onClick={() => setVideoCatalogRevision(value => value + 1)}>重试读取选项</button></div>}
                      <div className={styles.parameterToggles}>
                        {([['generateAudio', '生成音频'], ['returnLastFrame', '返回尾帧'], ['watermark', '添加水印'], ['draft', '样片模式']] as const).map(([key, label]) => <label className={styles.owner} key={key}><input type="checkbox" checked={Boolean(activeDraft.parameters[key])} onChange={(event) => updateParameter(key, event.target.checked)} />{label}</label>)}
                      </div>
                    </section>
                    </details>
                    <section className={styles.sectionRule}>
                      <div className={styles.sectionTitle}><span>文案生成</span><span className={styles.saveState} aria-hidden="true" data-tone={saveState.tone}>{saveState.label}</span></div>
                      {fieldErrors.length > 0 && <span className={styles.fieldError}>还有 {fieldErrors.length} 项模板输入未完成。</span>}
                      <div className={styles.textModelField}>
                        <div className={styles.field}>
                          <label htmlFor="studio-text-model">文案模型</label>
                          <select id="studio-text-model" value={llmModel} disabled={working || requestUnknown || !capabilities?.llmEnabled} onChange={event => chooseLlmModel(event.target.value)}>
                            {(capabilities?.llmModels || STUDIO_TEXT_MODELS).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                          </select>
                        </div>
                        {modelRecovery?.scope === modelScope && modelRecovery.value !== llmModel && <button className={styles.quietButton} type="button" disabled={working || requestUnknown} title={studioTextModelLabel(modelRecovery.value)} onClick={() => chooseLlmModel(modelRecovery.value)}>恢复上次模型</button>}
                      </div>
                      <div className={styles.promptTools}>
                        <button className={styles.primaryButton} type="button" disabled={Boolean(llmBlocker)} title={llmBlocker?.message} onClick={() => void submitRun('llm')}><Sparkles size={15} />生成文案</button>
                        <button className={styles.quietButton} type="button" disabled={Boolean(directBlocker)} title={directBlocker?.message} onClick={() => void submitRun('direct')}><Check size={15} />直接使用输入</button>
                        {capabilities && !capabilities.llmEnabled && <span className={styles.fieldHint}>{capabilities.llmReason || 'AI整理当前不可用；可以继续手写和直接套用。'}</span>}
                        {capabilityError && <span className={styles.fieldHint}>{capabilityError}</span>}
                      </div>
                      {capabilities?.billingLabel && <p className={styles.fieldHint}>{capabilities.billingLabel}</p>}
                      {directBlocker && <p role="status" className={styles.blockerStatus} data-tone={directBlocker.tone}>直接套用：{directBlocker.message}</p>}
                      {llmBlocker && <p role="status" className={styles.blockerStatus} data-tone={llmBlocker.tone}>生成文案：{llmBlocker.message}</p>}
                      {pendingRun && requestUnknown && (
                        <div className={`${styles.callout} ${styles.calloutWarning}`} role="alert">
                          <span>这次请求的结果还未确认。先查询，未查到后才能按原请求号重试。</span>
                          <button className={styles.quietButton} type="button" disabled={working} onClick={() => void queryRequest(pendingRun.requestId)}>查询这次请求</button>
                          {notice.includes('暂未查到') && <button className={styles.quietButton} type="button" disabled={working} onClick={() => void submitRun(pendingRun.mode, true)}>按原请求重试</button>}
                        </div>
                      )}
                    </section>
                  </div>
                  <section className={styles.previewColumn} aria-label="模块结果">
                    <div className={styles.resultTabs} role="tablist" aria-label="提示词和视频结果">
                      <button type="button" role="tab" aria-selected={resultTab === 'prompt'} onClick={() => setResultTab('prompt')}>提示词</button>
                      <button type="button" role="tab" aria-selected={resultTab === 'video'} onClick={() => setResultTab('video')}>视频</button>
                    </div>
                    {resultTab === 'prompt' ? (
                      moduleRun ? <VideoPromptResult key={moduleRun.id} run={moduleRun} userId={userId} busy={working} onContinue={text => void continueGeneration(moduleRun, text)} onRegenerate={() => void submitRun('llm')} onHistory={() => setView('prompts')} />
                      : <div className={styles.emptyState}>暂无文案结果</div>
                    ) : (
                      <div className={styles.resultPanel}>
                        {(runs.filter((run) => run.draftId === activeDraft.id)).map((run) => (
                          <article className={styles.runCard} key={run.id}>
                            <div className={styles.runCardHeader}><span className={`${styles.status} ${statusClass(run.status)}`}>文案{statusLabel(run.status)}</span><RelativeTime value={run.createdAt} /></div>
                            <p className={styles.fieldHint}>{videoSummary(run, activeRunDetail)}</p>
                            <p className={styles.runPrompt}>{run.prompt || (run.status === 'uncertain' ? '上游结果待核对，请先查询记录。' : '尚无可展示的提示词结果。')}</p>
                            <div className={styles.promptTools}>
                              <button className={styles.listAction} type="button" onClick={() => void openRun(run)}>查看记录</button>
                              {run.status === 'succeeded' && <button className={styles.listAction} type="button" onClick={() => void openRun(run)}>编辑文案后继续</button>}
                            </div>
                          </article>
                        ))}
                        {!runs.some((run) => run.draftId === activeDraft.id) && <div className={styles.emptyState}><Film size={20} /><strong>还没有关联记录</strong><span>文案记录与视频生成分开；继续到生成页后才会提交视频。</span></div>}
                      </div>
                    )}
                  </section>
                </div>
              </>
            ) : activeTemplate ? (
              <TemplateOverview
                template={activeTemplate}
                detail={templateDetail}
                busy={templateDetailBusy || templateEditBusy}
                conflict={templateConflict?.id === activeTemplate.id && templateConflict.source === activeTemplate.source}
                onReloadConflict={() => void reloadConflictedTemplate()}
                onApply={() => void applyTemplate(activeTemplate)}
                onEdit={() => { setTemplateConflict(null); beginTemplateEdit(activeTemplate); }}
                onPublish={() => void publishTemplate(activeTemplate)}
                onArchive={() => void archiveTemplate(activeTemplate)}
                onBack={() => navigate({ templateId: null, templateSource: null })}
              />
            ) : (
              <div className={styles.emptyState}><FolderOpen size={22} /><h2>选择一个模板，或新建空白模块</h2><p>模板会填入有限的字段和推荐素材位置。空白模块可以直接写提示词，保存后下次继续。</p><button className={styles.primaryButton} type="button" onClick={() => void createBlankDraft()} disabled={working}><Plus size={15} />新建空白模块</button></div>
            )
          ) : (
            activeRunDetail ? (
              <RunDetailPanel
                userId={userId}
                detail={activeRunDetail}
                busy={working || detailBusy}
                copying={copyingRunId === activeRunDetail.run.id}
                onCopyToDraft={() => void copyRunToDraft(activeRunDetail)}
                onContinue={text => void continueGeneration(activeRunDetail.run, text)}
                onCancel={() => void cancelRun(activeRunDetail.run)}
                onRefresh={() => void refreshRunDetail(activeRunDetail.run)}
              />
            ) : detailBusy ? (
              <div className={styles.emptyState}><LoaderCircle size={22} /><h2>正在读取历史记录</h2><p>已保留列表位置，可以返回后继续浏览。</p></div>
            ) : detailError ? (
              <div className={`${styles.callout} ${styles.calloutError}`} role="alert"><span>{detailError}</span><button className={styles.quietButton} type="button" onClick={() => navigate({ runId: null })}>返回列表</button></div>
            ) : (
              <div className={styles.emptyState}><Film size={22} /><h2>{view === 'prompts' ? '选择一条提示词记录' : '选择一条视频结果'}</h2><p>记录会按账号权限加载；失败和待确认状态会保留，未知结果先查再决定是否重试。</p></div>
            )
          )}
        </main>
      </div>

      {pickerOpen && activeDraft && <UploadedImagePicker open target="assets" title="添加模板素材" confirmLabel="添加到模板素材区" purpose={`video-template-${pickerSlotKey || 'all'}`} currentCount={activeDraft.assets.length} currentAssetIds={assetIds} maxSelection={pickerSelectionCapacity} acceptedTypes={pickerSlot?.types} onClose={() => { setPickerOpen(false); setPickerSlotKey(null); }} onUploadFile={uploadFile} onConfirm={async (_ids, selected) => addAssets(selected || [], pickerSlotKey)} />}

      {templateEdit && (
        <div ref={templateEditBackdropRef} className={styles.dialogBackdrop} role="presentation" onClick={(event) => event.stopPropagation()}>
          <section ref={templateEditDialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="template-edit-title">
            <h2 id="template-edit-title">编辑模板草稿</h2>
            {templateConflict?.id === templateEdit.id && <div className={`${styles.callout} ${styles.calloutWarning}`} role="alert"><span>服务器上的模板已更新。当前输入仍保留；重新载入会放弃这些编辑。</span><button className={styles.quietButton} type="button" disabled={templateEditBusy} onClick={() => void reloadConflictedTemplate()}>载入最新版本</button></div>}
            <div className={styles.field}><label htmlFor="studio-template-name">模板名称</label><input id="studio-template-name" value={templateEdit.name} maxLength={120} onChange={(event) => setTemplateEdit((current) => current ? { ...current, name: event.target.value } : current)} /></div>
            <div className={styles.field}><label htmlFor="studio-template-group-name">用途分组</label><input id="studio-template-group-name" value={templateEdit.groupName} maxLength={80} onChange={(event) => setTemplateEdit((current) => current ? { ...current, groupName: event.target.value } : current)} /></div>
            <div className={styles.field}><label htmlFor="studio-template-description">说明</label><textarea id="studio-template-description" value={templateEdit.description || ''} maxLength={500} onChange={(event) => setTemplateEdit((current) => current ? { ...current, description: event.target.value } : current)} /></div>
            <div className={styles.field}><label htmlFor="studio-template-instruction">固定要求</label><textarea id="studio-template-instruction" value={templateEdit.recipe?.instruction || ''} maxLength={5000} onChange={(event) => setTemplateEdit((current) => current ? { ...current, recipe: { ...(current.recipe || { fields: [], assetSlots: [], defaultParameters: {} }), instruction: event.target.value } } : current)} /></div>
            <span className={styles.fieldHint}>字段、素材槽位和推荐参数沿用当前配方；修改配方结构由现有模板维护权限控制。</span>
            <div className={styles.dialogFooter}><button className={styles.quietButton} type="button" disabled={templateEditBusy} onClick={closeTemplateEditor}>取消</button><button className={styles.primaryButton} type="button" disabled={templateEditBusy || Boolean(templateConflict?.id === templateEdit.id) || !templateEdit.name.trim()} onClick={() => void saveTemplateEdit()}>{templateEditBusy ? '保存中' : '保存模板草稿'}</button></div>
          </section>
        </div>
      )}
      {contextEditor && <VideoContextEditor key={contextEditor.draftId || 'global'} draftId={contextEditor.draftId} onClose={() => setContextEditor(null)} />}

      {createTemplateOpen && activeDraft && (
        <div ref={createTemplateBackdropRef} className={styles.dialogBackdrop} role="presentation" onClick={(event) => event.stopPropagation()}>
          <section ref={createTemplateDialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="template-create-title">
            <h2 id="template-create-title">另存为个人模板</h2>
            <p className={styles.fieldHint}>只保存到当前账号；不会发布给其他人，也不会复制素材的所有权。</p>
            <div className={styles.field}><label htmlFor="studio-new-template-name">模板名称</label><input id="studio-new-template-name" value={newTemplateName} maxLength={120} onChange={(event) => setNewTemplateName(event.target.value)} /></div>
            <div className={styles.field}><label htmlFor="studio-new-template-group">用途分组</label><input id="studio-new-template-group" value={newTemplateGroup} maxLength={80} onChange={(event) => setNewTemplateGroup(event.target.value)} /></div>
            <div className={styles.field}><label htmlFor="studio-new-template-instruction">固定要求 · 必填</label><textarea id="studio-new-template-instruction" value={newTemplateInstruction} maxLength={5000} onChange={(event) => setNewTemplateInstruction(event.target.value)} placeholder="用于说明套用此模板时始终遵循的要求" /></div>
            <div className={styles.dialogFooter}><button className={styles.quietButton} type="button" disabled={createTemplateBusy} onClick={() => setCreateTemplateOpen(false)}>取消</button><button className={styles.primaryButton} type="button" disabled={createTemplateBusy || !newTemplateInstruction.trim()} onClick={() => void createPersonalTemplate()}>{createTemplateBusy ? '正在保存' : '保存个人模板'}</button></div>
          </section>
        </div>
      )}
    </section>
  ))}</>;
}

function TemplateOverview({
  template, detail, busy, conflict, onReloadConflict, onApply, onEdit, onPublish, onArchive, onBack,
}: {
  template: StudioTemplateDto;
  detail: StudioTemplateDetailResponse | null;
  busy: boolean;
  conflict: boolean;
  onReloadConflict: () => void;
  onApply: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onBack: () => void;
}) {
  const recipe = template.recipe;
  const isLegacy = template.applyMode === 'legacy-route';
  return (
    <>
      <div className={styles.contentHeader}>
        <div><h2>{template.name || '未命名模板'}</h2><p>{template.description || '暂无说明'} · {template.groupName || '未分组'} · {isLegacy ? '旧版模板' : template.version ? `版本 V${template.version.number}` : '尚未发布'}</p></div>
        <div className={styles.headerActions}>
          {template.status !== 'archived' && <ContentReactions contentKey={`${template.source === 'legacy' ? 'legacy_template' : 'video_template'}:${template.id}`} />}
          <button className={styles.quietButton} type="button" onClick={onBack}>返回模板列表</button>
          {!isLegacy && template.canManage && <button className={styles.quietButton} type="button" onClick={onEdit}><Settings size={15} />模块上下文</button>}
          {!isLegacy && template.canPublish && <button className={styles.primaryButton} type="button" disabled={busy || !recipe} title={!recipe ? '模板配方尚未完成' : '发布当前版本'} onClick={onPublish}>发布版本</button>}
          {!isLegacy && template.canManage && template.status !== 'archived' && <button className={`${styles.quietButton} ${styles.dangerButton}`} type="button" disabled={busy} onClick={onArchive}><Archive size={15} />停用模板</button>}
          <button className={styles.primaryButton} type="button" disabled={!isLegacy && (busy || template.status === 'archived' || !recipe)} onClick={onApply}>{isLegacy ? '在原模板生成页使用' : busy ? '处理中' : '用此模板新建模块'}</button>
        </div>
      </div>
      {conflict && <div className={`${styles.callout} ${styles.calloutWarning}`} role="alert"><span>模板已在其他操作中更新；当前发布或停用操作没有覆盖新版本。</span><button className={styles.quietButton} type="button" disabled={busy} onClick={onReloadConflict}>载入最新版本</button></div>}
      {template.owner && <div className={styles.ownerLine}><span>模板所有者</span><UserIdentityBadge size="sm" user={{ name: template.owner.displayName, avatar_url: template.owner.avatarUrl }} /></div>}
      {isLegacy ? (
        <div className={styles.callout}>
          <span>此旧版模板继续由原生成页处理，以保留原素材绑定与分段设置；不会转换为新的模块配方。</span>
        </div>
      ) : !recipe ? <div className={styles.calloutWarning}>模板尚无可用配方，不能直接套用或发布。</div> : (
        <div className={styles.templateRecipe}>
          <h3>模板内容</h3>
          {recipe.fields.map((field) => <div className={styles.slotRow} key={field.key}><span>{field.label}{'required' in field && field.required ? ' · 必填' : ''}</span><span>{field.type === 'select' ? field.options.join(' / ') : field.type}</span></div>)}
          {recipe.assetSlots.map((slot) => <div className={styles.slotRow} key={slot.key}><span>{slot.label}{slot.required ? ' · 必填' : ''}</span><span>{slot.role === 'first' ? '首帧' : slot.role === 'last' ? '尾帧' : '参考素材'} · {slot.types.join('、')}</span></div>)}
          {recipe.fields.length === 0 && recipe.assetSlots.length === 0 && <span className={styles.fieldHint}>无额外字段或素材槽位。</span>}
        </div>
      )}
      {!isLegacy && template.canManage && (
        <section className={styles.templateRecipe} aria-label="模板版本">
          <h3>版本记录</h3>
          {detail?.versions.map((version) => (
            <div className={styles.slotRow} key={version.id}>
              <span>V{version.number} · <RelativeTime value={version.createdAt} /></span>
              {version.createdBy && <UserIdentityBadge size="sm" user={{ name: version.createdBy.displayName, avatar_url: version.createdBy.avatarUrl }} />}
            </div>
          ))}
          {!detail && <span className={styles.fieldHint}>{busy ? '正在读取版本' : '版本详情暂不可用。'}</span>}
        </section>
      )}
    </>
  );
}

function RunTaskPoster({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(!src);
  useEffect(() => setFailed(!src), [src]);
  if (failed || !src) return <div className={styles.assetEmpty}>暂无截图/预览不可用</div>;
  return <img src={src} alt="视频任务缩略图" loading="lazy" onError={() => setFailed(true)} style={{ display: 'block', width: 'min(360px, 100%)', aspectRatio: '16 / 9', objectFit: 'cover', background: 'oklch(0.13 0.006 170)' }} />;
}

function RunDetailPanel({
  detail, userId, busy, copying, onCopyToDraft, onContinue, onCancel, onRefresh,
}: {
  detail: RunDetail;
  userId: string;
  busy: boolean;
  copying: boolean;
  onCopyToDraft: () => void;
  onContinue: (prompt: string) => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const { run, snapshot, tasks } = detail;
  const [previewTask, setPreviewTask] = useState<RunDetail['tasks'][number] | null>(null);
  const playableTasks = tasks.filter((task) => Boolean(task.playUrl));
  const activePreviewIndex = previewTask ? playableTasks.findIndex((task) => task.taskId === previewTask.taskId) : -1;
  const owner = snapshot.owner;
  const failedRunSummary = run.error ? '可以复用当时输入，调整后再次处理。' : '失败原因暂未提供。';
  return (
    <>
      <div className={styles.contentHeader}>
        <div><h2>{run.mode === 'llm' ? '提示词记录' : '直接使用记录'}</h2><p>{snapshot.input.name || '未命名模块'} · 修订记录 {run.id.slice(0, 8)} · <RelativeTime value={run.createdAt} /></p></div>
        <div className={styles.headerActions}>
          <button className={styles.quietButton} type="button" disabled={busy} onClick={onRefresh}>刷新状态</button>
          {run.status === 'queued' && <button className={`${styles.quietButton} ${styles.dangerButton}`} type="button" disabled={busy} onClick={onCancel}>取消排队任务</button>}
          <button className={`${styles.quietButton} sd2-loading-surface`} data-busy={copying} type="button" disabled={busy} title="只新建模块并复用输入，不自动生成或扣费" onClick={onCopyToDraft}>{copying ? '正在新建模块' : '用此输入新建模块'}</button>
        </div>
      </div>
      <div className={styles.ownerLine}><span className={`${styles.status} ${statusClass(run.status)}`}>文案{statusLabel(run.status)}</span><span>{snapshot.sourceRunId ? '最终文案' : run.mode === 'llm' ? '文案生成' : '直接使用'}</span>{snapshot.templateVersion && <span>{snapshot.templateVersion.templateName} · V{snapshot.templateVersion.versionNumber || '未知'}</span>}{owner && <UserIdentityBadge size="sm" user={{ name: owner.displayName, username: owner.username, avatar_url: owner.avatarUrl }} />}</div>
      {snapshot.sourceRunId && <a className={styles.calloutLink} href={`/template-studio?type=video&view=prompts&runId=${encodeURIComponent(snapshot.sourceRunId)}`}>查看原始文案</a>}
      {run.status === 'uncertain' && <div className={`${styles.callout} ${styles.calloutWarning}`} role="status"><strong>结果待确认。</strong><span>目前不能确认上游是否已处理；请先刷新或联系管理员核对，不要直接重复提交。</span></div>}
      {run.status === 'failed' && <div className={`${styles.callout} ${styles.calloutError}`} role="status"><strong>本次处理失败。</strong><span>{run.error || failedRunSummary}</span></div>}
      <VideoPromptResult key={run.id} run={run} userId={userId} busy={busy} onContinue={onContinue} />
      <section className={styles.templateRecipe}>
        <h3>当时填写的内容</h3>
        {Object.entries(snapshot.input.values).map(([key, value]) => <div className={styles.slotRow} key={key}><span>{key}</span><span>{typeof value === 'string' ? value : JSON.stringify(value)}</span></div>)}
        {Object.keys(snapshot.input.values).length === 0 && <span className={styles.fieldHint}>没有额外表单字段。</span>}
      </section>
      <section className={styles.templateRecipe}>
        <h3>相关视频任务</h3>
        <p className={styles.fieldHint}>{videoSummary(run, detail)}</p>
        {tasks.map((task) => (
          <article className={styles.runCard} key={task.taskId}>
            <RunTaskPoster key={task.thumbnailUrl || 'no-cover'} src={task.thumbnailUrl} />
            {task.status === 'succeeded' && <ContentReactions contentKey={`video_task:${task.taskId}`} />}
            <div className={styles.taskRow}><span>视频状态</span><span>{videoTaskStage(task).label}</span></div>
            <div className={styles.taskRow}><RelativeTime value={task.createdAt} /><span className={styles.promptTools}>
              {task.playUrl && <button className={styles.iconButton} type="button" title="预览视频" aria-label={`预览任务 ${task.taskId}`} onClick={() => setPreviewTask(task)}><Eye size={16} /></button>}
              <a href={task.playUrl || task.downloadUrl || `/tasks/${encodeURIComponent(task.taskId)}`} target={task.playUrl || task.downloadUrl ? '_blank' : undefined} rel={task.playUrl || task.downloadUrl ? 'noreferrer' : undefined}>{task.playUrl ? '打开视频' : task.downloadUrl ? '下载视频' : '查看任务'}</a>
            </span></div>
          </article>
        ))}
        {tasks.length === 0 && <div className={styles.assetEmpty}>还没有关联视频任务。</div>}
      </section>
      {previewTask?.playUrl && <MediaPreview
        src={previewTask.playUrl}
        type="video"
        title="视频任务预览"
        poster={previewTask.thumbnailUrl || undefined}
        contentKey={`video_task:${previewTask.taskId}`}
        previewKey={previewTask.taskId}
        details={<div><span>{videoTaskStage(previewTask).label}</span>{previewTask.status === 'succeeded' && <ContentReactions contentKey={`video_task:${previewTask.taskId}`} />}</div>}
        hasNavigation={playableTasks.length > 1}
        onPrevious={activePreviewIndex > 0 ? () => setPreviewTask(playableTasks[activePreviewIndex - 1]) : undefined}
        onNext={activePreviewIndex >= 0 && activePreviewIndex < playableTasks.length - 1 ? () => setPreviewTask(playableTasks[activePreviewIndex + 1]) : undefined}
        onClose={() => setPreviewTask(null)}
      />}
    </>
  );
}
