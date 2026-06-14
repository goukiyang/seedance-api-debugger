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
import type { SerializedGenerationTemplate } from '@/lib/templates/workbench';
import type { AgentPlan } from '@/lib/agent-plans/template-plans';
import { TemplateEditorDrawer } from '@/components/templates/TemplateEditorDrawer';

const DEFAULT_GENERATION_MODE: GenerationMode = 'all_in_one_reference';
const DEFAULT_RATIO: VideoRatio = '16:9';
const DEFAULT_DURATION: VideoDuration = 5;
const DEFAULT_RESOLUTION: VideoResolution = '480p';
const MAX_REFS = 9;
const MAX_PROMPT_CHARS = 2000;
const TEMPLATE_MODIFIERS = ['更科技', '更快节奏', '更品牌', '更产品', '更情绪化', '更克制'];

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
  project?: { name: string } | null;
  permissions?: { use?: boolean; edit?: boolean };
}

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
    const key = album.name.trim();
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
    templateId: string | null;
    agentRunId: string | null;
    selectedAgentPlanKey: string | null;
    agentPromptSnapshot: string | null;
    finalPromptSnapshot: string | null;
    promptUserEdited: boolean;
  }) => Promise<void>;
  submitError: string | null;
  submitErrorDebug?: object | null;
  isSubmitting: boolean;
  result: { id: string; provider_task_id: string; prompt_rendered?: string } | null;
  polledResult: PolledTask | null;
  isPolling: boolean;
  onReset: () => void;
  selectedVideoCardId?: string | null;
  canManageTemplates?: boolean;
  templateMode?: 'disabled' | 'workbench';
  initialTemplateId?: string | null;
  resultReturnTo?: string;
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
  const [selectedModifiers, setSelectedModifiers] = useState<string[]>(['更科技']);
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
    return { message: null, tone: 'ok' as const };
  }, [isSubmitting, mentionNotice, prompt, submitBlocker]);

  const canPressSubmit = !isSubmitting && !(need1080pApproval && !resolutionApprovalConfirmed);

  const estimatedPoints = useMemo(() => {
    return calculateEstimatedCostClient(resolution, duration);
  }, [resolution, duration]);

  const activeRules = useMemo(() => {
    return selectedTemplate?.rules.filter((rule) => rule.status === 'active') || [];
  }, [selectedTemplate]);

  const templateAssets = useMemo(() => {
    return selectedTemplate?.assets.filter((asset) => asset.status === 'active') || [];
  }, [selectedTemplate]);

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
        description: sourceDisabled ? `已达 ${MAX_REFS} 张上限` : '我的图集、项目图集、公共图集',
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
        const preferred = preferredTemplateId || current;
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

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleSubmit = useCallback(async () => {
    if (submitBlocker || isSubmitting) return;
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
        .map((asset) => asset.referenceImageId)
        .filter((id): id is string => Boolean(id)),
      templateId: selectedTemplate?.id || null,
      agentRunId,
      selectedAgentPlanKey: selectedPlanKey,
      agentPromptSnapshot,
      finalPromptSnapshot: prompt,
      promptUserEdited,
    });
  }, [
    submitBlocker,
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
      throw new Error(`单次生成最多选择 ${MAX_REFS} 张参考图，当前还可新增 ${availableSlots} 张`);
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
      throw new Error(`单次生成最多选择 ${MAX_REFS} 张参考图，当前还可新增 ${availableSlots} 张`);
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
      setMentionNotice('主体能力将在第二批开放；当前可以先用图集保存和复用参考图。');
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
      const ok = window.confirm('切换图集会替换当前参考图列表，确定继续？');
      if (!ok) return;
    }
    await workspace.loadReferenceAlbum(albumId);
    setCurrentReferenceAlbumId(albumId);
    setCurrentReferenceAlbumName(albumName);
  }, [workspace]);

  const handleSaveCurrentAsReferenceAlbum = useCallback(async (name: string) => {
    if (workspace.assets.length === 0) throw new Error('当前没有可保存的参考图');
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
              <span className="template-workbench-kicker">Template</span>
              <h2>{selectedTemplate?.name || '选择模板'}</h2>
              <p>{selectedTemplate?.description || '模板决定角色、Logo、风格、规则和分段策略。'}</p>
            </div>
            <div className="template-workbench-controls">
              <select
                value={selectedTemplate?.id || ''}
                onChange={(event) => {
                  setSelectedTemplateId(event.currentTarget.value || null);
                  setAgentPlans([]);
                  setSelectedPlanKey(null);
                  setAgentRunId(null);
                  setAgentPromptSnapshot(null);
                }}
                disabled={templateLoading || templates.length === 0}
                aria-label="选择生成模板"
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} {template.version}
                  </option>
                ))}
              </select>
              {canManageTemplates && (
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
              )}
            </div>
          </div>

          {templateError && <div className="template-workbench-message is-error">{templateError}</div>}

          {selectedTemplate && (
            <div className="template-loaded-grid">
              <div className="template-loaded-block">
                <span>模块</span>
                <strong>{[
                  selectedTemplate.module_bindings.character,
                  selectedTemplate.module_bindings.logo,
                  selectedTemplate.module_bindings.style,
                  selectedTemplate.module_bindings.camera,
                ].filter(Boolean).join(' / ') || '未绑定'}</strong>
              </div>
              <div className="template-loaded-block">
                <span>规则</span>
                <strong>{activeRules.length} 条</strong>
              </div>
              <div className="template-loaded-block">
                <span>分段</span>
                <strong>{selectedTemplate.temporal.enabled ? `${selectedTemplate.temporal.segment}s` : 'OFF'}</strong>
              </div>
              <div className="template-loaded-block">
                <span>素材</span>
                <strong>{templateAssets.length} 个</strong>
              </div>
            </div>
          )}

          <div className="template-demand-row">
            <label className="template-demand-field">
              <span>本次需求</span>
              <textarea
                value={demandText}
                onChange={(event) => setDemandText(event.currentTarget.value)}
                placeholder="例如：做一个科技品牌宣传视频，突出新品发布、稳定 Logo 和快速产品动线。"
                rows={3}
              />
            </label>
            <div className="template-modifier-panel">
              <span>快速调节</span>
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
                    <button type="button" onClick={() => handleSelectPlan(plan)}>查看 Prompt</button>
                    <button type="button" onClick={() => handleSelectPlan(plan)}>继续修改</button>
                    <button type="button" className="is-primary" onClick={() => handleSelectPlan(plan)}>生成此方案</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="template-prompt-preview">
            <div>
              <span>Prompt 预览</span>
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
        </section>
        )}

        {/* 图集工具条 */}
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

        {/* 缩略图行 */}
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

        {/* 提示词输入 */}
        <PromptEditor
          value={prompt}
          onChange={handlePromptChange}
          referenceLabels={referenceLabels}
          mentionCandidates={mentionCandidates}
          onMentionSelect={handleMentionSelect}
        />

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
          onModeChange={setGenerationMode}
          onRatioChange={setRatio}
          onDurationChange={setDuration}
          onResolutionChange={setResolution}
          lockedRatio={Boolean(lockedSettings?.ratio)}
          lockedDuration={Boolean(lockedSettings?.duration)}
          lockedResolution={Boolean(lockedSettings?.resolution)}
          lockReason={lockReason}
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
