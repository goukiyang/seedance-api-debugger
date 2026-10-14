import type { ImageStudioModel, ImageStudioQuality, ImageResolution } from './model-catalog';
import type { StudioReferencePolicy } from './reference-policy';
import type { ModuleCoverDTO } from './module-cover-types';

export type SharedStudioReasonCode = 'login-required' | 'access-revoked' | 'source-withdrawn' | 'source-archived'
  | 'source-missing' | 'dependency-invalid' | 'state-conflict' | 'read-unavailable';
export type SharedStudioCapability = { allowed: boolean; reasonCode: SharedStudioReasonCode | null; reason: string | null };
export type SharedStudioCapabilities = Record<'viewOwnHistory' | 'editPersonalDraft' | 'editDefinition' | 'saveDefinition'
  | 'changeSharing' | 'deleteSource' | 'generate', SharedStudioCapability>;
export type SharedStudioStateProjection = {
  objectKind: 'publisher' | 'live' | 'legacy-copy' | 'local';
  lifecycle: 'active' | 'archived' | 'missing';
  sharing: 'shared' | 'private' | 'unknown';
  dependency: 'ready' | 'invalid' | 'unknown';
  reasonCode: SharedStudioReasonCode | null;
  sourceRevision: string | null;
  moduleRevision: number | null;
  definitionToken: string | null;
  capabilities: SharedStudioCapabilities;
};
export type SharedStudioEntryPoint = 'template-library' | 'workbench' | 'unknown';
export type SharedStudioSharingReceipt = {
  action: 'set-sharing'; requestId: string; presetId: string; expectedRevision: string;
  appliedRevision: string; appliedState: { isShared: boolean; lifecycle: 'active' };
  committedAt: string; noOp: boolean; moduleRevision: number | null;
};
export type SharedStudioSharingCurrent = {
  presetId: string; sourceRevision: string; isShared: boolean; lifecycle: 'active' | 'archived'; moduleRevision: number | null;
};
export type SharedStudioCommandStatus = { status: 'not-found' } | {
  status: 'completed'; receipt: Record<string, unknown>; current: SharedStudioSharingCurrent | null;
};
export type SharedStudioLifecycleRevisionState = { sourceRevision?: string | null; moduleRevision?: number | null; isShared?: boolean };
export type SharedStudioLifecycleDetail = {
  requestId?: string; entryPoint?: SharedStudioEntryPoint; before?: SharedStudioLifecycleRevisionState;
  after?: SharedStudioLifecycleRevisionState; changedFields?: string[];
};
export type SharedStudioLifecycleHistoryItem = {
  id: string; action: string; actorUserId: string | null; ownerUserId: string | null; createdAt: string;
  detail: SharedStudioLifecycleDetail;
};
export type SharedStudioLifecycleHistory = { items: SharedStudioLifecycleHistoryItem[]; nextCursor: string | null };
// This is a dedicated author-only read. Ordinary unavailable DTOs never supply
// placeholder empty collections as an editable definition.
export type SharedStudioRepairReference = { id: string; status: 'valid' | 'missing' | 'inaccessible'; image?: SharedStudioImageDTO };
export type SharedStudioFixedReferenceRepair = { sourceIndex: number; originalAssetId: string; replacementAssetId: string | null };
export type SharedStudioRepairDefinition = {
  sourceRevision: string; definitionToken: string; name: string; groupName: string; templatePrompt: string;
  context: string; defaults: SharedStudioDefaults;
  templateReferences: SharedStudioRepairReference[];
  fixedReferences: Array<SharedStudioRepairReference & { note?: string; sourceIndex?: number; repairable?: boolean }>;
  styleGroups: Array<{ id: string; status: 'valid' | 'missing' | 'inaccessible'; name?: string; revision?: number }>;
  skillIds: string[];
  skillGroups: Array<{ id: string; status: 'valid' | 'missing' | 'inaccessible'; name?: string; revision?: number }>;
  banner?: SharedStudioRepairReference | null;
  fixedReferencesEditable?: boolean;
  fixedReferenceRepairAllowed?: boolean;
  fixedReferenceRestriction?: string;
  skillRestriction?: string;
  reproductionConfigured?: boolean;
  globalContext?: string;
};

export type SharedStudioIntent = {
  protocol: 'shared-live-v1';
  presetId: string;
  definitionToken: string;
};
export type SharedStudioDefaults = {
  model: ImageStudioModel;
  quality: ImageStudioQuality;
  resolution: ImageResolution;
  count: number;
  aspectRatio: string;
  referenceLimit: number;
  referencePolicy: StudioReferencePolicy;
};
export type SharedStudioPersonalOverrides = Partial<Pick<SharedStudioDefaults, 'model' | 'quality' | 'resolution' | 'count' | 'aspectRatio'>> & { prompt?: string };
export type SharedStudioOverrideField = keyof SharedStudioPersonalOverrides;
// Optional personal changes submitted alongside an explicit definition save.
export type SharedStudioDefinitionPersonalInput = {
  personalOverrides?: SharedStudioPersonalOverrides;
  resetFields?: SharedStudioOverrideField[];
  personalReferenceIds?: string[];
  personalReferencePolicy?: StudioReferencePolicy;
};
export type SharedStudioLiveDTO = SharedStudioIntent & Partial<SharedStudioStateProjection> & {
  intent: SharedStudioIntent;
  mode: 'publisher' | 'live';
  available: boolean;
  unavailableReason?: string;
  overriddenFields: SharedStudioOverrideField[];
  defaults?: SharedStudioDefaults;
  repairDefinition?: SharedStudioRepairDefinition;
};
export type SharedStudioImageDTO = { id: string; originalUrl: string; thumbnailUrl: string; width: number | null; height: number | null };
export type SharedStudioPublicDefinition = Partial<SharedStudioStateProjection> & {
  intent: SharedStudioIntent;
  presetId: string;
  revision: string;
  name: string;
  groupName: string;
  banner: SharedStudioImageDTO | null;
  fixedCover: ModuleCoverDTO | null;
  coverEditable: boolean;
  templatePrompt: string;
  context: string;
  contextConfigured: boolean;
  contextEditable: boolean;
  canManageSharing: boolean;
  ownedByViewer: boolean;
  isShared: boolean;
  defaults: SharedStudioDefaults;
  templateReferenceIds: string[];
  images: SharedStudioImageDTO[];
  fixedReferenceCount: number;
  fixedReferences: Array<SharedStudioImageDTO & { note: string; available: boolean }>;
  styleGroupIds: string[];
  styleGroups: Array<{ id: string; name: string; revision: number; referenceCount: number; coverUrl: string; canManage: boolean }>;
  reproductionConfigured: boolean;
};
export type SharedStudioCatalogItem = Partial<SharedStudioStateProjection> & {
  presetId: string;
  isShared: boolean;
  name: string;
  groupName: string;
  banner: SharedStudioImageDTO | null;
  fixedCover: ModuleCoverDTO | null;
  coverEditable: boolean;
  revision: string;
  available: boolean;
  unavailableReason?: string;
};
export type SharedStudioCatalog = { items: SharedStudioCatalogItem[]; nextCursor: string | null; catalogRevision: string };
export type SharedStudioRevision = {
  catalogRevision: string; activeDefinitionToken: string | null; activeAvailable: boolean;
  activeState?: SharedStudioStateProjection | null;
};
