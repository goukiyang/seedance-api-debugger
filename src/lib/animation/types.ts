export type AnimationFileRole = 'pose' | 'mother' | 'reference' | 'video' | 'candidate';

export interface AnimationPose {
  id: string;
  file_id: string;
  mother_file_id?: string;
  label: string;
  width: number;
  height: number;
  logical_width: number | null;
  logical_height: number | null;
  pixels_per_unit: number | null;
  source: {
    version?: string;
    video_file_id?: string;
    frame_index?: number;
    pts_seconds?: number;
    note?: string;
  };
}

export interface AnimationEntry {
  id: string;
  action: string;
  pose_id: string;
  reference_file_id?: string;
  reference_geometry?: {
    logical_width: number;
    logical_height: number;
    pixels_per_unit: number;
    source: string;
  };
  hold_ticks: number;
  original_hold_ticks: number;
  locked: boolean;
  translate_x: number;
  translate_y: number;
}

export interface AnimationSequence {
  schema_version: 1;
  title: string;
  preview_fps: number;
  tick_rate: number | null;
  tick_rate_verified: boolean;
  global_scale: number;
  poses: AnimationPose[];
  entries: AnimationEntry[];
  notes: string;
  user_accepted_for_retention: boolean;
  historical_review: string;
}

export interface AnimationFileInfo {
  id: string;
  name: string;
  role: AnimationFileRole;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

// Paths exist only at the private processing boundary, never in public responses.
export interface AnimationLocalFile extends AnimationFileInfo {
  path: string;
}

export interface AnimationImportResult {
  sequence: AnimationSequence;
  files: AnimationLocalFile[];
  warnings: string[];
}

export type AnimationJobKind = 'export' | 'extract';
export type AnimationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface AnimationJobParameters {
  mode?: 'work_copy' | 'validated';
  video_file_id?: string;
  frame_index?: number;
}

export interface AnimationJobView {
  id: string;
  kind: AnimationJobKind;
  revision: number;
  status: AnimationJobStatus;
  stage: string;
  error: string | null;
  result: { export_id?: string; candidate_pose?: AnimationPose; file?: AnimationFileInfo; warnings?: string[] } | null;
  created_at: string;
  updated_at: string;
}

export interface AnimationExportView {
  id: string;
  revision: number;
  mode: 'work_copy' | 'validated';
  bytes: number;
  sha256: string;
  entry_count: number;
  total_ticks: number;
  download_url: string;
  created_at: string;
  warnings: string[];
}

export interface AnimationDocumentView {
  id: string;
  project_id: string;
  owner_id: string;
  owner_name: string;
  owner_avatar: string | null;
  title: string;
  revision: number;
  status: 'active' | 'archived';
  can_edit: boolean;
  can_manage: boolean;
  sequence: AnimationSequence;
  files: AnimationFileInfo[];
  jobs: AnimationJobView[];
  exports: AnimationExportView[];
  revisions: { revision: number; created_at: string }[];
  review_status: 'unsubmitted' | 'pending' | 'changes_requested' | 'reported_pass';
  review_revision: number | null;
  review_note: string;
  game_status: 'unverified' | 'changes_requested' | 'reported_pass';
  updated_at: string;
}

export interface AnimationSummary {
  id: string;
  project_id: string;
  title: string;
  revision: number;
  status: 'active' | 'archived';
  entry_count: number;
  total_ticks: number;
  thumbnail_url: string | null;
  owner_name: string;
  owner_avatar: string | null;
  updated_at: string;
}
