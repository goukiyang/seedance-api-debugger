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

const DEFAULT_GENERATION_MODE: GenerationMode = 'all_in_one_reference';
const DEFAULT_RATIO: VideoRatio = '16:9';
const DEFAULT_DURATION: VideoDuration = 5;
const DEFAULT_RESOLUTION: VideoResolution = '480p';
const MAX_REFS = 9;
const MAX_PROMPT_CHARS = 2000;

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
  }) => Promise<void>;
  submitError: string | null;
  submitErrorDebug?: object | null;
  isSubmitting: boolean;
  result: { id: string; provider_task_id: string; prompt_rendered?: string } | null;
  polledResult: PolledTask | null;
  isPolling: boolean;
  onReset: () => void;
}

export function GenerationComposer({
  collections,
  initialSettings,
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
}: Props) {
  const workspace = useWorkspace();
  const appliedReuseDraftRef = React.useRef<string | null>(null);
  const appliedInitialSettingsRef = React.useRef(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [showUploadedImagePicker, setShowUploadedImagePicker] = useState(false);
  const [referenceAlbums, setReferenceAlbums] = useState<ReferenceAlbumOption[]>([]);
  const [currentReferenceAlbumId, setCurrentReferenceAlbumId] = useState<string | null>(null);
  const [currentReferenceAlbumName, setCurrentReferenceAlbumName] = useState<string | null>(null);
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [mentionNotice, setMentionNotice] = useState<string | null>(null);
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
        tone: hasAttemptedSubmit ? 'error' as const : 'hint' as const,
      };
    }
    if (submitBlocker) {
      const isUploading = submitBlocker.includes('上传中');
      return { message: submitBlocker, tone: isUploading ? 'progress' as const : 'error' as const };
    }
    return { message: null, tone: 'ok' as const };
  }, [hasAttemptedSubmit, isSubmitting, mentionNotice, prompt, submitBlocker]);

  const canPressSubmit = !isSubmitting && !(need1080pApproval && !resolutionApprovalConfirmed);

  const estimatedPoints = useMemo(() => {
    return calculateEstimatedCostClient(resolution, duration);
  }, [resolution, duration]);

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

  useEffect(() => {
    void refreshReferenceAlbums();
  }, [refreshReferenceAlbums]);

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
    setHasAttemptedSubmit(false);
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
    setHasAttemptedSubmit(false);
  }, [initialSettings, reuseDraft]);

  useEffect(() => {
    if (!need1080pApproval) {
      setResolutionApprovalConfirmed(false);
    }
  }, [need1080pApproval]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleSubmit = useCallback(async () => {
    setHasAttemptedSubmit(true);
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
  ]);

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
          onChange={setPrompt}
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
            <span>我已确认该任务经过 1080p 审批，允许直接生成</span>
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
              <a href={taskDetailHref(result.id, '/generate')} className="composer-result-link">查看详情</a>
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
    </>
  );
}
