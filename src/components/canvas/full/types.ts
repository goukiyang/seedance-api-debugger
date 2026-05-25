import type { Edge, Node } from '@xyflow/react';

export type SeedanceAssetKind = 'image' | 'video' | 'audio';

export type SeedanceModel =
  | 'seedance-2.0'
  | 'seedance-2.0-fast'
  | 'wan2.7-t2v-2026-04-25'
  | 'wan2.7-i2v-2026-04-25'
  | 'wan2.7-r2v';

export type SeedanceMode =
  | 'text-to-video'
  | 'image-to-video'
  | 'video-extension'
  | 'video-editing'
  | 'music-sync';

export type CanvasNodeKind = 'textCard' | 'imageCard' | 'videoCard' | 'audioCard' | 'generationCard' | 'agentGenerationCard';

export type NodeDataPatch = Record<string, unknown>;

export interface NodeCardActions extends Record<string, unknown> {
  onDataChange?: (nodeId: string, patch: NodeDataPatch) => void;
  onDelete?: (nodeId: string) => void;
  onDuplicate?: (nodeId: string) => void;
  onGeneratePreview?: (nodeId: string) => void;
}

export interface TextCardData extends NodeCardActions {
  title: string;
  prompt: string;
  role: 'prompt' | 'timeline' | 'dialogue' | 'negative' | 'notes';
  seedanceRef?: string;
}

export interface MediaCardData extends NodeCardActions {
  title: string;
  refId: string;
  assetId?: string;
  url?: string;
  publicUrl?: string;
  fileName?: string;
  mimeType?: string;
  uploadStatus?: 'idle' | 'uploading' | 'uploaded' | 'failed';
  uploadError?: string;
  description?: string;
  onMediaChange?: (nodeId: string, media: { url: string; fileName: string; mimeType: string }) => void;
}

export interface ImageCardData extends NodeCardActions {
  title: string;
  refId: string; // maps to @图片N in Seedance 2.0
  variant?: 'semantic' | 'frame'; // semantic: title becomes prompt label; frame: first/last-frame API role card
  assetId?: string;
  url?: string; // local preview URL, may be data: or blob:
  publicUrl?: string; // provider-facing URL, must be public GET image/*
  fileName?: string;
  mimeType?: string;
  uploadStatus?: 'idle' | 'uploading' | 'uploaded' | 'failed';
  uploadError?: string;
  description: string;
  usage: 'first-frame' | 'character-reference' | 'style-reference' | 'storyboard' | 'end-frame';
  onImageChange?: (nodeId: string, image: { url: string; fileName: string; mimeType: string }) => void;
}

export type GenerationQuality = '480p' | '720p' | '1080p';
export type ReferenceMode = 'text-reference' | 'omni-reference' | 'first-last-frame' | 'video-reference';

export interface AssetOption {
  nodeId: string;
  label: string;
  detail?: string;
  url?: string;
  publicUrl?: string;
  refId?: string;
}

export interface GenerationCardData extends NodeCardActions {
  title: string;
  agentMode?: boolean;
  prePrompt?: string;
  model: SeedanceModel;
  mode: SeedanceMode;
  referenceMode: ReferenceMode;
  durationSec: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:3' | '3:4';
  quality: GenerationQuality;
  sound: 'auto-sfx-music' | 'mute' | 'custom-audio-ref';
  prompt: string;
  negativePrompt: string;
  inputs: {
    textNodeIds: string[];
    imageNodeIds: string[];
    videoNodeIds: string[];
    audioNodeIds: string[];
  };
  assetOptions?: {
    text: AssetOption[];
    image: AssetOption[];
    video: AssetOption[];
    audio: AssetOption[];
  };
  status: 'draft' | 'ready' | 'generating' | 'done' | 'failed';
  generationNotice?: string;
  taskId?: string;
  videoUrl?: string;
  seedanceRequestPreview?: SeedanceGenerateRequest;
}

export type TextCardNode = Node<TextCardData, 'textCard'>;
export type ImageCardNode = Node<ImageCardData, 'imageCard'>;
export type VideoCardNode = Node<MediaCardData, 'videoCard'>;
export type AudioCardNode = Node<MediaCardData, 'audioCard'>;
export type GenerationCardNode = Node<GenerationCardData, 'generationCard'>;
export type AgentGenerationCardNode = Node<GenerationCardData, 'agentGenerationCard'>;
export type GenerationLikeNode = GenerationCardNode | AgentGenerationCardNode;
export type SeedanceCanvasNode = TextCardNode | ImageCardNode | VideoCardNode | AudioCardNode | GenerationCardNode | AgentGenerationCardNode;

export interface SeedanceReferenceInput {
  type: SeedanceAssetKind;
  nodeId: string;
  refId: string; // @图片1 / @视频1 / @音频1
  url?: string;
  description?: string;
}

export interface SeedanceGenerateRequest {
  provider: 'volcengine-ark';
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
  pollEndpointTemplate: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}';
  method: 'POST';
  headers: {
    'Content-Type': 'application/json';
    Authorization: 'Bearer $ARK_API_KEY';
  };
  model: SeedanceModel;
  mode: SeedanceMode;
  referenceMode?: ReferenceMode;
  durationSec: number; // Seedance 2.0: 4-15s per generation segment
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:3' | '3:4';
  quality: GenerationQuality;
  prompt: string;
  sound: 'auto-sfx-music' | 'mute' | 'custom-audio-ref';
  references: SeedanceReferenceInput[]; // max platform inputs: 9 images, 3 videos, 3 audio, 12 total
  body: {
    model: 'doubao-seedance-2-0-260128' | 'doubao-seedance-2-0-fast-260128';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string }; role?: 'first_frame' | 'last_frame' | 'reference_image' }
      | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
      | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' }
    >;
    generate_audio: boolean;
    ratio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
    resolution: '480p' | '720p' | '1080p';
    duration: number;
    watermark: boolean;
  };
  notes: string[];
}

export interface Wan27TextToVideoRequestPreview {
  provider: 'aliyun-bailian';
  endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis';
  pollEndpointTemplate: 'https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}';
  method: 'POST';
  headers: {
    'Content-Type': 'application/json';
    Authorization: 'Bearer $DASHSCOPE_API_KEY';
    'X-DashScope-Async': 'enable';
  };
  body: {
    referenceMode?: ReferenceMode;
    model: 'wan2.7-t2v-2026-04-25' | 'wan2.7-i2v-2026-04-25' | 'wan2.7-r2v';
    input: {
      prompt: string;
      negative_prompt?: string;
      media?: Array<{
        type: 'first_frame' | 'last_frame' | 'reference_image';
        url: string;
      }>;
    };
    parameters: {
      resolution: '720P' | '1080P';
      ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
      prompt_extend: boolean;
      watermark: boolean;
      duration: number;
    };
  };
  notes: string[];
}

export type VideoGenerateRequestPreview = SeedanceGenerateRequest | Wan27TextToVideoRequestPreview;

export interface SeedanceCanvasDocument {
  version: 1;
  title: string;
  nodes: SeedanceCanvasNode[];
  edges: Edge[];
}

export const SEEDANCE_LIMITS = {
  minDurationSec: 2,
  maxDurationSec: 15,
  maxImages: 9,
  maxVideos: 3,
  maxAudios: 3,
  maxTotalFiles: 12,
} as const;
