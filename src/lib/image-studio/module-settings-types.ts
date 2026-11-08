import type { SharedStudioPersonalOverrides } from './shared-types';

export type StudioModuleSettingsValues = Required<SharedStudioPersonalOverrides> & {
  styleGroupIds: string[];
  referenceIds: string[];
};
export type StudioModuleSettingsCommand = {
  requestId: string; moduleId: string; moduleRevision: number; definitionToken?: string;
  name: string; values: StudioModuleSettingsValues;
};
export type StudioModuleSettings = {
  version: 1; id: string; ownerId: string; moduleId: string; name: string;
  values: StudioModuleSettingsValues; createdAt: string;
};
