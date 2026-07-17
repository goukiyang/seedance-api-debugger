'use client';

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import type {
  GenerationMode,
  VideoRatio,
  VideoDuration,
  VideoResolution,
  AssetCollection,
  WorkspaceAssetItem,
} from '@/types';
import { checkPrompt } from '@/components/PromptChecker';
import { useWorkspace } from '@/lib/hooks/useWorkspace';
import { ImageSetToolbar } from '@/components/ImageSetToolbar';
import { ReferenceStrip } from '@/components/ReferenceStrip';
import { PromptEditor } from '@/components/PromptEditor';
import type { PromptMentionCandidate } from '@/components/PromptMentionPopover';
import { ComposerStatusLine } from '@/components/ComposerStatusLine';
import { ComposerActionBar } from '@/components/ComposerActionBar';
import { ErrorTranslator } from '@/components/ErrorTranslator';
import { ReferenceAlbumPicker } from '@/components/ReferenceAlbumPicker';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { calculateEstimatedCostClient } from '@/lib/pricing-client';
import { taskDetailHref } from '@/lib/navigation/return-to';
import type { GenerationDefaults } from '@/lib/preferences/generation';
import type { VolcengineIpModelOption } from '@/lib/integrations/volcengine-ip-models';
import type { SerializedGenerationTemplate, TemplateModuleKey, TemplateModuleUsage } from '@/lib/templates/workbench';
import type { AgentPlan } from '@/lib/agent-plans/template-plans';
import { TemplateEditorDrawer } from '@/components/templates/TemplateEditorDrawer';
import { Bot, FileJson, Settings2 } from 'lucide-react';

const DEFAULT_GENERATION_MODE: GenerationMode = 'all_in_one_reference';
const DEFAULT_RATIO: VideoRatio = '16:9';
const DEFAULT_DURATION: VideoDuration = 5;
const DEFAULT_RESOLUTION: VideoResolution = '480p';
const MAX_REFS = 9;
const MAX_PROMPT_CHARS = 2000;
const TEMPLATE_MODIFIERS = ['更科技', '更快节奏', '更品牌', '更产品', '更情绪化', '更克制'];
const TEMPLATE_WORKBENCH_PREFS_KEY = 'seedance_template_workbench_preferences_v1';

const TEMPLATE_MODULE_LABELS: Record<TemplateModuleKey, string> = {
  character: '角色',
  logo: '标志',
  style: '风格',
  camera: '镜头',
};

type ModuleBuilderType = 'auto' | 'character' | 'logo' | 'style' | 'camera' | 'rule' | 'asset_rule' | 'temporal' | 'prompt_format';
type ResolvedModuleBuilderType = Exclude<ModuleBuilderType, 'auto'>;

const MODULE_BUILDER_OPTIONS: Array<{ value: ModuleBuilderType; label: string; hint: string }> = [
  { value: 'auto', label: '自动判断', hint: '让 Agent 按描述分类' },
  { value: 'character', label: '角色', hint: 'IP、人物、吉祥物' },
  { value: 'logo', label: 'Logo', hint: '标志、字标、品牌露出' },
  { value: 'style', label: '风格', hint: '视觉风格、材质、调色' },
  { value: 'camera', label: '镜头', hint: '景别、运镜、节奏' },
  { value: 'rule', label: '规则', hint: 'MUST / FORBID / SUGGEST' },
  { value: 'asset_rule', label: '素材带规则', hint: '图片素材用途与约束' },
  { value: 'temporal', label: 'Temporal 分段', hint: '时间段、镜头段落' },
  { value: 'prompt_format', label: '提示词格式', hint: '复用视频生成 skills' },
];

const MODULE_BUILDER_TYPE_LABELS: Record<ResolvedModuleBuilderType, string> = {
  character: '角色模块',
  logo: 'Logo模块',
  style: '风格模块',
  camera: '镜头模块',
  rule: '规则模块',
  asset_rule: '素材带规则模块',
  temporal: 'Temporal分段模块',
  prompt_format: '提示词格式模块',
};

const DEFAULT_MODULE_BUILDER_RULES = [
  '不要只生成自然语言描述，必须输出结构化模块。',
  '必须区分 prompt_required / context_only / validation_only。',
  '必须区分 MUST / FORBID / SUGGEST / CONTEXT。',
  '如果是图片素材，必须判断它是角色、Logo、风格、镜头、产品还是反例。',
  '如果缺少关键信息，必须先追问，不要直接生成。',
  '输出结果必须可保存为系统模块。',
].join('\n');

const VIDEO_PROMPT_FORMAT_BLOCK = {
  source: 'sd2-video-generate skill + 通用视频提示词格式',
  format: [
    '(创意名编号)',
    '【开场方式】，【空间/背景】，【主体】为视觉核心。主任务：【最终观众看到什么/记住什么】。限制：【禁止项】。',
    '时间 / 景别 / 运镜 / 内容',
    '(end)',
  ],
  shotFields: ['时间', '景别', '运镜', '内容'],
  rules: [
    '首行创意名最多两个中文字符加三位数字，例如 (弹力001)。',
    '先写总述，再拆镜头。',
    '每一镜只写一个核心动作。',
    '时间必须连续、不重叠，结尾落到目标总时长。',
    '每个分镜必须包含景别和运镜。',
    '内容写可拍画面，不写抽象评价。',
    '禁止项只放在总述限制里，正文默认使用正向画面描述。',
  ],
};

type TemplateWorkbenchPreferences = {
  selectedTemplateId?: string;
  modifiers?: string[];
};

interface PolledTask {
  id: string;
  local_status: string;
  provider_status: string | null;
  result_video_url: string | null;
  error_message: string | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
}

interface ReferenceAlbumOption {
  id: string;
  name: string;
  image_count: number;
  album_type: string;
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null };
  project?: { name: string } | null;
  permissions?: { use?: boolean; edit?: boolean };
}

type MuskIntegrationConfig = {
  enabled: boolean;
  ready: boolean;
  base_url: string;
  default_model: string;
  api_key_configured: boolean;
};

function inferSingleReferenceAlbum(assets: WorkspaceAssetItem[]): { id: string; name: string } | null {
  if (assets.length === 0) return null;

  const firstAlbumId = assets[0].referenceAlbumId;
  const firstAlbumName = assets[0].referenceAlbumName;
  if (!firstAlbumId || !firstAlbumName) return null;

  const allFromSameAlbum = assets.every((asset) => {
    return asset.referenceAlbumId === firstAlbumId && asset.referenceAlbumName === firstAlbumName;
  });

  return allFromSameAlbum ? { id: firstAlbumId, name: firstAlbumName } : null;
}

function dedupeReferenceAlbums(albums: ReferenceAlbumOption[]): ReferenceAlbumOption[] {
  const seen = new Set<string>();
  return albums.filter((album) => {
    if (album.image_count <= 0) return false;
    const key = album.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function appendReferenceMarkers(value: string, labels: string[]): string {
  if (labels.length === 0) return value;
  const markers = labels.map((label) => `@${label}`).join(' ');
  const separator = value.length === 0 || /\s$/.test(value) ? '' : ' ';
  return `${value}${separator}${markers}`;
}

function formatReferenceTokens(labels: string[]): string {
  return labels.map((label) => `@${label}`).join(' ');
}

function readTemplateWorkbenchPreferences(): TemplateWorkbenchPreferences {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TEMPLATE_WORKBENCH_PREFS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as TemplateWorkbenchPreferences;
  } catch {
    return {};
  }
}

function writeTemplateWorkbenchPreferences(patch: TemplateWorkbenchPreferences) {
  if (typeof window === 'undefined') return;
  const current = readTemplateWorkbenchPreferences();
  window.localStorage.setItem(TEMPLATE_WORKBENCH_PREFS_KEY, JSON.stringify({ ...current, ...patch }));
}

function initialTemplateModifiers() {
  const stored = readTemplateWorkbenchPreferences().modifiers;
  return Array.isArray(stored) && stored.length > 0
    ? stored.filter((modifier) => TEMPLATE_MODIFIERS.includes(modifier)).slice(0, TEMPLATE_MODIFIERS.length)
    : ['更科技'];
}

function moduleUsage(template: SerializedGenerationTemplate, key: TemplateModuleKey): TemplateModuleUsage {
  return template.module_bindings.module_usage?.[key] === 'reference' ? 'reference' : 'required';
}

function templateModuleItems(template: SerializedGenerationTemplate) {
  return (Object.keys(TEMPLATE_MODULE_LABELS) as TemplateModuleKey[])
    .map((key) => {
      const value = template.module_bindings[key];
      if (!value) return null;
      return {
        key,
        label: TEMPLATE_MODULE_LABELS[key],
        value,
        usage: moduleUsage(template, key),
      };
    })
    .filter((item): item is { key: TemplateModuleKey; label: string; value: string; usage: TemplateModuleUsage } => Boolean(item));
}

function resolveModuleBuilderType(intent: string, selectedType: ModuleBuilderType): ResolvedModuleBuilderType {
  if (selectedType !== 'auto') return selectedType;
  const text = intent.toLowerCase();
  if (/提示词|prompt|格式|分镜|景别|运镜/.test(text)) return 'prompt_format';
  if (/logo|标志|字标|品牌露出/.test(text)) return 'logo';
  if (/角色|人物|ip|吉祥物|兔|猫|形象/.test(text)) return 'character';
  if (/风格|质感|色彩|调色|材质|氛围/.test(text)) return 'style';
  if (/镜头|景别|运镜|推入|拉远|横移|跟随/.test(text)) return 'camera';
  if (/素材|图片|参考图|反例|绑定/.test(text)) return 'asset_rule';
  if (/时间|分段|temporal|段落|节奏/.test(text)) return 'temporal';
  return 'rule';
}

function moduleTargetForType(moduleType: ResolvedModuleBuilderType): string {
  if (moduleType === 'asset_rule') return 'asset';
  if (moduleType === 'prompt_format') return 'prompt';
  if (moduleType === 'temporal') return 'timeline';
  return moduleType;
}

function createModuleBuilderDraft(params: {
  intent: string;
  selectedType: ModuleBuilderType;
  rules: string;
  template: SerializedGenerationTemplate | null;
  duration: VideoDuration;
}) {
  const moduleType = resolveModuleBuilderType(params.intent, params.selectedType);
  const target = moduleTargetForType(moduleType);
  const cleanIntent = params.intent.trim().replace(/\s+/g, ' ');
  const fallbackName = MODULE_BUILDER_TYPE_LABELS[moduleType];
  const moduleName = cleanIntent ? cleanIntent.slice(0, 26) : fallbackName;
  const templateModules = params.template ? templateModuleItems(params.template) : [];
  const priority = moduleType === 'prompt_format' || moduleType === 'rule' ? 90 : 80;

  const promptBlock = moduleType === 'prompt_format'
    ? VIDEO_PROMPT_FORMAT_BLOCK
    : {
        description: cleanIntent || `为当前模板新增${fallbackName}。`,
        usage: moduleType === 'asset_rule'
          ? '识别素材用途并生成绑定规则。'
          : moduleType === 'temporal'
            ? `按 ${params.duration}s 生成连续分段和镜头节奏。`
            : '作为模板生成时的可注入提示词块。',
        adminReview: '管理员必须审核、修改并保存后才会进入正式模块库。',
      };

  return {
    moduleType,
    moduleName,
    source: 'module_builder_agent_draft',
    status: 'draft_requires_admin_review',
    templateContext: params.template ? {
      templateId: params.template.id,
      templateName: params.template.name,
      version: params.template.version,
      modules: templateModules.map((item) => ({
        key: item.key,
        name: item.value,
        usage: item.usage === 'required' ? 'prompt_required' : 'context_only',
      })),
      activeRuleCount: params.template.rules.filter((rule) => rule.status === 'active').length,
      assetCount: params.template.assets.filter((asset) => asset.status === 'active').length,
    } : null,
    builderRules: {
      defaultRules: DEFAULT_MODULE_BUILDER_RULES.split('\n'),
      sessionRules: params.rules.split('\n').map((rule) => rule.trim()).filter(Boolean),
    },
    assetBinding: moduleType === 'asset_rule'
      ? {
          assetId: null,
          usage: 'auto_classify_asset_role',
          requiresAssetReview: true,
        }
      : null,
    promptBlock,
    rules: [
      {
        ruleType: 'MUST',
        injectionMode: 'prompt_required',
        target,
        content: moduleType === 'prompt_format'
          ? '必须按通用视频提示词格式输出：创意名编号、总述、连续分镜行和 (end)。'
          : `必须把“${cleanIntent || fallbackName}”转成可注入的结构化模块。`,
        priority,
      },
      {
        ruleType: 'FORBID',
        injectionMode: 'validation_only',
        target,
        content: '禁止只输出自然语言说明，禁止跳过管理员确认直接入库。',
        priority: 100,
      },
      {
        ruleType: 'SUGGEST',
        injectionMode: moduleType === 'rule' ? 'validation_only' : 'context_only',
        target,
        content: '缺少关键素材、角色、Logo、目标时先追问，再生成最终模块。',
        priority: 70,
      },
    ],
    injectionMode: moduleType === 'rule' ? 'validation_only' : 'prompt_required',
    priority,
  };
}

interface Props {
  collections: AssetCollection[];
  initialSettings?: GenerationDefaults | null;
  lockedSettings?: {
    sourceLabel: string;
    ratio?: VideoRatio | null;
    duration?: VideoDuration | null;
    resolution?: VideoResolution | null;
  } | null;
  reuseDraft?: {
    taskId: string;
    reuseKey: number;
    prompt: string;
    generationMode: GenerationMode;
    ratio: VideoRatio;
    duration: VideoDuration;
    resolution: VideoResolution;
    seed: number;
    generateAudio: boolean;
    returnLastFrame: boolean;
    watermark: boolean;
    resolutionApprovalConfirmed?: boolean;
  } | null;
  onCollectionLoad: (collectionId: string) => Promise<void>;
  onCollectionSave: (name: string) => Promise<void>;
  onCollectionNew: (name: string) => Promise<void>;
  require1080pApproval: boolean;
  onSubmit: (params: {
    prompt: string;
    generationMode: GenerationMode;
    ratio: VideoRatio;
    duration: VideoDuration;
    resolution: VideoResolution;
    seed: number;
    generateAudio: boolean;
    returnLastFrame: boolean;
    watermark: boolean;
    resolutionApprovalConfirmed: boolean;
    referenceImageIds: string[];
    referenceVideoUrls: string[];
    referenceAudioUrls: string[];
    templateId: string | null;
    agentRunId: string | null;
    selectedAgentPlanKey: string | null;
    agentPromptSnapshot: string | null;
    finalPromptSnapshot: string | null;
    promptUserEdited: boolean;
    model: string | null;
  }) => Promise<void>;
  submitError: string | null;
  submitErrorDebug?: object | null;
  isSubmitting: boolean;
  result: {
    id: string;
    provider_task_id: string;
    prompt_rendered?: string;
    reference_image_notice?: string | null;
  } | null;
  polledResult: PolledTask | null;
  isPolling: boolean;
  onReset: () => void;
  selectedVideoCardId?: string | null;
  canManageTemplates?: boolean;
  templateMode?: 'disabled' | 'workbench';
  initialTemplateId?: string | null;
  resultReturnTo?: string;
  submitDisabledReason?: string | null;
  modelLabel?: string;
  modelOptions?: VolcengineIpModelOption[];
}

export function GenerationComposer({
  collections,
  initialSettings,
  lockedSettings,
  onCollectionLoad,
  onCollectionSave,
  onCollectionNew,
  onSubmit,
  submitError,
  submitErrorDebug,
  isSubmitting,
  result,
  polledResult,
  isPolling,
  onReset,
  reuseDraft,
  require1080pApproval,
  selectedVideoCardId,
  canManageTemplates = false,
  templateMode = 'disabled',
  initialTemplateId = null,
  resultReturnTo = '/generate',
  submitDisabledReason = null,
  modelLabel = 'Seedance 2.0',
  modelOptions = [],
}: Props) {
  const workspace = useWorkspace();
  const templateEnabled = templateMode === 'workbench';
  const appliedReuseDraftRef = React.useRef<string | null>(null);
  const appliedInitialSettingsRef = React.useRef(false);
  const appliedTemplateDefaultsRef = React.useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [showUploadedImagePicker, setShowUploadedImagePicker] = useState(false);
  const [referenceAlbums, setReferenceAlbums] = useState<ReferenceAlbumOption[]>([]);
  const [currentReferenceAlbumId, setCurrentReferenceAlbumId] = useState<string | null>(null);
  const [currentReferenceAlbumName, setCurrentReferenceAlbumName] = useState<string | null>(null);
  const [mentionNotice, setMentionNotice] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SerializedGenerationTemplate[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [demandText, setDemandText] = useState('');
  const [selectedModifiers, setSelectedModifiers] = useState<string[]>(initialTemplateModifiers);
  const [agentPlans, setAgentPlans] = useState<AgentPlan[]>([]);
  const [selectedPlanKey, setSelectedPlanKey] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentPromptSnapshot, setAgentPromptSnapshot] = useState<string | null>(null);
  const [promptUserEdited, setPromptUserEdited] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [templateSaveBusy, setTemplateSaveBusy] = useState(false);
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [moduleBuilderType, setModuleBuilderType] = useState<ModuleBuilderType>('auto');
  const [moduleBuilderIntent, setModuleBuilderIntent] = useState('');
  const [moduleBuilderRules, setModuleBuilderRules] = useState(DEFAULT_MODULE_BUILDER_RULES);
  const [moduleBuilderDraft, setModuleBuilderDraft] = useState('');
  const [moduleBuilderNotice, setModuleBuilderNotice] = useState<string | null>(null);
  const [moduleBuilderBusy, setModuleBuilderBusy] = useState(false);
  const [moduleBuilderAgentRunId, setModuleBuilderAgentRunId] = useState<string | null>(null);
  const [muskConfig, setMuskConfig] = useState<MuskIntegrationConfig | null>(null);
  const [muskConfigLoading, setMuskConfigLoading] = useState(false);
  const [muskConfigError, setMuskConfigError] = useState<string | null>(null);
  const pendingMentionRequestRef = React.useRef<{
    source: 'history' | 'album';
    resolve: (insertText: string | null) => void;
  } | null>(null);

  // Composer 内部状态（受控于参数 props 透传）
  const [generationMode, setGenerationMode] = useState<GenerationMode>(DEFAULT_GENERATION_MODE);
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<VideoRatio>(DEFAULT_RATIO);
  const [duration, setDuration] = useState<VideoDuration>(DEFAULT_DURATION);
  const [resolution, setResolution] = useState<VideoResolution>(DEFAULT_RESOLUTION);
  const [seed, setSeed] = useState<number>(-1);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [returnLastFrame, setReturnLastFrame] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [selectedModel, setSelectedModel] = useState(modelOptions[0]?.id || '');
  const [resolutionApprovalConfirmed, setResolutionApprovalConfirmed] = useState(false);

  const need1080pApproval = require1080pApproval && resolution === '1080p';
  const lockReason = lockedSettings ? `来自视频卡「${lockedSettings.sourceLabel}」的交付规格` : undefined;
  const selectedTemplate = useMemo(() => {
    if (!templateEnabled) return null;
    return templates.find((template) => template.id === selectedTemplateId) || templates[0] || null;
  }, [selectedTemplateId, templateEnabled, templates]);

  // ============================================================================
  // Validation
  // ============================================================================

  const validation = useMemo(() => {
    return checkPrompt(prompt, workspace.assets.length, duration);
  }, [prompt, workspace.assets.length, duration]);

  const submitBlocker = useMemo(() => {
    if (!prompt.trim()) return '请填写提示词';

    // 检查上传状态
    const hasUploading = Object.values(workspace.uploadStatuses).some((s) => s === 'uploading');
    if (hasUploading) return '素材上传中，请稍候';

    const hasFailed = Object.values(workspace.uploadStatuses).some((s) => s === 'failed');
    if (hasFailed) return '存在上传失败的素材，请移除后重试';

    if (generationMode === 'first_last_frame' && workspace.assets.length < 2) {
      return `首尾帧模式至少需要 2 张素材，当前 ${workspace.assets.length} 张`;
    }
    if (generationMode === 'smart_multi_frame' && workspace.assets.length < 3) {
      return `智能多帧模式至少需要 3 张素材，当前 ${workspace.assets.length} 张`;
    }
    if (!validation.valid) {
      return `提示词引用了图${validation.maxMissing}，但当前只有 ${workspace.assets.length} 张素材`;
    }
    if (need1080pApproval && !resolutionApprovalConfirmed) {
      return '1080p 生成需要先确认审批通过。';
    }
    return null;
  }, [prompt, workspace.uploadStatuses, workspace.assets.length, generationMode, need1080pApproval, resolutionApprovalConfirmed, validation]);

  const composerStatus = useMemo(() => {
    if (isSubmitting) {
      return { message: '提交中...', tone: 'progress' as const };
    }
    if (mentionNotice) {
      return { message: mentionNotice, tone: 'hint' as const };
    }
    if (!prompt.trim()) {
      return {
        message: '请填写提示词',
        tone: 'hint' as const,
      };
    }
    if (submitBlocker) {
      const isUploading = submitBlocker.includes('上传中');
      return { message: submitBlocker, tone: isUploading ? 'progress' as const : 'error' as const };
    }
    if (submitDisabledReason) {
      return { message: submitDisabledReason, tone: 'hint' as const };
    }
    return { message: null, tone: 'ok' as const };
  }, [isSubmitting, mentionNotice, prompt, submitBlocker, submitDisabledReason]);

  const canPressSubmit = !isSubmitting && !submitDisabledReason && !(need1080pApproval && !resolutionApprovalConfirmed);

  const estimatedPoints = useMemo(() => {
    return calculateEstimatedCostClient(resolution, duration);
  }, [resolution, duration]);

  const activeRules = useMemo(() => {
    return selectedTemplate?.rules.filter((rule) => rule.status === 'active') || [];
  }, [selectedTemplate]);

  const templateAssets = useMemo(() => {
    return selectedTemplate?.assets.filter((asset) => asset.status === 'active') || [];
  }, [selectedTemplate]);
  const selectedTemplateModules = useMemo(() => {
    return selectedTemplate ? templateModuleItems(selectedTemplate) : [];
  }, [selectedTemplate]);
  const requiredModuleCount = selectedTemplateModules.filter((item) => item.usage === 'required').length;
  const referenceModuleCount = selectedTemplateModules.filter((item) => item.usage === 'reference').length;

  // 已按即梦 @图片N 规则引用的图片序号
  const usedRefs = useMemo(() => {
    return validation.referencedFigures.map((n) => `图片${n}`);
  }, [validation.referencedFigures]);

  const referenceLabels = useMemo(() => {
    return workspace.assets.map((asset, index) => {
      const label = `图片${index + 1}`;
      const titleParts = [
        label,
        asset.fileName,
        asset.referenceAlbumName ? `来自 ${asset.referenceAlbumName}` : null,
      ].filter(Boolean);
      return {
        label,
        title: titleParts.join(' · '),
      };
    });
  }, [workspace.assets]);

  const muskReady = muskConfig?.ready === true;
  const moduleBuilderDisabled = moduleBuilderBusy || muskConfigLoading || !muskReady;
  const muskStatusText = muskConfigLoading
    ? '正在检查 LLM 配置...'
    : muskReady
      ? `LLM 已就绪：${muskConfig?.default_model || 'gpt-5.4'}`
      : muskConfigError || 'LLM 未配置，无法生成模块或模板。';

  const mentionCandidates = useMemo<PromptMentionCandidate[]>(() => {
    const sourceDisabled = workspace.assets.length >= MAX_REFS;
    return [
      {
        id: 'create-subject',
        type: 'action',
        action: 'create_subject',
        label: '创建主体',
        description: '主体库下一批开放，当前先用图集复用',
      },
      ...workspace.assets.map((asset, index): PromptMentionCandidate => {
        const label = `图片${index + 1}`;
        const titleParts = [
          asset.fileName,
          asset.referenceAlbumName ? `来自 ${asset.referenceAlbumName}` : null,
        ].filter(Boolean);
        return {
          id: `image:${asset.assetId}`,
          type: 'image',
          token: `@${label}`,
          label,
          title: asset.fileName,
          description: titleParts.join(' · '),
          thumbnailUrl: asset.thumbnailUrl || asset.originalUrl,
          referenceImageId: asset.referenceImageId,
          assetId: asset.assetId,
        };
      }),
      {
        id: 'source:history',
        type: 'source',
        source: 'history',
        label: '从历史图片选择',
        description: sourceDisabled ? `已达 ${MAX_REFS} 张上限` : '选择曾经上传过的图片',
        disabled: sourceDisabled,
      },
      {
        id: 'source:album',
        type: 'source',
        source: 'album',
        label: '从图集选择',
        description: sourceDisabled ? `已达 ${MAX_REFS} 个上限` : '我的图集、项目图集、公共图集',
        disabled: sourceDisabled,
      },
    ];
  }, [workspace.assets]);

  const currentReferenceImageIds = useMemo(() => {
    return workspace.assets
      .map((asset) => asset.referenceImageId)
      .filter((id): id is string => Boolean(id));
  }, [workspace.assets]);

  const refreshReferenceAlbums = useCallback(async () => {
    try {
      const res = await fetch('/api/reference-albums?scope=all');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '图集读取失败');
      setReferenceAlbums(dedupeReferenceAlbums(data.albums || []));
    } catch {
      setReferenceAlbums([]);
    }
  }, []);

  const loadTemplates = useCallback(async (preferredTemplateId?: string | null) => {
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const res = await fetch('/api/templates');
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '模板读取失败');
      const items = (data.templates || []) as SerializedGenerationTemplate[];
      setTemplates(items);
      setSelectedTemplateId((current) => {
        const preferred = preferredTemplateId || current || readTemplateWorkbenchPreferences().selectedTemplateId;
        return preferred && items.some((template) => template.id === preferred) ? preferred : items[0]?.id || null;
      });
      if (preferredTemplateId && !items.some((template) => template.id === preferredTemplateId)) {
        setTemplateError('选择的模板不可用，已切换到默认模板');
      }
      return items;
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : '模板读取失败');
      return [];
    } finally {
      setTemplateLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshReferenceAlbums();
  }, [refreshReferenceAlbums]);

  useEffect(() => {
    if (!templateEnabled) return;
    void loadTemplates(initialTemplateId);
  }, [initialTemplateId, loadTemplates, templateEnabled]);

  useEffect(() => {
    if (!templateEnabled || !canManageTemplates) return;
    let cancelled = false;
    setMuskConfigLoading(true);
    setMuskConfigError(null);
    fetch('/api/admin/integrations/musk', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || '读取 Musk API 配置失败');
        if (!cancelled) setMuskConfig(data.config || null);
      })
      .catch((error) => {
        if (!cancelled) {
          setMuskConfig(null);
          setMuskConfigError(error instanceof Error ? error.message : '读取 Musk API 配置失败');
        }
      })
      .finally(() => {
        if (!cancelled) setMuskConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageTemplates, templateEnabled]);

  useEffect(() => {
    if (!templateEnabled || !selectedTemplateId) return;
    writeTemplateWorkbenchPreferences({ selectedTemplateId });
  }, [selectedTemplateId, templateEnabled]);

  useEffect(() => {
    if (!templateEnabled) return;
    writeTemplateWorkbenchPreferences({ modifiers: selectedModifiers });
  }, [selectedModifiers, templateEnabled]);

  useEffect(() => {
    if (!templateEnabled || !selectedTemplate || reuseDraft) return;
    if (appliedTemplateDefaultsRef.current === selectedTemplate.id) return;
    appliedTemplateDefaultsRef.current = selectedTemplate.id;
    if (selectedTemplate.defaults.ratio) setRatio(selectedTemplate.defaults.ratio as VideoRatio);
    if (selectedTemplate.defaults.duration) setDuration(selectedTemplate.defaults.duration as VideoDuration);
    if (selectedTemplate.defaults.resolution) setResolution(selectedTemplate.defaults.resolution as VideoResolution);
  }, [reuseDraft, selectedTemplate, templateEnabled]);

  useEffect(() => {
    if (!mentionNotice) return;
    const timer = window.setTimeout(() => setMentionNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [mentionNotice]);

  useEffect(() => {
    if (workspace.assets.length === 0) return;
    const inferredAlbum = inferSingleReferenceAlbum(workspace.assets);
    setCurrentReferenceAlbumId(inferredAlbum?.id ?? null);
    setCurrentReferenceAlbumName(inferredAlbum?.name ?? null);
  }, [workspace.assets]);

  useEffect(() => {
    const reuseKey = reuseDraft ? `${reuseDraft.taskId}:${reuseDraft.reuseKey}` : null;
    if (!reuseDraft || appliedReuseDraftRef.current === reuseKey) return;
    appliedReuseDraftRef.current = reuseKey;
    setPrompt(reuseDraft.prompt);
    setGenerationMode(reuseDraft.generationMode);
    setRatio(reuseDraft.ratio);
    setDuration(reuseDraft.duration);
    setResolution(reuseDraft.resolution);
    setSeed(reuseDraft.seed);
    setGenerateAudio(true);
    setReturnLastFrame(reuseDraft.returnLastFrame);
    setWatermark(reuseDraft.watermark);
    setResolutionApprovalConfirmed(
      require1080pApproval && reuseDraft.resolution === '1080p' ? Boolean(reuseDraft.resolutionApprovalConfirmed) : false,
    );
    void workspace.refresh();
  }, [reuseDraft, require1080pApproval, workspace]);

  useEffect(() => {
    if (!initialSettings || appliedInitialSettingsRef.current || reuseDraft) return;
    appliedInitialSettingsRef.current = true;
    setGenerationMode(initialSettings.generationMode);
    setRatio(initialSettings.ratio);
    setDuration(initialSettings.duration);
    setResolution(initialSettings.resolution);
    setSeed(-1);
    setGenerateAudio(initialSettings.generateAudio);
    setReturnLastFrame(initialSettings.returnLastFrame);
    setWatermark(initialSettings.watermark);
    setResolutionApprovalConfirmed(false);
  }, [initialSettings, reuseDraft]);

  useEffect(() => {
    if (!lockedSettings) return;
    if (lockedSettings.ratio) setRatio(lockedSettings.ratio);
    if (lockedSettings.duration) setDuration(lockedSettings.duration);
    if (lockedSettings.resolution) setResolution(lockedSettings.resolution);
  }, [
    lockedSettings?.sourceLabel,
    lockedSettings?.ratio,
    lockedSettings?.duration,
    lockedSettings?.resolution,
  ]);

  useEffect(() => {
    if (!need1080pApproval) {
      setResolutionApprovalConfirmed(false);
    }
  }, [need1080pApproval]);

  useEffect(() => {
    const fallbackModel = modelOptions[0]?.id || '';
    if (!fallbackModel) {
      if (selectedModel) setSelectedModel('');
      return;
    }
    if (!modelOptions.some((option) => option.id === selectedModel)) {
      setSelectedModel(fallbackModel);
    }
  }, [modelOptions, selectedModel]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleSubmit = useCallback(async () => {
    if (submitBlocker || submitDisabledReason || isSubmitting) return;
    await onSubmit({
      prompt,
      generationMode,
      ratio,
      duration,
      resolution,
      seed,
      generateAudio,
      returnLastFrame,
      watermark,
      resolutionApprovalConfirmed: need1080pApproval ? resolutionApprovalConfirmed : false,
      referenceImageIds: workspace.assets
        .filter((asset) => asset.type === 'image')
        .map((asset) => asset.referenceImageId)
        .filter((id): id is string => Boolean(id)),
      referenceVideoUrls: workspace.assets
        .filter((asset) => asset.type === 'video' && Boolean(asset.originalUrl))
        .map((asset) => asset.originalUrl),
      referenceAudioUrls: workspace.assets
        .filter((asset) => asset.type === 'audio' && Boolean(asset.originalUrl))
        .map((asset) => asset.originalUrl),
      templateId: selectedTemplate?.id || null,
      agentRunId,
      selectedAgentPlanKey: selectedPlanKey,
      agentPromptSnapshot,
      finalPromptSnapshot: prompt,
      promptUserEdited,
      model: selectedModel || null,
    });
  }, [
    submitBlocker,
    submitDisabledReason,
    isSubmitting,
    onSubmit,
    prompt,
    generationMode,
    ratio,
    duration,
    resolution,
    seed,
    generateAudio,
    returnLastFrame,
    watermark,
    need1080pApproval,
    resolutionApprovalConfirmed,
    workspace.assets,
    selectedTemplate?.id,
    agentRunId,
    selectedPlanKey,
    agentPromptSnapshot,
    promptUserEdited,
    selectedModel,
  ]);

  const handlePromptChange = useCallback((nextPrompt: string) => {
    setPrompt(nextPrompt);
    if (agentPromptSnapshot !== null && nextPrompt !== agentPromptSnapshot) {
      setPromptUserEdited(true);
    }
  }, [agentPromptSnapshot]);

  const toggleModifier = useCallback((modifier: string) => {
    setSelectedModifiers((current) => {
      return current.includes(modifier)
        ? current.filter((item) => item !== modifier)
        : [...current, modifier];
    });
  }, []);

  const handleSelectTemplate = useCallback((templateId: string | null) => {
    setSelectedTemplateId(templateId);
    setAgentPlans([]);
    setSelectedPlanKey(null);
    setAgentRunId(null);
    setAgentPromptSnapshot(null);
  }, []);

  const handleGeneratePlans = useCallback(async () => {
    if (!selectedTemplate) {
      setAgentError('请先选择模板');
      return;
    }
    if (!demandText.trim()) {
      setAgentError('请填写本次视频需求');
      return;
    }
    setAgentBusy(true);
    setAgentError(null);
    try {
      const res = await fetch('/api/agent/template-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: selectedTemplate.id,
          video_card_id: selectedVideoCardId || null,
          input: {
            text: demandText.trim(),
            modifiers: selectedModifiers,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '方案生成失败');
      const plans = Array.isArray(data.plans) ? data.plans as AgentPlan[] : [];
      setAgentPlans(plans);
      setAgentRunId(data.agent_run_id || null);
      const nextPlanKey = data.recommended_plan_key || plans[0]?.key || null;
      setSelectedPlanKey(nextPlanKey);
      const nextPrompt = plans.find((plan) => plan.key === nextPlanKey)?.prompt || data.prompt || '';
      setAgentPromptSnapshot(nextPrompt);
      setPromptUserEdited(false);
      setPrompt(nextPrompt);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : '方案生成失败');
    } finally {
      setAgentBusy(false);
    }
  }, [demandText, selectedModifiers, selectedTemplate, selectedVideoCardId]);

  const handleGenerateModuleBuilderDraft = useCallback(async () => {
    if (!canManageTemplates) {
      setModuleBuilderNotice('只有管理员可以生成或编辑模块草稿。');
      return;
    }
    if (!selectedTemplate) {
      setModuleBuilderNotice('请先选择模板。');
      return;
    }
    if (!moduleBuilderIntent.trim()) {
      setModuleBuilderNotice('请先描述要创建的模块。');
      return;
    }
    if (muskConfigLoading || !muskReady) {
      setModuleBuilderNotice(muskStatusText);
      return;
    }

    setModuleBuilderBusy(true);
    setModuleBuilderNotice(null);
    setModuleBuilderAgentRunId(null);
    try {
      const res = await fetch('/api/templates/module-builder/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: selectedTemplate.id,
          module_type: moduleBuilderType,
          intent: moduleBuilderIntent,
          session_rules: moduleBuilderRules,
          context_asset_ids: currentReferenceImageIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Module Builder 生成失败');

      setModuleBuilderAgentRunId(data.agent_run_id || null);
      if (data.needs_clarification) {
        setModuleBuilderDraft(JSON.stringify({
          needsClarification: true,
          questions: data.questions || [],
          agentRunId: data.agent_run_id || null,
        }, null, 2));
        setModuleBuilderNotice(`LLM 需要追问：${(data.questions || [])[0] || '请补充关键信息'}`);
        return;
      }

      setModuleBuilderDraft(JSON.stringify(data.draft || {
        error: 'LLM 没有返回可保存草稿',
        validationErrors: data.validation_errors || [],
        agentRunId: data.agent_run_id || null,
      }, null, 2));
      setModuleBuilderNotice(
        Array.isArray(data.validation_errors) && data.validation_errors.length > 0
          ? `结构化校验未通过：${data.validation_errors.join('；')}`
          : '已由真实 LLM 生成结构化模块草稿，保存前仍需管理员审核。',
      );
    } catch (error) {
      setModuleBuilderNotice(error instanceof Error ? error.message : 'Module Builder 生成失败');
    } finally {
      setModuleBuilderBusy(false);
    }
  }, [
    canManageTemplates,
    currentReferenceImageIds,
    moduleBuilderIntent,
    moduleBuilderRules,
    moduleBuilderType,
    muskConfigLoading,
    muskReady,
    muskStatusText,
    selectedTemplate,
  ]);

  const handleCopyModuleBuilderDraft = useCallback(async () => {
    if (!moduleBuilderDraft) {
      setModuleBuilderNotice('请先生成模块草稿。');
      return;
    }
    try {
      await navigator.clipboard.writeText(moduleBuilderDraft);
      setModuleBuilderNotice('模块草稿 JSON 已复制。');
    } catch {
      setModuleBuilderNotice('复制失败，请直接选中预览内容复制。');
    }
  }, [moduleBuilderDraft]);

  const handleSelectPlan = useCallback((plan: AgentPlan) => {
    setSelectedPlanKey(plan.key);
    setAgentPromptSnapshot(plan.prompt);
    setPromptUserEdited(false);
    setPrompt(plan.prompt);
  }, []);

  const handleSaveTemplate = useCallback(async (payload: Record<string, unknown>) => {
    if (!selectedTemplate) return;
    setTemplateSaveBusy(true);
    setTemplateSaveError(null);
    try {
      const res = await fetch(`/api/templates/${selectedTemplate.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '模板保存失败');
      await loadTemplates(data.template?.id || selectedTemplate.id);
      setTemplateDrawerOpen(false);
    } catch (error) {
      setTemplateSaveError(error instanceof Error ? error.message : '模板保存失败');
    } finally {
      setTemplateSaveBusy(false);
    }
  }, [loadTemplates, selectedTemplate]);

  const handleLoadCollection = useCallback(async (collectionId: string) => {
    if (workspace.assets.length > 0) {
      const ok = window.confirm('加载图集将替换当前素材，确定继续？');
      if (!ok) return;
    }
    await onCollectionLoad(collectionId);
  }, [workspace.assets.length, onCollectionLoad]);

  const handleSaveCollection = useCallback(async (name: string) => {
    await onCollectionSave(name);
  }, [onCollectionSave]);

  const handleNewCollection = useCallback(async (name: string) => {
    await onCollectionNew(name);
  }, [onCollectionNew]);

  const handleRemove = useCallback(async (assetId: string) => {
    await workspace.removeAsset(assetId);
  }, [workspace]);

  const handleReorder = useCallback(async (newOrder: Array<{ assetId: string; sortOrder: number }>) => {
    await workspace.reorderAssets(newOrder);
  }, [workspace]);

  const handleReplace = useCallback(async (assetId: string, file: File) => {
    await workspace.replaceAsset(assetId, file);
    await refreshReferenceAlbums();
  }, [workspace, refreshReferenceAlbums]);

  const handlePreview = useCallback((url: string) => {
    setPreviewUrl(url);
  }, []);

  const resolvePendingMentionRequest = useCallback((insertText: string | null) => {
    if (!pendingMentionRequestRef.current) return;
    pendingMentionRequestRef.current.resolve(insertText);
    pendingMentionRequestRef.current = null;
  }, []);

  const handleMentionPickerClose = useCallback((source: 'history' | 'album') => {
    if (source === 'history') setShowUploadedImagePicker(false);
    if (source === 'album') setShowAlbumPicker(false);
    if (pendingMentionRequestRef.current?.source === source) {
      resolvePendingMentionRequest(null);
    }
  }, [resolvePendingMentionRequest]);

  const addReferenceImagesAndGetLabels = useCallback(async (referenceImageIds: string[]) => {
    const uniqueReferenceImageIds = uniqueStrings(referenceImageIds);
    if (uniqueReferenceImageIds.length === 0) return [];

    const existingLabelByReferenceId = new Map<string, string>();
    workspace.assets.forEach((asset, index) => {
      if (asset.referenceImageId) {
        existingLabelByReferenceId.set(asset.referenceImageId, `图片${index + 1}`);
      }
    });

    const idsToAdd = uniqueReferenceImageIds.filter((id) => !existingLabelByReferenceId.has(id));
    const availableSlots = Math.max(0, MAX_REFS - workspace.assets.length);
    if (idsToAdd.length > availableSlots) {
      throw new Error(`单次生成最多选择 ${MAX_REFS} 个参考素材，当前还可新增 ${availableSlots} 个`);
    }

    const labelByReferenceId = new Map(existingLabelByReferenceId);
    idsToAdd.forEach((id, index) => {
      labelByReferenceId.set(id, `图片${workspace.assets.length + index + 1}`);
    });

    const labelsToInsert = uniqueReferenceImageIds
      .map((id) => labelByReferenceId.get(id))
      .filter((label): label is string => Boolean(label));

    if (idsToAdd.length > 0) {
      await workspace.addReferenceImages(idsToAdd);
    }
    await refreshReferenceAlbums();
    return labelsToInsert;
  }, [workspace, refreshReferenceAlbums]);

  const handleAddReferenceImages = useCallback(async (referenceImageIds: string[]) => {
    const labelsToInsert = await addReferenceImagesAndGetLabels(referenceImageIds);
    const insertText = formatReferenceTokens(labelsToInsert);
    if (pendingMentionRequestRef.current?.source === 'album') {
      resolvePendingMentionRequest(insertText || null);
      return;
    }
    const nextPrompt = appendReferenceMarkers(prompt, labelsToInsert);
    if (nextPrompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`提示词最多 ${MAX_PROMPT_CHARS} 字，无法自动插入 @图片 标记`);
    }
    setPrompt((currentPrompt) => {
      const next = appendReferenceMarkers(currentPrompt, labelsToInsert);
      return next.length <= MAX_PROMPT_CHARS ? next : currentPrompt;
    });
  }, [addReferenceImagesAndGetLabels, prompt, resolvePendingMentionRequest]);

  const addUploadedAssetsAndGetLabels = useCallback(async (assetIds: string[]) => {
    const uniqueAssetIds = uniqueStrings(assetIds);
    if (uniqueAssetIds.length === 0) return [];

    const existingLabelByAssetId = new Map<string, string>();
    workspace.assets.forEach((asset, index) => {
      existingLabelByAssetId.set(asset.assetId, `图片${index + 1}`);
    });

    const idsToAdd = uniqueAssetIds.filter((id) => !existingLabelByAssetId.has(id));
    const availableSlots = Math.max(0, MAX_REFS - workspace.assets.length);
    if (idsToAdd.length > availableSlots) {
      throw new Error(`单次生成最多选择 ${MAX_REFS} 个参考素材，当前还可新增 ${availableSlots} 个`);
    }

    const labelByAssetId = new Map(existingLabelByAssetId);
    idsToAdd.forEach((id, index) => {
      labelByAssetId.set(id, `图片${workspace.assets.length + index + 1}`);
    });
    const labelsToInsert = uniqueAssetIds
      .map((id) => labelByAssetId.get(id))
      .filter((label): label is string => Boolean(label));

    if (idsToAdd.length > 0) {
      await workspace.addAssets(idsToAdd);
      await refreshReferenceAlbums();
    }
    return labelsToInsert;
  }, [workspace, refreshReferenceAlbums]);

  const handleAddUploadedAssets = useCallback(async (assetIds: string[]) => {
    const labelsToInsert = await addUploadedAssetsAndGetLabels(assetIds);
    const insertText = formatReferenceTokens(labelsToInsert);
    if (pendingMentionRequestRef.current?.source === 'history') {
      resolvePendingMentionRequest(insertText || null);
      return;
    }
    const nextPrompt = appendReferenceMarkers(prompt, labelsToInsert);
    if (nextPrompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`提示词最多 ${MAX_PROMPT_CHARS} 字，无法自动插入 @图片 标记`);
    }
    setPrompt((currentPrompt) => {
      const next = appendReferenceMarkers(currentPrompt, labelsToInsert);
      return next.length <= MAX_PROMPT_CHARS ? next : currentPrompt;
    });
  }, [addUploadedAssetsAndGetLabels, prompt, resolvePendingMentionRequest]);

  const handleMentionSelect = useCallback((candidate: PromptMentionCandidate) => {
    if (candidate.type === 'image') return candidate.token;
    if (candidate.type === 'action') {
      setMentionNotice('主体能力将在第二批开放；当前可以先用图集保存和复用参考素材。');
      return null;
    }
    if (candidate.disabled) return null;
    if (pendingMentionRequestRef.current) {
      pendingMentionRequestRef.current.resolve(null);
      pendingMentionRequestRef.current = null;
    }
    return new Promise<string | null>((resolve) => {
      pendingMentionRequestRef.current = { source: candidate.source, resolve };
      if (candidate.source === 'history') setShowUploadedImagePicker(true);
      if (candidate.source === 'album') setShowAlbumPicker(true);
    });
  }, []);

  const handleLoadReferenceAlbum = useCallback(async (albumId: string, albumName: string) => {
    if (workspace.assets.length > 0) {
      const ok = window.confirm('切换图集会替换当前参考素材列表，确定继续？');
      if (!ok) return;
    }
    await workspace.loadReferenceAlbum(albumId);
    setCurrentReferenceAlbumId(albumId);
    setCurrentReferenceAlbumName(albumName);
  }, [workspace]);

  const handleSaveCurrentAsReferenceAlbum = useCallback(async (name: string) => {
    if (workspace.assets.length === 0) throw new Error('当前没有可保存的参考素材');
    const albumId = await workspace.saveCurrentAsReferenceAlbum(name);
    setCurrentReferenceAlbumId(albumId);
    setCurrentReferenceAlbumName(name);
    await refreshReferenceAlbums();
  }, [workspace, refreshReferenceAlbums]);

  const handleCreateReferenceAlbum = useCallback(async (name: string) => {
    const albumId = await workspace.createReferenceAlbum(name);
    await workspace.clearAssets();
    setCurrentReferenceAlbumId(albumId);
    setCurrentReferenceAlbumName(name);
    await refreshReferenceAlbums();
  }, [workspace, refreshReferenceAlbums]);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <>
      <div className="generation-composer">
        {templateEnabled && (
        <section className="template-workbench" aria-label="模板驱动生成">
          <div className="template-workbench-header">
            <div>
              <span className="template-workbench-kicker">模板</span>
              <h2>{selectedTemplate?.name || '选择模板'}</h2>
              <p>{selectedTemplate?.description || '模板会自动带入角色、标志、风格、规则和提示词格式。'}</p>
            </div>
            <details className="template-switcher">
              <summary>
                <span>切换模板</span>
                <strong>{selectedTemplate?.name || (templateLoading ? '正在加载模板' : '暂无可用模板')}</strong>
              </summary>
              <div className="template-selector-list" role="listbox" aria-label="选择生成模板">
                {templates.map((template) => {
                  const active = selectedTemplate?.id === template.id;
                  const modules = templateModuleItems(template);
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className={active ? 'is-active' : ''}
                      onClick={() => handleSelectTemplate(template.id)}
                      disabled={templateLoading}
                      aria-selected={active}
                      role="option"
                    >
                      <strong>{template.name}</strong>
                      <span>{template.version} · {modules.length || 0} 个模块</span>
                    </button>
                  );
                })}
                {!templateLoading && templates.length === 0 && <span className="template-selector-empty">暂无可用模板</span>}
              </div>
            </details>
          </div>

          {templateError && <div className="template-workbench-message is-error">{templateError}</div>}

          {selectedTemplate && (
            <div className="template-loaded-grid">
              <div className="template-loaded-block">
                <span>模块</span>
                <strong>
                  {selectedTemplateModules.length > 0
                    ? selectedTemplateModules.map((item) => `${item.label}：${item.value}`).join(' / ')
                    : '未绑定'}
                </strong>
                {selectedTemplateModules.length > 0 && (
                  <small>{requiredModuleCount} 个强制插入，{referenceModuleCount} 个仅参考</small>
                )}
              </div>
              <div className="template-loaded-block">
                <span>规则</span>
                <strong>{activeRules.length} 条</strong>
              </div>
              <div className="template-loaded-block">
                <span>分段</span>
                <strong>{selectedTemplate.temporal.enabled ? `${selectedTemplate.temporal.segment}s` : '关闭'}</strong>
              </div>
              <div className="template-loaded-block">
                <span>素材</span>
                <strong>{templateAssets.length} 个</strong>
              </div>
            </div>
          )}

          <div className="template-flow-steps" aria-label="模板生成步骤">
            <span className={demandText.trim() ? 'is-done' : 'is-active'}>1. 输入需求</span>
            <span className={agentPlans.length > 0 ? 'is-done' : demandText.trim() ? 'is-active' : ''}>2. 选择方案</span>
            <span className={prompt.trim() ? 'is-active' : ''}>3. 提交生成</span>
          </div>

          <div className="template-demand-row">
            <label className="template-demand-field">
              <span>你想生成什么视频？</span>
              <textarea
                value={demandText}
                onChange={(event) => setDemandText(event.currentTarget.value)}
                placeholder="例如：做一个科技品牌宣传视频，突出新品发布、稳定标志和快速产品动线。"
                rows={4}
              />
            </label>
            <div className="template-modifier-panel">
              <span>风格调节</span>
              <div className="template-modifier-list">
                {TEMPLATE_MODIFIERS.map((modifier) => (
                  <button
                    key={modifier}
                    type="button"
                    className={selectedModifiers.includes(modifier) ? 'is-active' : ''}
                    onClick={() => toggleModifier(modifier)}
                  >
                    {modifier}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="template-plan-generate"
                onClick={handleGeneratePlans}
                disabled={agentBusy || !selectedTemplate || !demandText.trim()}
              >
                {agentBusy ? '生成中...' : '生成 4 个方案'}
              </button>
            </div>
          </div>

          {agentError && <div className="template-workbench-message is-error">{agentError}</div>}

          {agentPlans.length > 0 && (
            <div className="template-plan-grid" aria-label="Agent 生成方案">
              {agentPlans.map((plan) => (
                <article
                  key={plan.key}
                  className={`template-plan-card ${selectedPlanKey === plan.key ? 'is-selected' : ''}`}
                >
                  <button type="button" className="template-plan-card-main" onClick={() => handleSelectPlan(plan)}>
                    <span className="template-plan-thumb" aria-hidden="true">
                      <span>{plan.key}</span>
                      <small>{selectedTemplate?.temporal.enabled ? `${selectedTemplate.temporal.segment}s` : `${duration}s`}</small>
                    </span>
                    <span className="template-plan-card-copy">
                      <span className="template-plan-key">{plan.key}</span>
                      <strong>{plan.title}</strong>
                      <small>{plan.angle}</small>
                      <em>{plan.fit}</em>
                    </span>
                  </button>
                  <div className="template-plan-card-actions">
                    <button type="button" onClick={() => handleSelectPlan(plan)}>查看方案</button>
                    <button type="button" className="is-primary" onClick={() => handleSelectPlan(plan)}>使用此方案</button>
                  </div>
                  <ul className="template-plan-structure">
                    {plan.structure.slice(0, 3).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="template-plan-risk">注意：{plan.risk}</p>
                </article>
              ))}
            </div>
          )}

          <div className="template-prompt-preview">
            <div>
              <span>提示词预览</span>
              <strong>
                {selectedPlanKey ? `方案 ${selectedPlanKey}` : agentRunId ? '已生成方案' : '等待方案'}
                {promptUserEdited ? ' · 已编辑' : ''}
              </strong>
            </div>
            {agentPromptSnapshot && prompt !== agentPromptSnapshot && (
              <button
                type="button"
                onClick={() => {
                  setPrompt(agentPromptSnapshot);
                  setPromptUserEdited(false);
                }}
              >
                恢复 Agent 版本
              </button>
            )}
          </div>

          {canManageTemplates && (
            <details className="template-admin-tools">
              <summary>
                <span>管理员工具</span>
                <strong>{muskStatusText}</strong>
              </summary>
              <div className="template-workbench-admin-actions">
                <button
                  type="button"
                  className="template-workbench-admin-chip"
                  onClick={() => setTemplateDrawerOpen(true)}
                  disabled={!selectedTemplate}
                >
                  编辑模板
                </button>
                <a className="template-workbench-admin-link" href={agentRunId ? `/admin/agent-runs/${agentRunId}` : '/admin/agent-runs'}>
                  查看链路
                </a>
              </div>
              <section className={`template-llm-builder ${muskReady ? '' : 'is-locked'}`} aria-label="LLM 模板配置与模块生成器">
                <div className="template-llm-builder-head">
                  <div>
                    <span className="template-llm-builder-kicker">
                      <Bot size={14} aria-hidden="true" />
                      Module Builder Agent
                    </span>
                    <h3>新增模块 / 规则</h3>
                    <p>管理员描述模块用途，Agent 生成结构化草稿；保存前必须人工确认。</p>
                  </div>
                  <div className="template-llm-builder-actions">
                    <a href="/admin/integrations">
                      <Settings2 size={14} aria-hidden="true" />
                      API 设置
                    </a>
                    <button
                      type="button"
                      onClick={() => setTemplateDrawerOpen(true)}
                      disabled={!selectedTemplate}
                    >
                      <FileJson size={14} aria-hidden="true" />
                      高级编辑
                    </button>
                  </div>
                </div>
                {!muskReady && (
                  <p className="template-llm-builder-note is-warning">
                    {muskStatusText} 请先到 API 设置完成配置。
                  </p>
                )}

                <div className="template-llm-builder-grid">
                  <div className="template-llm-builder-inputs">
                    <label className="template-llm-builder-field">
                      <span>模块类型</span>
                      <select
                        value={moduleBuilderType}
                        onChange={(event) => setModuleBuilderType(event.currentTarget.value as ModuleBuilderType)}
                        disabled={moduleBuilderDisabled}
                      >
                        {MODULE_BUILDER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label} · {option.hint}</option>
                        ))}
                      </select>
                    </label>
                    <label className="template-llm-builder-field">
                      <span>描述要创建的模块或规则</span>
                      <textarea
                        value={moduleBuilderIntent}
                        onChange={(event) => setModuleBuilderIntent(event.currentTarget.value)}
                        placeholder="例如：我要新增一个兔子 IP 角色模块，它是白色兔子，性格活泼，要用于品牌宣传视频。"
                        rows={4}
                        disabled={moduleBuilderDisabled}
                      />
                    </label>
                    <details className="template-llm-builder-rules">
                      <summary>
                        LLM生成规则设定
                        <small>高级项，默认不用改。</small>
                      </summary>
                      <textarea
                        value={moduleBuilderRules}
                        onChange={(event) => setModuleBuilderRules(event.currentTarget.value)}
                        rows={7}
                        disabled={moduleBuilderDisabled}
                      />
                      <div className="template-llm-builder-rule-actions">
                        <button type="button" onClick={() => setModuleBuilderRules(DEFAULT_MODULE_BUILDER_RULES)} disabled={moduleBuilderDisabled}>
                          恢复默认规则
                        </button>
                        <button type="button" onClick={() => setModuleBuilderNotice('本次生成规则已保留在当前页面草稿中。')} disabled={moduleBuilderDisabled}>
                          保存当前生成规则
                        </button>
                      </div>
                    </details>
                    <div className="template-llm-builder-buttons">
                      <button
                        type="button"
                        className="is-primary"
                        onClick={handleGenerateModuleBuilderDraft}
                        disabled={moduleBuilderDisabled}
                      >
                        {moduleBuilderBusy ? 'LLM 生成中...' : moduleBuilderDraft ? '重新生成' : '生成模块草稿'}
                      </button>
                      <button type="button" onClick={handleCopyModuleBuilderDraft} disabled={!moduleBuilderDraft || moduleBuilderBusy}>
                        复制 JSON
                      </button>
                      {demandText.trim() && (
                        <button type="button" onClick={() => setModuleBuilderIntent(demandText.trim())} disabled={moduleBuilderDisabled}>
                          使用本次需求
                        </button>
                      )}
                      {moduleBuilderAgentRunId && (
                        <a href={`/admin/agent-runs/${moduleBuilderAgentRunId}`}>查看生成链路</a>
                      )}
                    </div>
                    {moduleBuilderNotice && <p className="template-llm-builder-note">{moduleBuilderNotice}</p>}
                  </div>

                  <div className="template-llm-builder-preview">
                    <div>
                      <span>生成结果预览</span>
                      <strong>{moduleBuilderDraft ? '结构化草稿' : '等待 LLM 生成'}</strong>
                    </div>
                    <pre>{moduleBuilderDraft || JSON.stringify({
                      moduleType: 'character',
                      moduleName: '兔子IP',
                      promptBlock: { description: '白色兔子IP角色，保持核心识别点。' },
                      rules: [
                        { ruleType: 'MUST', injectionMode: 'prompt_required', target: 'character', priority: 95 },
                        { ruleType: 'FORBID', injectionMode: 'validation_only', target: 'character', priority: 100 },
                      ],
                      status: 'draft_requires_admin_review',
                    }, null, 2)}</pre>
                  </div>
                </div>
              </section>
            </details>
          )}
        </section>
        )}

        {templateEnabled ? (
          <details className="template-advanced-panel">
            <summary>
              <span>参考素材和图集</span>
              <strong>{workspace.assets.length > 0 ? `${workspace.assets.length} 个参考素材` : '默认不使用参考素材'}</strong>
            </summary>
            <ImageSetToolbar
              collections={collections}
              onLoad={handleLoadCollection}
              onSave={handleSaveCollection}
              onNew={handleNewCollection}
              onOpenReferenceAlbums={() => setShowAlbumPicker(true)}
              referenceAlbums={referenceAlbums}
              currentReferenceAlbumId={currentReferenceAlbumId}
              currentReferenceAlbumName={currentReferenceAlbumName}
              onReferenceAlbumLoad={handleLoadReferenceAlbum}
              onReferenceAlbumSaveCurrent={handleSaveCurrentAsReferenceAlbum}
              onReferenceAlbumCreate={handleCreateReferenceAlbum}
              loading={workspace.loading}
            />
            <ReferenceStrip
              assets={workspace.assets}
              uploadStatuses={workspace.uploadStatuses}
              onUpload={workspace.uploadAsset}
              onRemove={handleRemove}
              onReorder={handleReorder}
              onReplace={handleReplace}
              onPreview={handlePreview}
              onOpenHistory={() => setShowUploadedImagePicker(true)}
              generationMode={generationMode}
              loading={workspace.loading}
            />
          </details>
        ) : (
          <>
            <ImageSetToolbar
              collections={collections}
              onLoad={handleLoadCollection}
              onSave={handleSaveCollection}
              onNew={handleNewCollection}
              onOpenReferenceAlbums={() => setShowAlbumPicker(true)}
              referenceAlbums={referenceAlbums}
              currentReferenceAlbumId={currentReferenceAlbumId}
              currentReferenceAlbumName={currentReferenceAlbumName}
              onReferenceAlbumLoad={handleLoadReferenceAlbum}
              onReferenceAlbumSaveCurrent={handleSaveCurrentAsReferenceAlbum}
              onReferenceAlbumCreate={handleCreateReferenceAlbum}
              loading={workspace.loading}
            />
            <ReferenceStrip
              assets={workspace.assets}
              uploadStatuses={workspace.uploadStatuses}
              onUpload={workspace.uploadAsset}
              onRemove={handleRemove}
              onReorder={handleReorder}
              onReplace={handleReplace}
              onPreview={handlePreview}
              onOpenHistory={() => setShowUploadedImagePicker(true)}
              generationMode={generationMode}
              loading={workspace.loading}
            />
          </>
        )}

        {templateEnabled ? (
          <details className="template-advanced-panel template-prompt-editor-panel">
            <summary>
              <span>查看 / 编辑最终提示词</span>
              <strong>{prompt.trim() ? (promptUserEdited ? '已手动编辑' : '已由方案生成') : '选择方案后自动生成'}</strong>
            </summary>
            <PromptEditor
              value={prompt}
              onChange={handlePromptChange}
              referenceLabels={referenceLabels}
              mentionCandidates={mentionCandidates}
              onMentionSelect={handleMentionSelect}
            />
          </details>
        ) : (
          <PromptEditor
            value={prompt}
            onChange={handlePromptChange}
            referenceLabels={referenceLabels}
            mentionCandidates={mentionCandidates}
            onMentionSelect={handleMentionSelect}
          />
        )}

        {/* 状态行 */}
        <ComposerStatusLine
          message={composerStatus.message}
          tone={composerStatus.tone}
          usedRefs={usedRefs}
          hasPrompt={prompt.trim().length > 0}
          hasAssets={workspace.assets.length > 0}
          hasBlockingUpload={Object.values(workspace.uploadStatuses).some((s) => s === 'uploading' || s === 'failed')}
        />

        {/* 错误 */}
        {submitError && (
          <div className="composer-error-wrap">
            <ErrorTranslator
              error={submitError}
              rawError={submitError}
              debugInfo={submitErrorDebug as Parameters<typeof ErrorTranslator>[0]['debugInfo']}
              onRetry={() => {}}
              onCopy={() => { navigator.clipboard.writeText(submitError); }}
            />
          </div>
        )}

        {need1080pApproval && (
          <label className="composer-resolution-approval">
            <input
              type="checkbox"
              checked={resolutionApprovalConfirmed}
              onChange={(event) => setResolutionApprovalConfirmed(event.currentTarget.checked)}
            />
            <span>
              我已确认审批中心存在有效 1080p 审批记录，允许直接生成
              <a href="/approvals" target="_blank" rel="noreferrer">查看审批</a>
            </span>
          </label>
        )}

        {/* 入队提示：短暂展示，不阻塞下一次生成 */}
        {result && (
          <div className="composer-queue-notice">
            <div className="composer-queue-copy">
              <span className="composer-queue-kicker">已加入队列</span>
              <strong>任务已创建，可以继续创建下一段</strong>
              <small>
                {polledResult?.id === result.id && ['succeeded', 'failed', 'cancelled'].includes(polledResult.local_status)
                  ? `当前状态：${polledResult.local_status === 'succeeded' ? '已完成' : polledResult.local_status === 'failed' ? '失败' : '已取消'}`
                  : isPolling
                    ? '系统正在后台查询生成进度，最近任务会自动更新。'
                    : '任务已提交，最近任务会继续显示进度。'}
              </small>
              {result.reference_image_notice && (
                <small>{result.reference_image_notice}</small>
              )}
            </div>
            <div className="composer-queue-actions">
              <a href={taskDetailHref(result.id, resultReturnTo)} className="composer-result-link">查看详情</a>
              <button type="button" className="composer-result-reset" onClick={onReset}>
                收起
              </button>
            </div>
          </div>
        )}

        {/* 参数栏 */}
        <ComposerActionBar
          generationMode={generationMode}
          ratio={ratio}
          duration={duration}
          resolution={resolution}
          points={estimatedPoints}
          canSubmit={canPressSubmit}
          isSubmitting={isSubmitting}
          onSubmit={handleSubmit}
          modelLabel={modelLabel}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onModeChange={setGenerationMode}
          onRatioChange={setRatio}
          onDurationChange={setDuration}
          onResolutionChange={setResolution}
          lockedRatio={Boolean(lockedSettings?.ratio)}
          lockedDuration={Boolean(lockedSettings?.duration)}
          lockedResolution={Boolean(lockedSettings?.resolution)}
          lockReason={lockReason}
          compactControls={templateEnabled}
        />
      </div>

      {/* 预览弹窗 */}
      {previewUrl && (
        <div
          className="composer-preview-backdrop"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="composer-preview-content" onClick={(e) => e.stopPropagation()}>
            <button
              className="composer-preview-close"
              onClick={() => setPreviewUrl(null)}
            >
              ×
            </button>
            {previewUrl.match(/\.(mp4|mov|webm)/i) ? (
              <video src={previewUrl} controls autoPlay className="composer-preview-media" />
            ) : (
              <img src={previewUrl} alt="预览" className="composer-preview-media" />
            )}
          </div>
        </div>
      )}

      <ReferenceAlbumPicker
        open={showAlbumPicker}
        currentCount={workspace.assets.length}
        currentReferenceImageIds={currentReferenceImageIds}
        onClose={() => handleMentionPickerClose('album')}
        onConfirm={handleAddReferenceImages}
      />

      <UploadedImagePicker
        open={showUploadedImagePicker}
        currentCount={workspace.assets.length}
        currentAssetIds={workspace.assets.map((asset) => asset.assetId)}
        onClose={() => handleMentionPickerClose('history')}
        onUploadFile={workspace.uploadAssetToHistory}
        onConfirm={handleAddUploadedAssets}
      />

      {templateEnabled && (
        <TemplateEditorDrawer
          open={templateDrawerOpen}
          template={selectedTemplate}
          saving={templateSaveBusy}
          error={templateSaveError}
          onClose={() => setTemplateDrawerOpen(false)}
          onSave={handleSaveTemplate}
        />
      )}
    </>
  );
}
