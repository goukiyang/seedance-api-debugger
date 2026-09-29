export type StudioJsonValue = string | number | boolean | null | StudioJsonValue[] | { [key: string]: StudioJsonValue };

export type StudioAssetRole = 'reference' | 'first' | 'last';
export type StudioAssetType = 'image' | 'video' | 'audio';
export type StudioTemplateSource = 'legacy' | 'studio';
export type StudioRunSource = 'blank' | StudioTemplateSource;
export type StudioRunMode = 'direct' | 'llm';
export type StudioRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
export type StudioTemplateStatus = 'draft' | 'published' | 'archived';
export type StudioTemplateVisibility = 'private' | 'shared' | 'legacy';

export type StudioAssetInput = {
  assetId: string;
  role: StudioAssetRole;
  type: StudioAssetType;
  slotKey?: string;
};

export type StudioTemplateField =
  | { key: string; label: string; type: 'text' | 'textarea'; required?: boolean; maxLength?: number; defaultValue?: string }
  | { key: string; label: string; type: 'select'; required?: boolean; options: string[]; defaultValue?: string }
  | { key: string; label: string; type: 'number'; required?: boolean; min?: number; max?: number; defaultValue?: number }
  | { key: string; label: string; type: 'toggle'; defaultValue?: boolean };

export type StudioTemplateAssetSlot = {
  key: string;
  label: string;
  role: StudioAssetRole;
  types: StudioAssetType[];
  required?: boolean;
  maxItems?: number;
};

export type StudioTemplateRecipe = {
  instruction: string;
  fields: StudioTemplateField[];
  assetSlots: StudioTemplateAssetSlot[];
  defaultParameters: Record<string, StudioJsonValue>;
};

export type StudioTemplateVersionSummary = {
  id: string;
  number: number;
  createdAt: string;
  createdBy: { displayName: string; avatarUrl: string | null } | null;
};

export type StudioTemplateDto = {
  id: string;
  source: StudioTemplateSource;
  name: string;
  description: string | null;
  groupName: string;
  status: StudioTemplateStatus;
  visibility: StudioTemplateVisibility;
  revision: number;
  owner: { displayName: string; avatarUrl: string | null } | null;
  canManage: boolean;
  canPublish: boolean;
  applyMode: 'studio-draft' | 'legacy-route';
  applyUrl: string | null;
  version: StudioTemplateVersionSummary | null;
  recipe: StudioTemplateRecipe | null;
  createdAt: string;
  updatedAt: string;
};

export type TemplateListQuery = {
  cursor?: string;
  search?: string;
  group?: string;
};

export type TemplateListResponse = {
  items: StudioTemplateDto[];
  nextCursor: string | null;
};

export type StudioTemplateDetailResponse = {
  template: StudioTemplateDto;
  versions: StudioTemplateVersionSummary[];
};

export type CreateStudioTemplateRequest = {
  name: string;
  description?: string | null;
  groupName: string;
  recipe: StudioTemplateRecipe;
};

export type UpdateStudioTemplateRequest = {
  action: 'update';
  expectedRevision: number;
  name: string;
  description?: string | null;
  groupName: string;
  recipe: StudioTemplateRecipe;
};

export type PublishStudioTemplateRequest = {
  action: 'publish';
  expectedRevision: number;
  expectedVersionId?: string | null;
};

export type ArchiveStudioTemplateRequest = { action: 'archive'; expectedRevision: number };

export type PatchStudioTemplateRequest =
  | UpdateStudioTemplateRequest
  | PublishStudioTemplateRequest
  | ArchiveStudioTemplateRequest;

export type StudioDraftTemplateRef = {
  templateId: string;
  templateSource: StudioTemplateSource;
  versionId: string | null;
  versionNumber: number | null;
  templateName: string;
  sourceRevision?: string | null;
};

export type StudioDraftDto = {
  id: string;
  name: string;
  groupName: string;
  prompt: string;
  values: Record<string, StudioJsonValue>;
  assets: StudioAssetInput[];
  parameters: Record<string, StudioJsonValue>;
  recipe: StudioTemplateRecipe | null;
  revision: number;
  template: StudioDraftTemplateRef | null;
  createdAt: string;
  updatedAt: string;
};

export type StudioDraftListResponse = {
  items: StudioDraftDto[];
  nextCursor: string | null;
};

export type StudioDraftRecoveryInput = {
  name?: string;
  groupName?: string;
  prompt: string;
  values: Record<string, StudioJsonValue>;
  assets: StudioAssetInput[];
  parameters: Record<string, StudioJsonValue>;
};

type CreateStudioDraftOptions = {
  name?: string;
  groupName?: string;
};

export type CreateStudioDraftRequest =
  | (CreateStudioDraftOptions & { templateId?: never; templateSource?: never; fromRunId?: never; fromDraftId?: never; recovery?: never })
  | (CreateStudioDraftOptions & { templateId: string; templateSource: StudioTemplateSource; fromRunId?: never; fromDraftId?: never; recovery?: never })
  | { fromRunId: string; templateId?: never; templateSource?: never; fromDraftId?: never; recovery?: never; name?: never; groupName?: never }
  | { fromDraftId: string; recovery: StudioDraftRecoveryInput; templateId?: never; templateSource?: never; fromRunId?: never; name?: never; groupName?: never };

export type UpdateStudioDraftRequest = {
  name: string;
  groupName: string;
  prompt: string;
  values: Record<string, StudioJsonValue>;
  assets: StudioAssetInput[];
  parameters: Record<string, StudioJsonValue>;
  revision: number;
};

export type StudioRunSnapshot = {
  input: {
    name: string;
    groupName: string;
    values: Record<string, StudioJsonValue>;
    draftPrompt: string;
  };
  templateVersion: StudioDraftTemplateRef | null;
  recipe: StudioTemplateRecipe | null;
  prompt: string;
  parameters: Record<string, StudioJsonValue>;
  assets: StudioAssetInput[];
  owner: {
    userId: string;
    username: string;
    displayName: string;
    accountType: 'internal' | 'external';
  };
};

export type StudioRunDto = {
  id: string;
  draftId: string;
  requestId: string;
  source: StudioRunSource;
  mode: StudioRunMode;
  status: StudioRunStatus;
  prompt: string | null;
  error: string | null;
  thumbnailUrl: string | null;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
};

export type StudioRunListQuery = {
  cursor?: string;
  requestId?: string;
  draftId?: string;
  status?: StudioRunStatus;
  templateId?: string;
  templateSource?: StudioTemplateSource;
  createdAfter?: string;
  createdBefore?: string;
};

export type StudioRunListResponse = {
  items: StudioRunDto[];
  nextCursor: string | null;
};

export type StudioAdminRunTaskDto = {
  id: string;
  status: string;
  deliveryStatus: string | null;
  createdAt: string;
  thumbnailUrl: string | null;
  href: string;
  playUrl: string | null;
  downloadUrl: string | null;
};

export type StudioAdminRunDto = {
  id: string;
  owner: { id: string; displayName: string; avatarUrl: string | null };
  model: string | null;
  source: StudioRunSource;
  mode: StudioRunMode;
  status: StudioRunStatus;
  deliveryState: 'not_sent' | 'sending' | 'response_received' | 'unknown';
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  safeError: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  templateName: string | null;
  taskCount: number;
  tasksTruncated: boolean;
  tasks: StudioAdminRunTaskDto[];
};

export type StudioAdminRunListQuery = {
  cursor?: string;
  status?: StudioRunStatus;
  ownerUserId?: string;
  requestId?: string;
  draftId?: string;
  templateId?: string;
  templateSource?: StudioTemplateSource;
  createdAfter?: string;
  createdBefore?: string;
};

export type StudioAdminRunListResponse = {
  items: StudioAdminRunDto[];
  nextCursor: string | null;
  reviewNotice: string;
};

export type StudioAdminRunDetailResponse = {
  run: StudioAdminRunDto;
  reviewNotice: string;
};

export type CreateStudioRunRequest = {
  draftId: string;
  revision: number;
  requestId: string;
  mode: StudioRunMode;
};

export type CreateStudioRunResponse = { run: StudioRunDto };

export type StudioRunTaskDto = {
  taskId: string;
  status: string;
  deliveryStatus: string | null;
  thumbnailUrl: string | null;
  playUrl: string | null;
  downloadUrl: string | null;
  createdAt: string;
};

export type StudioRunDetailResponse = {
  run: StudioRunDto;
  snapshot: StudioRunSnapshot;
  tasks: StudioRunTaskDto[];
};

export type CancelStudioRunRequest = { action: 'cancel' };

export type StudioCapabilitiesResponse = {
  llmEnabled: boolean;
  llmReason: string | null;
  canManageTemplates: boolean;
  canPublish: boolean;
  canCreatePrivateTemplates: boolean;
};

export type StudioGenerationHandoff = {
  runId: string;
  prompt: string;
  parameters: Record<string, StudioJsonValue>;
  assets: StudioAssetInput[];
  snapshot: StudioRunSnapshot;
  legacyTemplateId: string | null;
};

export type StudioApiError = {
  error: string;
  code?: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'UNAVAILABLE' | 'RATE_LIMITED';
  details?: Record<string, StudioJsonValue>;
};
