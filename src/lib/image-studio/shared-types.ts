import type { ImageStudioModel, ImageStudioQuality, ImageResolution } from './model-catalog';
import type { StudioReferencePolicy } from './reference-policy';

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
export type SharedStudioLiveDTO = SharedStudioIntent & {
  intent: SharedStudioIntent;
  mode: 'publisher' | 'live';
  available: boolean;
  unavailableReason?: string;
  overriddenFields: SharedStudioOverrideField[];
  defaults?: SharedStudioDefaults;
};
export type SharedStudioImageDTO = { id: string; originalUrl: string; thumbnailUrl: string; width: number | null; height: number | null };
export type SharedStudioPublicDefinition = {
  intent: SharedStudioIntent;
  presetId: string;
  revision: string;
  name: string;
  groupName: string;
  banner: SharedStudioImageDTO | null;
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
export type SharedStudioCatalogItem = {
  presetId: string;
  name: string;
  groupName: string;
  banner: SharedStudioImageDTO | null;
  revision: string;
  available: boolean;
};
export type SharedStudioCatalog = { items: SharedStudioCatalogItem[]; nextCursor: string | null; catalogRevision: string };
