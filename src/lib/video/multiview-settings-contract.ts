import { isSeedanceVideoDuration, isSeedanceVideoModelId } from '@/lib/provider/seedance-models';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';
import { isMultiviewGenerationSeed, isMultiviewPresetVersion, MULTIVIEW_ROTATION_PRESET, parseMultiviewSettingsBinding, type MultiviewRotationPreset } from './multiview-generation-contract';
export { parseMultiviewSettingsBinding, type MultiviewSettingsBinding } from './multiview-generation-contract';

export type MultiviewSettingsKind = 'generation' | 'frame';
export type MultiviewGenerationSettingsValue = {
  schema: 1; presetId: 'multiview-360'; presetVersion: string; provider: string; generationMode: string;
  model: string; ratio: string; duration: number; resolution: string; supplement: string; seed: number;
  generateAudio: boolean; returnLastFrame: boolean; watermark: boolean;
};
export type MultiviewFrameSettingsSlot = { frame: number; name: string };
export type MultiviewFrameSettingsInput = { schema: 1; slots: MultiviewFrameSettingsSlot[] };
export type MultiviewFrameSettingsTiming = {
  frameCount: number; duration: number; fps: number | null; timelineHash: string; selectedTimestamps: number[];
};
export type MultiviewFrameSettingsValue = MultiviewFrameSettingsInput & { timing: MultiviewFrameSettingsTiming };
export type MultiviewSettingsSummary = {
  id: string; kind: MultiviewSettingsKind; name: string; isShared: boolean; ownedByViewer: boolean;
  revision: number; createdAt: string; updatedAt: string;
};
export type MultiviewSettingsDto = MultiviewSettingsSummary & { contentHash: string } & (
  { kind: 'generation'; value: MultiviewGenerationSettingsValue } | { kind: 'frame'; value: MultiviewFrameSettingsValue }
);
export type MultiviewSettingsSource = { taskId: string; sourceVersion: string };
export type MultiviewSettingsReceipt = { state: 'committed'; mutationId: string; action: 'create' | 'save' | 'rename' | 'delete'; settings: MultiviewSettingsDto };
export type MultiviewSettingsApplyResult = { settings: MultiviewSettingsDto; preset?: MultiviewRotationPreset; slots?: MultiviewFrameSettingsSlot[] };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
export const isMultiviewSettingsId = (value: unknown): value is string => typeof value === 'string' && /^mvs_[a-f0-9-]{36}$/.test(value);
export const isMultiviewSettingsMutationId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function parseMultiviewGenerationSettingsValue(value: unknown): MultiviewGenerationSettingsValue | null {
  if (!record(value) || !only(value, ['schema', 'presetId', 'presetVersion', 'provider', 'generationMode', 'model', 'ratio', 'duration',
    'resolution', 'supplement', 'seed', 'generateAudio', 'returnLastFrame', 'watermark'])
    || value.schema !== 1 || value.presetId !== MULTIVIEW_ROTATION_PRESET.id || !isMultiviewPresetVersion(value.presetVersion)
    || value.provider !== 'seedance' || value.generationMode !== 'all_in_one_reference' || typeof value.model !== 'string' || !isSeedanceVideoModelId(value.model)
    || !isSeedanceVideoDuration(value.duration, value.model as string) || !RATIO_OPTIONS.includes(value.ratio as never)
    || !RESOLUTION_OPTIONS.includes(value.resolution as never) || typeof value.supplement !== 'string' || value.supplement.length > 40000
    || !isMultiviewGenerationSeed(value.seed) || typeof value.generateAudio !== 'boolean' || typeof value.returnLastFrame !== 'boolean'
    || typeof value.watermark !== 'boolean') return null;
  return { schema: 1, presetId: 'multiview-360', presetVersion: value.presetVersion, provider: value.provider, generationMode: value.generationMode,
    model: value.model as string, ratio: value.ratio as string, duration: value.duration, resolution: value.resolution as string,
    supplement: value.supplement, seed: value.seed, generateAudio: value.generateAudio, returnLastFrame: value.returnLastFrame, watermark: value.watermark };
}
export function parseMultiviewFrameSettingsInput(value: unknown): MultiviewFrameSettingsInput | null {
  if (!record(value) || !only(value, ['schema', 'slots']) || value.schema !== 1 || !Array.isArray(value.slots)
    || ![3, 4, 8].includes(value.slots.length) || value.slots.some(slot => !record(slot) || !only(slot, ['frame', 'name'])
      || !Number.isSafeInteger(slot.frame) || Number(slot.frame) < 0 || Number(slot.frame) >= 21600
      || typeof slot.name !== 'string' || slot.name.length > 40)) return null;
  return { schema: 1, slots: value.slots.map(slot => ({ frame: slot.frame as number, name: slot.name as string })) };
}
export function parseMultiviewFrameSettingsValue(value: unknown): MultiviewFrameSettingsValue | null {
  if (!record(value) || !only(value, ['schema', 'slots', 'timing'])) return null;
  const input = parseMultiviewFrameSettingsInput({ schema: value.schema, slots: value.slots });
  const timing = value.timing;
  if (!input || !record(timing) || !only(timing, ['frameCount', 'duration', 'fps', 'timelineHash', 'selectedTimestamps'])
    || !Number.isSafeInteger(timing.frameCount) || Number(timing.frameCount) < 8 || Number(timing.frameCount) > 21600
    || typeof timing.duration !== 'number' || !Number.isFinite(timing.duration) || timing.duration <= 0 || timing.duration > 180
    || timing.fps !== null && (typeof timing.fps !== 'number' || !Number.isFinite(timing.fps) || timing.fps <= 0 || timing.fps > 240)
    || typeof timing.timelineHash !== 'string' || !/^[a-f0-9]{64}$/.test(timing.timelineHash)
    || !Array.isArray(timing.selectedTimestamps) || timing.selectedTimestamps.length !== input.slots.length
    || timing.selectedTimestamps.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 180)
    || input.slots.some(slot => slot.frame >= Number(timing.frameCount))) return null;
  return { ...input, timing: { frameCount: Number(timing.frameCount), duration: timing.duration, fps: timing.fps as number | null,
    timelineHash: timing.timelineHash, selectedTimestamps: [...timing.selectedTimestamps] as number[] } };
}
export function parseMultiviewSettingsDto(value: unknown): MultiviewSettingsDto | null {
  if (!record(value) || !only(value, ['id', 'kind', 'name', 'isShared', 'ownedByViewer', 'revision', 'createdAt', 'updatedAt', 'contentHash', 'value'])
    || !parseMultiviewSettingsBinding({ id: value.id, revision: value.revision }) || typeof value.name !== 'string'
    || !value.name.trim() || value.name.length > 80 || typeof value.isShared !== 'boolean' || typeof value.ownedByViewer !== 'boolean'
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)) return null;
  const parsed = value.kind === 'generation' ? parseMultiviewGenerationSettingsValue(value.value)
    : value.kind === 'frame' ? parseMultiviewFrameSettingsValue(value.value) : null;
  return parsed ? { ...value, value: parsed } as MultiviewSettingsDto : null;
}
