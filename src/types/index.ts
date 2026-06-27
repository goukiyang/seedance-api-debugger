// Generation mode options (按即梦网页版)
export type GenerationMode = 'all_in_one_reference' | 'first_last_frame' | 'smart_multi_frame';
export type TaskGenerationMode = GenerationMode | 'enhance_video';

// Video aspect ratios (网页版 6 个比例)
export type VideoRatio = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

// Video duration options (4-15 秒)
export type VideoDuration = 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

// Video resolution options (480p, 720p, 1080p)
export type VideoResolution = '480p' | '720p' | '1080p';

// Local status enum
export type LocalStatus = 'draft' | 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled';

// Create video task input
export interface CreateVideoInput {
  prompt: string;
  generation_mode: GenerationMode;
  ratio?: VideoRatio;
  duration?: VideoDuration;
  resolution?: VideoResolution;
  seed?: number;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  watermark?: boolean;
  // 全能参考模式素材（local URL 或 base64 data URL）
  reference_image_urls?: string[];
  reference_album_ids?: string[];
  reference_image_ids?: string[];
  reference_video_urls?: string[];
  reference_audio_urls?: string[];
  // base64 格式的图片数据（用于本地相对路径，上传给外部 provider）
  reference_image_base64_data?: string[];
  // 首尾帧模式素材（local URL 或 base64 data URL）
  first_frame_url?: string;
  last_frame_url?: string;
  // base64 首尾帧
  first_frame_base64_data?: string;
  last_frame_base64_data?: string;
  // 智能多帧模式素材
  frame_image_urls?: string[];
  frame_image_base64_data?: string[];
  // 回调参数
  callback_url?: string;
  execution_expires_after?: number;
  // Provider 幂等 / 查询参数；发送给 Seedance 时使用 clientRequestId
  clientRequestId?: string;
  client_request_id?: string;
}

// ============================================================================
// Provider 适配器类型定义 (Step1/Step2 结构)
// ============================================================================

// Create video task input
export interface CreateVideoInput {
  prompt: string;
  generation_mode: GenerationMode;
  ratio?: VideoRatio;
  duration?: VideoDuration;
  resolution?: VideoResolution;
  seed?: number;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  watermark?: boolean;
  // 全能参考模式素材（local URL 或 base64 data URL）
  reference_image_urls?: string[];
  reference_album_ids?: string[];
  reference_image_ids?: string[];
  reference_video_urls?: string[];
  reference_audio_urls?: string[];
  // base64 格式的图片数据（用于本地相对路径，上传给外部 provider）
  reference_image_base64_data?: string[];
  // 首尾帧模式素材（local URL 或 base64 data URL）
  first_frame_url?: string;
  last_frame_url?: string;
  // base64 首尾帧
  first_frame_base64_data?: string;
  last_frame_base64_data?: string;
  // 智能多帧模式素材
  frame_image_urls?: string[];
  frame_image_base64_data?: string[];
  // 回调参数
  callback_url?: string;
  execution_expires_after?: number;
  // Provider 幂等 / 查询参数；发送给 Seedance 时使用 clientRequestId
  clientRequestId?: string;
  client_request_id?: string;
}

// Step1: 创建任务返回
export interface ProviderCreateResponse {
  provider_task_id: string;
  raw: unknown;
}

// Step2: 查询任务返回
export interface ProviderStatusResponse {
  provider_task_id: string;
  provider_status: string;
  local_status: LocalStatus;
  result_video_url?: string;
  result_last_frame_url?: string;
  error_message?: string;
  // 扩展字段
  provider_model?: string;
  seed?: number;
  resolution?: string;
  ratio?: string;
  duration?: number;
  frames_per_second?: number;
  service_tier?: string;
  execution_expires_after?: number;
  usage?: unknown;
  actual_cost?: number;
  currency_or_credit_type?: string;
  billing_status?: string;
  billing_time?: number;
  client_request_id?: string;
  raw: unknown;
}

// Video task from database
export interface VideoTask {
  id: string;
  provider: string;
  model: string;
  generation_mode: TaskGenerationMode;
  prompt: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  seed?: number;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  watermark?: boolean;
  reference_image_urls?: string[];
  reference_album_ids?: string[];
  reference_image_ids?: string[];
  reference_video_urls?: string[];
  reference_audio_urls?: string[];
  first_frame_url?: string;
  last_frame_url?: string;
  frame_image_urls?: string[];
  callback_url?: string;
  execution_expires_after?: number;
  local_status: LocalStatus;
  provider_task_id?: string;
  provider_status?: string;
  result_video_url?: string;
  result_last_frame_url?: string;
  local_video_path?: string;
  raw_create_response?: string;
  raw_status_response?: string;
  error_message?: string;
  params_json?: string;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
}

// Config response
export interface ConfigResponse {
  provider: string;
  base_url: string;
  model: string;
  api_key_configured: boolean;
}

// Task list item (simplified)
export interface TaskListItem {
  id: string;
  provider_task_id?: string;
  prompt: string;
  generation_mode: GenerationMode;
  local_status: LocalStatus;
  created_at: Date;
  completed_at?: Date;
}

// API error response
export interface APIError {
  error: string;
  message: string;
}

// 常量定义
export const RATIO_OPTIONS: VideoRatio[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const DURATION_OPTIONS: VideoDuration[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export const RESOLUTION_OPTIONS: VideoResolution[] = ['480p', '720p', '1080p'];
export const DEFAULT_RATIO: VideoRatio = '16:9';
export const DEFAULT_DURATION: VideoDuration = 5;
export const DEFAULT_RESOLUTION: VideoResolution = '720p';
export const DEFAULT_MODEL = 'dreamina-seedance-2-0-260128';

export const GENERATION_MODE_LABELS: Record<GenerationMode, string> = {
  'all_in_one_reference': '全能参考',
  'first_last_frame': '首尾帧',
  'smart_multi_frame': '智能多帧',
};

export const TASK_GENERATION_MODE_LABELS: Record<TaskGenerationMode, string> = {
  ...GENERATION_MODE_LABELS,
  'enhance_video': '视频超分',
};

export const RATIO_LABELS: Record<VideoRatio, string> = {
  '21:9': '21:9 宽银幕',
  '16:9': '16:9 横版',
  '4:3': '4:3 标准',
  '1:1': '1:1 方形',
  '3:4': '3:4 竖版',
  '9:16': '9:16 竖屏',
};

// ============================================================================
// 资产管理系统类型
// ============================================================================

export type AssetType = 'image' | 'video' | 'audio';

// 上传状态
export type UploadStatus = 'uploading' | 'uploaded' | 'failed';

// Frame 角色：首帧/尾帧（对应 Prisma schema 中的 first_frame / last_frame）
export type FrameRole = 'first_frame' | 'last_frame' | null;

export interface Asset {
  id: string;
  owner_id: string;
  type: AssetType;
  original_url: string;
  thumbnail_url: string | null;
  file_name: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  file_size: number;
  hash: string | null;
  status?: string;
  created_at: Date;
}

export interface WorkspaceAssetItem {
  id: string;
  assetId: string;
  referenceImageId?: string | null;
  referenceAlbumId?: string | null;
  referenceAlbumName?: string | null;
  sortOrder: number;
  role: string | null;
  type: AssetType;
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  width: number | null;
  height: number | null;
  fileSize: number;
  mimeType: string;
  createdAt: Date;
  // P0-1: 上传状态（本地维护）
  uploadStatus?: UploadStatus;
  // P0-1: Frame 角色
  frameRole?: FrameRole;
}

export interface Workspace {
  id: string;
  owner_id: string;
  name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  assets: WorkspaceAssetItem[];
}

export interface AssetCollection {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  visibility: string;
  cover_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
  _count?: { items: number };
  cover_asset?: Asset;
  items?: Array<{
    id: string;
    asset_id: string;
    sort_order: number;
    role: string | null;
    asset: Asset;
  }>;
}

export interface GenerationTaskSnapshot {
  id: string;
  task_id: string | null;
  workspace_id: string | null;
  generation_mode: string;
  prompt_raw: string;
  prompt_rendered: string;
  asset_mapping_json: string | null;
  content_json: string | null;
  provider_payload_json: string | null;
  created_at: Date;
}

export interface PromptValidation {
  valid: boolean;
  missing: string[];
}
