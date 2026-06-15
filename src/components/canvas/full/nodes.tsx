import { useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Bot, Camera, ChevronUp, Copy, FileImage, Film, Music, ShieldCheck, Trash2, Type, Upload } from 'lucide-react';
import type { AssetOption, AudioCardNode, GenerationLikeNode, ImageCardNode, ReferenceMode, SeedanceModel, TextCardNode, VideoCardNode } from './types';
import { detectMentionAtCursor, replaceMentionAtCursor } from '@/lib/prompt/mention';

const WAN27_MODELS: SeedanceModel[] = ['wan2.7-t2v-2026-04-25', 'wan2.7-i2v-2026-04-25', 'wan2.7-r2v'];
const DEFAULT_SEEDANCE_CONSTRAINTS = '生成约束：避免水印、字幕、乱码文字、Logo、人物脸部变形、额外肢体、主体漂移、无关物体乱入；保持主体身份、服装、场景与镜头连续。';
const DEFAULT_WAN_NEGATIVE_PROMPT = '不要水印、不要乱码字幕、不要人物变脸、不要无关物体乱入。';

function isWan27Model(model: SeedanceModel) {
  return WAN27_MODELS.includes(model);
}

function estimateGenerationPrice(data: GenerationLikeNode['data'], isWan27: boolean, hasVideoInput: boolean) {
  const duration = Math.max(isWan27 ? 2 : 4, data.durationSec);

  if (isWan27) {
    // DashScope 百炼 Wan2.7: 视频生成按输出视频秒数计费，720P=¥0.6/s，1080P=¥1/s。
    // The UI should normally normalize Wan 480p to 720p before request building.
    const effectiveQuality = data.quality === '1080p' ? '1080p' : '720p';
    const rate = effectiveQuality === '1080p' ? 1 : 0.6;
    const rmb = duration * rate;
    return {
      label: `约¥${rmb.toFixed(2)}`,
      compact: `约¥${rmb.toFixed(2)} / ¥${rate.toFixed(2)}/s`,
      detail: `Wan 2.7：${duration}s × ${effectiveQuality.toUpperCase()}，按 DashScope 输出视频 ${rate === 1 ? '¥1.00/s' : '¥0.60/s'} 估算。`,
      note: 'Wan2.7 输入不计费，输出按成功生成的视频秒数计费；实际以百炼账单为准。',
    };
  }

  // 火山方舟 Seedance 2.0 token 单价不同：
  // 2.0: 文/图生视频 ¥0.046/千tokens，含视频输入 ¥0.028/千tokens。
  // 2.0 Fast: 文/图生视频 ¥0.037/千tokens，含视频输入 ¥0.022/千tokens。
  // Public pricing examples put a 15s Seedance 2.0 clip at about 30.888万 tokens, so the UI converts
  // token pricing into an approximate per-output-second number for quick decision making.
  const seedanceRates = {
    'seedance-2.0': { noVideo: 0.95, withVideo: 0.58, label: 'Seedance 2.0' },
    'seedance-2.0-fast': { noVideo: 0.76, withVideo: 0.45, label: 'Seedance 2.0 Fast' },
  } as const;
  const config = data.model === 'seedance-2.0-fast' ? seedanceRates['seedance-2.0-fast'] : seedanceRates['seedance-2.0'];
  const rate = hasVideoInput ? config.withVideo : config.noVideo;
  const rmb = duration * rate;
  const modeText = hasVideoInput ? '含视频输入 token 单价' : '文/图生视频 token 单价';
  const effectiveQuality = data.model === 'seedance-2.0-fast' && data.quality === '1080p' ? '720p' : data.quality;
  return {
    label: `约¥${rmb.toFixed(2)}`,
    compact: `约¥${rmb.toFixed(2)} / ¥${rate.toFixed(2)}/s`,
    detail: `${config.label}：${duration}s × ${effectiveQuality.toUpperCase()}，按${modeText}折算约 ¥${rate.toFixed(2)}/s。`,
    note: hasVideoInput ? '已连视频卡：Seedance 视频输入单价更低，但输入视频时长也可能参与 token 消耗；这里先按输出时长粗估。' : 'Seedance 按 tokens 计费，此处由公开 15s≈30.888万 tokens 样例折算；实际以火山方舟账单为准。',
  };
}

function NodeActions({ onDuplicate, onDelete }: { onDuplicate?: () => void; onDelete?: () => void }) {
  return (
    <div className="node-actions">
      <button className="icon-button" type="button" title="复制" onClick={onDuplicate}><Copy size={13} /></button>
      <button className="icon-button danger" type="button" title="删除" onClick={onDelete}><Trash2 size={13} /></button>
    </div>
  );
}

function imageFilesFromList(files?: FileList | null) {
  return Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
}

function readImageFile(file: File) {
  return new Promise<{ url: string; fileName: string; mimeType: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve({
          url: reader.result,
          fileName: file.name,
          mimeType: file.type,
        });
        return;
      }
      reject(new Error('图片读取失败。'));
    };
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsDataURL(file);
  });
}

export function TextCard({ id, data }: NodeProps<TextCardNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <article className="card text-card">
        <header className="card-header">
          <span className="icon"><Type size={16} /></span>
          <div className="card-title-edit">
            <input className="node-input" value={data.title} onChange={(event) => data.onDataChange?.(id, { title: event.target.value })} />
          </div>
          <NodeActions onDuplicate={() => data.onDuplicate?.(id)} onDelete={() => data.onDelete?.(id)} />
        </header>
        <textarea
          className="node-textarea"
          value={data.prompt}
          placeholder="在这里输入真正要发送给模型的提示词、台词或时间轴。"
          onChange={(event) => data.onDataChange?.(id, { prompt: event.target.value })}
        />
        {data.seedanceRef && <span className="pill">{data.seedanceRef}</span>}
      </article>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function ImageCard({ id, data }: NodeProps<ImageCardNode>) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isFrameCard = data.variant === 'frame';
  const frameLabel = data.usage === 'end-frame' ? '尾帧' : '首帧';

  const applyFiles = (files?: FileList | null) => {
    const imageFiles = imageFilesFromList(files);
    if (imageFiles.length === 0) return;

    void Promise.all(imageFiles.map(readImageFile))
      .then(([firstImage, ...restImages]) => {
        if (!firstImage) return;
        data.onImageChange?.(id, firstImage);
        if (restImages.length > 0) {
          data.onImageBatchAdd?.(id, restImages);
        }
      })
      .catch((error) => {
        data.onDataChange?.(id, {
          uploadStatus: 'failed',
          uploadError: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <article
        className="card image-card"
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          applyFiles(event.dataTransfer.files);
        }}
      >
        <header className="card-header">
          <span className="icon"><FileImage size={16} /></span>
          <div className="card-title-edit">
            {isFrameCard ? (
              <select
                className="node-select full"
                value={data.usage === 'end-frame' ? 'end-frame' : 'first-frame'}
                onChange={(event) => data.onDataChange?.(id, {
                  usage: event.target.value,
                  title: event.target.value === 'end-frame' ? '尾帧' : '首帧',
                })}
              >
                <option value="first-frame">首帧</option>
                <option value="end-frame">尾帧</option>
              </select>
            ) : (
              <input className="node-input" value={data.title} placeholder="主体 / 角色 / 风格 / 场景…" onChange={(event) => data.onDataChange?.(id, { title: event.target.value })} />
            )}
            <input className="node-input small" value={data.refId} onChange={(event) => data.onDataChange?.(id, { refId: event.target.value })} />
          </div>
          <NodeActions onDuplicate={() => data.onDuplicate?.(id)} onDelete={() => data.onDelete?.(id)} />
        </header>
        {isFrameCard && <p className="frame-card-note">{frameLabel}卡只决定 API 的 {data.usage === 'end-frame' ? 'last_frame' : 'first_frame'}，不自动写入 prompt。</p>}
        <button className="upload-button" type="button" onClick={() => inputRef.current?.click()} disabled={data.uploadStatus === 'uploading'}>
          <Upload size={14} /> {data.uploadStatus === 'uploading' ? '上传中…' : '选择/拖入图片（可多选）'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            applyFiles(event.target.files);
            event.currentTarget.value = '';
          }}
        />
        <div className="image-placeholder">
          {data.url || data.publicUrl ? (
            <img
              src={data.url || data.publicUrl}
              alt={data.title || data.refId}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          ) : <span>{data.refId}</span>}
        </div>
        <div className="image-meta-row">
          {data.fileName && <span className="pill file-pill">{data.fileName}</span>}
          {data.publicUrl && <span className="pill public-url-pill">公网URL ✓</span>}
          {data.uploadStatus === 'uploading' && <span className="pill upload-status-pill">上传中…</span>}
          {data.uploadStatus === 'failed' && <span className="pill upload-error-pill" title={data.uploadError}>上传失败</span>}
        </div>
      </article>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

function MediaAssetCard({ id, data, kind }: NodeProps<VideoCardNode | AudioCardNode> & { kind: 'video' | 'audio' }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isVideo = kind === 'video';
  const Icon = isVideo ? Film : Music;
  const accept = isVideo ? 'video/*' : 'audio/*';
  const label = isVideo ? '视频' : '音频';
  const previewUrl = data.url || data.publicUrl;

  const applyFile = (file?: File) => {
    if (!file || !file.type.startsWith(`${kind}/`)) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        data.onMediaChange?.(id, {
          url: reader.result,
          fileName: file.name,
          mimeType: file.type,
        });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <article
        className={`card media-card ${kind}-card`}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          applyFile(event.dataTransfer.files?.[0]);
        }}
      >
        <header className="card-header">
          <span className="icon"><Icon size={16} /></span>
          <div className="card-title-edit">
            <input className="node-input" value={data.title} placeholder={`${label}素材 / 参考 / BGM…`} onChange={(event) => data.onDataChange?.(id, { title: event.target.value })} />
            <input className="node-input small" value={data.refId} onChange={(event) => data.onDataChange?.(id, { refId: event.target.value })} />
          </div>
          <NodeActions onDuplicate={() => data.onDuplicate?.(id)} onDelete={() => data.onDelete?.(id)} />
        </header>
        <button className="upload-button" type="button" onClick={() => inputRef.current?.click()} disabled={data.uploadStatus === 'uploading'}>
          <Upload size={14} /> {data.uploadStatus === 'uploading' ? '上传中…' : `选择/拖入${label}`}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          hidden
          onChange={(event) => applyFile(event.target.files?.[0])}
        />
        <div className={`media-placeholder ${kind}-placeholder`}>
          {isVideo && previewUrl ? (
            <video src={previewUrl} controls playsInline />
          ) : !isVideo && previewUrl ? (
            <audio src={previewUrl} controls />
          ) : (
            <span>{data.refId}</span>
          )}
        </div>
        <div className="image-meta-row">
          {data.fileName && <span className="pill file-pill">{data.fileName}</span>}
          {data.publicUrl && <span className="pill public-url-pill">公网URL ✓</span>}
          {data.uploadStatus === 'uploading' && <span className="pill upload-status-pill">上传中…</span>}
          {data.uploadStatus === 'failed' && <span className="pill upload-error-pill" title={data.uploadError}>上传失败</span>}
        </div>
        <p className="media-card-note">可连到生成卡作为{label}资产；视频参考会把已上传的公网视频 URL 发送给支持的模型。</p>
      </article>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export function VideoCard(props: NodeProps<VideoCardNode>) {
  return <MediaAssetCard {...props} kind="video" />;
}

export function AudioCard(props: NodeProps<AudioCardNode>) {
  return <MediaAssetCard {...props} kind="audio" />;
}

export function GenerationCard({ id, data, selected }: NodeProps<GenerationLikeNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const prePromptRef = useRef<HTMLTextAreaElement | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSpecPanel, setShowSpecPanel] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const specPanelRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeReferenceMode = data.referenceMode ?? (data.mode === 'text-to-video' ? 'text-reference' : data.mode === 'video-extension' ? 'video-reference' : 'omni-reference');
  const isWan27 = isWan27Model(data.model);
  const wan27SupportsRatio = activeReferenceMode !== 'first-last-frame';
  const ratioLabel = isWan27 && !wan27SupportsRatio ? '跟随首帧' : data.aspectRatio;
  const qualityOptions = isWan27 ? ['720p', '1080p'] : data.model === 'seedance-2.0-fast' ? ['480p', '720p'] : ['480p', '720p', '1080p'];
  const minDuration = isWan27 ? 2 : 4;
  const shortModel = isWan27 ? 'Wan 2.7' : data.model.replace('seedance-', 'Seedance ');
  const connectedImageAssets = (data.assetOptions?.image ?? []).filter((asset) => data.inputs.imageNodeIds.includes(asset.nodeId));
  const connectedVideoAssets = (data.assetOptions?.video ?? []).filter((asset) => data.inputs.videoNodeIds.includes(asset.nodeId));
  const connectedAudioAssets = (data.assetOptions?.audio ?? []).filter((asset) => data.inputs.audioNodeIds.includes(asset.nodeId));
  const connectedMediaAssets = [...connectedImageAssets, ...connectedVideoAssets, ...connectedAudioAssets];
  const visualAssetCount = connectedMediaAssets.length;
  const modelOptions: Array<{ value: SeedanceModel; label: string; matches?: (model: SeedanceModel) => boolean }> = [
    { value: 'seedance-2.0', label: 'Seedance 2.0' },
    { value: 'seedance-2.0-fast', label: 'Seedance Fast' },
    { value: 'wan2.7-t2v-2026-04-25', label: 'Wan 2.7', matches: isWan27Model },
  ];
  const activeModelLabel = modelOptions.find((option) => option.matches ? option.matches(data.model) : option.value === data.model)?.label ?? shortModel;
  const assetDockItems = connectedMediaAssets.slice(0, 3);
  const extraAssetCount = Math.max(0, visualAssetCount - assetDockItems.length);
  const priceEstimate = estimateGenerationPrice(data, isWan27, connectedVideoAssets.length > 0);
  const isAgentCard = data.agentMode === true;
  const mentionOptions = mentionQuery === null
    ? []
    : connectedImageAssets.filter((asset) => {
        const query = mentionQuery.toLowerCase();
        return !query || `${asset.refId ?? ''} ${asset.label} ${asset.detail ?? ''}`.toLowerCase().includes(query);
      });
  const showMentionMenu = mentionQuery !== null;
  const resizePromptTextarea = () => {
    const textarea = promptRef.current;
    if (!textarea) return;
    const maxHeight = 220;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };
  const resizePrePromptTextarea = () => {
    const textarea = prePromptRef.current;
    if (!textarea) return;
    const maxHeight = 160;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };
  const updateMentionState = (value: string, cursor: number | null) => {
    const range = detectMentionAtCursor(value, cursor);
    if (!range) {
      setMentionQuery(null);
      return;
    }
    setMentionQuery(range.query);
    setActiveMentionIndex(0);
  };
  const insertMention = (asset: AssetOption) => {
    const refId = asset.refId ?? asset.label.split(' ')[0] ?? '@图片';
    const textarea = promptRef.current;
    const cursor = textarea?.selectionStart ?? data.prompt.length;
    const { next: nextPrompt, cursor: nextCursor } = replaceMentionAtCursor(data.prompt, cursor, refId);
    data.onDataChange?.(id, { prompt: nextPrompt });
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      resizePromptTextarea();
    });
  };

  useEffect(() => {
    if (selected) resizePromptTextarea();
    if (selected && isAgentCard) resizePrePromptTextarea();
  }, [data.prePrompt, data.prompt, isAgentCard, selected]);

  useEffect(() => {
    if (selected) return;
    setShowModelMenu(false);
    setShowSpecPanel(false);
    setShowSettings(false);
    setMentionQuery(null);
  }, [selected]);

  useEffect(() => {
    updateNodeInternals(id);
    const frame = window.requestAnimationFrame(() => updateNodeInternals(id));
    const timer = window.setTimeout(() => updateNodeInternals(id), 260);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [id, data.aspectRatio, data.videoUrl, selected, updateNodeInternals]);

  useEffect(() => {
    if (!showModelMenu && !showSpecPanel && !showSettings) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      if (showModelMenu && !modelMenuRef.current?.contains(target)) {
        setShowModelMenu(false);
      }
      if (showSpecPanel && !specPanelRef.current?.contains(target)) {
        setShowSpecPanel(false);
      }
      if (
        showSettings &&
        !settingsRef.current?.contains(target) &&
        !settingsButtonRef.current?.contains(target)
      ) {
        setShowSettings(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowModelMenu(false);
      setShowSpecPanel(false);
      setShowSettings(false);
      setMentionQuery(null);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showModelMenu, showSpecPanel, showSettings]);

  const setReferenceMode = (referenceMode: ReferenceMode) => {
    const patch: Record<string, unknown> = { referenceMode };
    if (referenceMode === 'text-reference') {
      patch.mode = 'text-to-video';
    }
    if (referenceMode === 'omni-reference' || referenceMode === 'first-last-frame') {
      patch.mode = 'image-to-video';
    }
    if (referenceMode === 'video-reference') {
      patch.mode = 'video-extension';
    }
    if (isWan27) {
      if (referenceMode === 'text-reference') patch.model = 'wan2.7-t2v-2026-04-25';
      if (referenceMode === 'first-last-frame') patch.model = 'wan2.7-i2v-2026-04-25';
      if (referenceMode === 'omni-reference' || referenceMode === 'video-reference') patch.model = 'wan2.7-r2v';
    }
    data.onDataChange?.(id, patch);
  };
  const referenceTabs: Array<{ mode: ReferenceMode; label: string }> = [
    { mode: 'text-reference', label: '文本参考' },
    { mode: 'omni-reference', label: '全能参考' },
    { mode: 'first-last-frame', label: '首尾帧' },
    { mode: 'video-reference', label: '视频参考' },
  ];
  return (
    <article className="card generation-card liblib-card">
      <div className={`liblib-video-stage ratio-${data.aspectRatio.replace(':', '-')}`}>
        <header className="liblib-node-title">
          <span>{isAgentCard ? <Bot size={13} /> : '▶'}</span>
          <input value={data.title} onChange={(event) => data.onDataChange?.(id, { title: event.target.value })} />
          <NodeActions onDuplicate={() => data.onDuplicate?.(id)} onDelete={() => data.onDelete?.(id)} />
        </header>
        <Handle className="liblib-video-handle input" type="target" position={Position.Left} />
        <div className={`liblib-video-frame ratio-${data.aspectRatio.replace(':', '-')}`}>
          {data.videoUrl ? (
            <video src={data.videoUrl} controls playsInline />
          ) : (
            <div className="liblib-play-placeholder"><Film size={58} /><span>{data.status === 'generating' ? '生成中…' : '等待生成'}</span></div>
          )}
        </div>

        {selected && (
        <section className="liblib-control-panel nodrag">
        {isAgentCard && (
          <label className="agent-preprompt-field">
            <span>前置提示词</span>
            <textarea
              ref={prePromptRef}
              className="agent-preprompt-textarea"
              value={data.prePrompt ?? ''}
              onChange={(event) => {
                data.onDataChange?.(id, { prePrompt: event.target.value });
                resizePrePromptTextarea();
              }}
              placeholder="固定 Agent 的判断方式，例如：先识别参考图主体，再保持角色身份、服装和镜头连续。"
            />
          </label>
        )}
        <div className="liblib-tabs">
          {referenceTabs.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              className={activeReferenceMode === tab.mode ? 'active' : ''}
              onClick={() => setReferenceMode(tab.mode)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="prompt-mention-wrap">
          <textarea
            ref={promptRef}
            className="liblib-prompt"
            value={data.prompt}
            onChange={(event) => {
              data.onDataChange?.(id, { prompt: event.target.value });
              resizePromptTextarea();
              updateMentionState(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={(event) => {
              if (!showMentionMenu) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                setMentionQuery(null);
                return;
              }
              if (mentionOptions.length === 0) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveMentionIndex((index) => (index + 1) % mentionOptions.length);
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveMentionIndex((index) => (index - 1 + mentionOptions.length) % mentionOptions.length);
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                insertMention(mentionOptions[activeMentionIndex] ?? mentionOptions[0]);
              }
            }}
            onSelect={(event) => updateMentionState(event.currentTarget.value, event.currentTarget.selectionStart)}
            placeholder="描述主体、动作、镜头、时间轴…… 输入 @ 选择已连线图片"
          />
          {showMentionMenu && (
            <div className="mention-popover">
              {connectedImageAssets.length === 0 ? (
                <div className="mention-empty">先把图片卡连到这张生成卡，才能 @ 选择。</div>
              ) : mentionOptions.length === 0 ? (
                <div className="mention-empty">没有匹配的已连线图片。</div>
              ) : mentionOptions.map((asset, index) => (
                <button
                  key={asset.nodeId}
                  type="button"
                  className={index === activeMentionIndex ? 'active' : ''}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    insertMention(asset);
                  }}
                >
                  {asset.url ? <img src={asset.url} alt={asset.label} /> : <span className="mention-ref-fallback">{asset.refId}</span>}
                  <span className="mention-main"><b>{asset.refId}</b><small>{asset.label.replace(`${asset.refId} · `, '')}</small></span>
                  {asset.detail && <em>{asset.detail}</em>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="asset-dock" aria-label="外部资产入口">
          <button type="button" className="asset-tool" title="运镜资产入口">
            <Camera size={15} />
            <span>运镜</span>
          </button>
          <button type="button" className="asset-tool" title="角色库资产入口">
            <ShieldCheck size={15} />
            <span>角色库</span>
          </button>
          {assetDockItems.length > 0 ? assetDockItems.map((asset, index) => (
            <div className="asset-thumb" key={asset.nodeId} title={`${asset.label}${asset.detail ? ` · ${asset.detail}` : ''}`}>
              {asset.url ? <img src={asset.url} alt={asset.label} /> : <span>{asset.refId ?? `#${index + 1}`}</span>}
              <b>{index + 1}</b>
            </div>
          )) : (
            <div className="asset-thumb empty" title="通过画布连线接入文本/图片/视频/音频资产">
              <span>资产</span>
            </div>
          )}
          {extraAssetCount > 0 && <div className="asset-more">+{extraAssetCount}</div>}
        </div>

        <div className="liblib-toolbar">
          <div className={`model-field${showModelMenu ? ' is-open' : ''}`} ref={modelMenuRef}>
            <button
              type="button"
              className="model-trigger"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setShowModelMenu((value) => !value);
                setShowSpecPanel(false);
              }}
            >
              <span>模型</span>
              <b>{activeModelLabel}</b>
              <ChevronUp size={13} className="model-caret" />
            </button>
            {showModelMenu && (
              <div className="model-popover">
                {modelOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={(option.matches ? option.matches(data.model) : data.model === option.value) ? 'active' : ''}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const patch: Record<string, unknown> = { model: option.value };
                      if (option.value === 'wan2.7-t2v-2026-04-25') {
                        if (!data.negativePrompt || data.negativePrompt.startsWith('生成约束')) patch.negativePrompt = DEFAULT_WAN_NEGATIVE_PROMPT;
                        const nextReferenceMode = activeReferenceMode;
                        if (nextReferenceMode === 'text-reference') {
                          patch.model = 'wan2.7-t2v-2026-04-25';
                          patch.mode = 'text-to-video';
                        } else if (nextReferenceMode === 'first-last-frame') {
                          patch.model = 'wan2.7-i2v-2026-04-25';
                          patch.mode = 'image-to-video';
                        } else {
                          patch.model = 'wan2.7-r2v';
                          patch.mode = nextReferenceMode === 'video-reference' ? 'video-extension' : 'image-to-video';
                        }
                        patch.referenceMode = nextReferenceMode;
                      } else if (!data.negativePrompt || data.negativePrompt === DEFAULT_WAN_NEGATIVE_PROMPT) {
                        patch.negativePrompt = DEFAULT_SEEDANCE_CONSTRAINTS;
                      }
                      data.onDataChange?.(id, patch);
                      setShowModelMenu(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {(option.matches ? option.matches(data.model) : data.model === option.value) && <b>✓</b>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={`spec-popover-wrap${showSpecPanel ? ' is-open' : ''}`} ref={specPanelRef}>
            <button
              type="button"
              className="spec-trigger"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setShowSpecPanel((value) => !value);
                setShowModelMenu(false);
              }}
            >
              <span>规格</span>
              <b>{ratioLabel} · {data.quality.toUpperCase()} · {data.durationSec}s</b>
              <ChevronUp size={13} className="spec-caret" />
            </button>
            {showSpecPanel && (
              <div className="spec-popover">
                {wan27SupportsRatio || !isWan27 ? (
                  <>
                    <div className="spec-section-title">比例</div>
                    <div className="ratio-grid">
                      {['16:9', '9:16', '1:1', '4:3', '3:4'].map((ratio) => (
                        <button
                          key={ratio}
                          type="button"
                          className={data.aspectRatio === ratio ? 'active' : ''}
                          onClick={() => data.onDataChange?.(id, { aspectRatio: ratio })}
                        >
                          <span className={`ratio-icon ratio-${ratio.replace(':', '-')}`} />
                          <b>{ratio}</b>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="model-parameter-note">
                    Wan 2.7 图生/首帧模式不提供比例参数；百炼会尽量跟随首帧/首段视频比例。
                  </div>
                )}

                <div className="spec-section-title">清晰度</div>
                <div className="quality-segment">
                  {qualityOptions.map((quality) => (
                    <button
                      key={quality}
                      type="button"
                      className={data.quality === quality ? 'active' : ''}
                      onClick={() => data.onDataChange?.(id, { quality })}
                    >
                      {quality.toUpperCase()}
                    </button>
                  ))}
                </div>

                <div className="spec-section-title duration-title">
                  <span>视频时长</span>
                  <b>{data.durationSec}s</b>
                </div>
                <input
                  className="duration-slider"
                  type="range"
                  min={minDuration}
                  max={15}
                  step={1}
                  value={data.durationSec}
                  onChange={(event) => data.onDataChange?.(id, { durationSec: Number(event.target.value) })}
                />
                <div className="price-estimate-detail">
                  <strong>{priceEstimate.compact}</strong>
                  <span>{priceEstimate.detail}</span>
                  <em>{priceEstimate.note}</em>
                </div>
              </div>
            )}
          </div>
          <div className="price-estimate-chip" title={`${priceEstimate.detail} ${priceEstimate.note}`}>
            <span>预计</span>
            <b>{priceEstimate.label}</b>
          </div>
          <button
            ref={settingsButtonRef}
            type="button"
            className="icon-button"
            title="高级设置"
            onClick={() => {
              setShowSettings((value) => !value);
              setShowModelMenu(false);
              setShowSpecPanel(false);
            }}
          >⌘</button>
          <button className="send-button" type="button" title="生成视频" disabled={data.status === 'generating'} onClick={() => data.onGeneratePreview?.(id)}>
            {data.status === 'generating' ? '…' : '↑'}
          </button>
        </div>

        {data.generationNotice && <p className="generation-notice compact-notice">{data.generationNotice}</p>}
        {data.taskId && <p className="generation-notice compact-notice">Task ID：{data.taskId}</p>}

        {showSettings && (
          <div className="liblib-settings" ref={settingsRef}>
            <label className="sound-setting">声音
              <select value={data.sound} onChange={(event) => data.onDataChange?.(id, { sound: event.target.value })}>
                <option value="auto-sfx-music">auto-sfx-music</option>
                <option value="mute">mute</option>
                <option value="custom-audio-ref">custom-audio-ref</option>
              </select>
            </label>

            {isWan27 ? (
              <textarea
                className="node-textarea compact negative-compact"
                value={data.negativePrompt}
                onChange={(event) => data.onDataChange?.(id, { negativePrompt: event.target.value })}
                placeholder="负面提示词"
              />
            ) : (
              <label className="sound-setting">生成约束
                <textarea
                  className="node-textarea compact negative-compact"
                  value={data.negativePrompt}
                  onChange={(event) => data.onDataChange?.(id, { negativePrompt: event.target.value })}
                  placeholder="生成约束：避免水印、字幕、乱码文字、Logo、人物脸部变形、额外肢体、主体漂移。"
                />
              </label>
            )}
          </div>
        )}
          </section>
        )}
        <Handle className="liblib-video-handle output" type="source" position={Position.Right} />
      </div>
    </article>
  );
}
