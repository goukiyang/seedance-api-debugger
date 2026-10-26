export type CutoutKind = 'cutout' | 'characters' | 'crop' | 'split_preview' | 'split_region' | 'split_merge' | 'split_export';
export type CutoutStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type CutoutProgressStage = 'preparing' | 'processing' | 'saving';
export type CutoutProgress = {
  stage: CutoutProgressStage;
  attempt: number;
  sequence: number;
  reported_at: number;
};
export type CutoutUploadProgress = { loaded: number; total: number; percent: number };
export type Box = { x: number; y: number; w: number; h: number };
export type CharacterBox = Box & { id: string; name: string };
export type PromptOverride = { id: string; points: number[][]; labels: number[]; mask_index?: number };
export type CropMeta = { x: number; y: number; width: number; height: number; source_width?: number; source_height?: number };
export type CutoutSettings = {
  version: number;
  background_removal: number; edge_smooth: number; residue_cleanup: number;
  hole_repair: number; detail_protection: number; shadow_retention: number;
  model_preference: string; alpha_matting: boolean;
  foreground_threshold: number; background_threshold: number; erode_size: number;
  mask_expand: number; mask_contract: number; feather: number;
  remove_small_noise: boolean; fill_holes: boolean; alpha_clamp_foreground: number;
  background_alpha_cutoff: number; edge_decontaminate: boolean;
  edge_decontaminate_strength: number; edge_band_width: number; preset?: string;
};
export type ModelOption = { id: string; label?: string; available: boolean; reason?: string };
export type CutoutCapabilities = {
  success?: boolean;
  api_version?: string;
  worker?: { online: boolean; busy?: boolean; paused?: boolean; device?: string };
  dispatch?: { available: boolean; configured?: boolean };
  models?: ModelOption[];
  limits?: { max_upload_mb?: number; max_active_jobs?: number };
  integration: { configured: boolean; authorized: boolean; ready: boolean; message: string };
};
export type CutoutAsset = { asset_id: string; name: string; width: number; height: number; size: number };
export type SplitItem = {
  id: string; name: string; filename_trim?: string; filename_canvas?: string;
  trim_url?: string; canvas_url?: string; result_url?: string; mask_url?: string;
  bbox?: Box; area?: number; alpha_mean?: number; padding?: number;
  export?: boolean; merged_from?: string[]; manual_adjusted?: boolean; type?: string;
  result_filename?: string; mask_filename?: string; source_crop_filename?: string;
  source_bbox?: Box; crop_bbox?: Box; crop?: CropMeta | Box;
  width?: number; height?: number; meta?: { width?: number; height?: number; model?: string };
};
export type CutoutResult = {
  success?: boolean; filename?: string; result_url?: string; mask_url?: string;
  crop?: CropMeta; items?: SplitItem[]; item?: SplitItem;
  source_file?: string; source_filename?: string; source_width?: number; source_height?: number;
  split_count?: number; count?: number; split_mode?: string; params?: Record<string, unknown>;
  contact_sheet_url?: string; zip_url?: string; manifest_url?: string;
  meta?: { model?: string; device?: string; width?: number; height?: number };
};
export type CutoutJob = {
  job_id: string; kind: CutoutKind; status: CutoutStatus;
  created_at: number; updated_at: number; result?: CutoutResult | null;
  started_at?: number;
  progress?: CutoutProgress;
  error?: { code?: string; message?: string; retryable?: boolean };
  parameters?: Record<string, unknown>; model?: string; device?: string;
};
export type CutoutHistory = { items: CutoutJob[]; total?: number; limit?: number; offset?: number; has_more?: boolean };
export const CUTOUT_KIND_LABELS: Record<CutoutKind, string> = {
  cutout: '普通抠图', characters: '角色拆切', crop: '透明裁剪',
  split_preview: '拆分预览', split_region: '区域拆分', split_merge: '合并对象', split_export: '打包导出',
};
export const CUTOUT_STATUS_LABELS: Record<CutoutStatus, string> = {
  queued: '排队中', running: '处理中', succeeded: '已完成', failed: '失败', canceled: '已取消',
};
