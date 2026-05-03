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
import { ComposerStatusLine } from '@/components/ComposerStatusLine';
import { ComposerActionBar } from '@/components/ComposerActionBar';
import { ErrorTranslator } from '@/components/ErrorTranslator';
import { calculateEstimatedCostClient } from '@/lib/pricing-client';

const DEFAULT_GENERATION_MODE: GenerationMode = 'all_in_one_reference';
const DEFAULT_RATIO: VideoRatio = '16:9';
const DEFAULT_DURATION: VideoDuration = 5;
const DEFAULT_RESOLUTION: VideoResolution = '480p';
const MAX_REFS = 9;

interface PolledTask {
  id: string;
  local_status: string;
  provider_status: string | null;
  result_video_url: string | null;
  error_message: string | null;
}

interface Props {
  collections: AssetCollection[];
  onCollectionLoad: (collectionId: string) => Promise<void>;
  onCollectionSave: (name: string) => Promise<void>;
  onCollectionNew: (name: string) => Promise<void>;
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
}: Props) {
  const workspace = useWorkspace();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Composer 内部状态（受控于参数 props 透传）
  const [generationMode, setGenerationMode] = useState<GenerationMode>(DEFAULT_GENERATION_MODE);
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<VideoRatio>(DEFAULT_RATIO);
  const [duration, setDuration] = useState<VideoDuration>(DEFAULT_DURATION);
  const [resolution, setResolution] = useState<VideoResolution>(DEFAULT_RESOLUTION);
  const [seed, setSeed] = useState<number>(-1);
  const [generateAudio, setGenerateAudio] = useState(false);
  const [returnLastFrame, setReturnLastFrame] = useState(false);
  const [watermark, setWatermark] = useState(false);

  // ============================================================================
  // Validation
  // ============================================================================

  const validation = useMemo(() => {
    return checkPrompt(prompt, workspace.assets.length, duration);
  }, [prompt, workspace.assets.length, duration]);

  // 严重阻塞错误
  const blockingError = useMemo(() => {
    if (!prompt.trim()) return '请填写提示词';
    if (isSubmitting) return '提交中...';

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
    return null;
  }, [prompt, isSubmitting, workspace.uploadStatuses, workspace.assets.length, generationMode, validation]);

  const canSubmit = blockingError === null && !isSubmitting;

  const [estimatedPoints, setEstimatedPoints] = useState(0);

  useEffect(() => {
    let cancelled = false;

    calculateEstimatedCostClient(resolution, duration)
      .then((value) => {
        if (!cancelled) setEstimatedPoints(value);
      })
      .catch(() => {
        if (!cancelled) setEstimatedPoints(0);
      });

    return () => {
      cancelled = true;
    };
  }, [resolution, duration]);

  // 已引用图号
  const usedRefs = useMemo(() => {
    return validation.referencedFigures.map((n) => `图${n}`);
  }, [validation.referencedFigures]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    await onSubmit({ prompt, generationMode, ratio, duration, resolution, seed, generateAudio, returnLastFrame, watermark });
  }, [canSubmit, onSubmit, prompt, generationMode, ratio, duration, resolution, seed, generateAudio, returnLastFrame, watermark]);

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

  const handlePreview = useCallback((url: string) => {
    setPreviewUrl(url);
  }, []);

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
          loading={workspace.loading}
        />

        {/* 缩略图行 */}
        <ReferenceStrip
          assets={workspace.assets}
          uploadStatuses={workspace.uploadStatuses}
          onUpload={workspace.uploadAsset}
          onRemove={handleRemove}
          onReorder={handleReorder}
          onPreview={handlePreview}
          generationMode={generationMode}
          loading={workspace.loading}
        />

        {/* 提示词输入 */}
        <PromptEditor
          value={prompt}
          onChange={setPrompt}
        />

        {/* 状态行 */}
        <ComposerStatusLine
          blockingError={blockingError}
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

        {/* 结果 */}
        {result && (
          <div className="composer-result">
            <div className="composer-result-info">
              <span className="composer-result-label">任务已创建</span>
              <span className="composer-result-id">{result.id.slice(0, 8)}...</span>
            </div>

            {isPolling && !polledResult && (
              <div className="composer-polling-hint">正在查询结果...</div>
            )}

            {polledResult && polledResult.local_status === 'succeeded' && polledResult.result_video_url && (
              <div className="composer-result-video">
                <div className="composer-result-video-label">✅ 视频生成完成</div>
                <video
                  key={polledResult.result_video_url}
                  controls
                  playsInline
                  style={{ width: '100%', maxHeight: 280, borderRadius: 8 }}
                  src={polledResult.result_video_url}
                />
              </div>
            )}

            {polledResult && polledResult.local_status === 'failed' && (
              <div className="composer-result-error">
                ❌ 生成失败：{polledResult.error_message || '未知错误'}
              </div>
            )}

            {polledResult && !['succeeded', 'failed', 'cancelled'].includes(polledResult.local_status) && (
              <div className="composer-polling-hint">
                ⏳ {isPolling ? '生成中，正在查询结果...' : '请手动查看任务详情'}
              </div>
            )}

            <div className="composer-result-actions">
              <a href={`/tasks/${result.id}`} className="composer-result-link">查看详情 →</a>
              <button type="button" className="composer-result-reset" onClick={onReset}>
                新建任务
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
          canSubmit={canSubmit}
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
    </>
  );
}
