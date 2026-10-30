import { SEEDANCE_2_5_MODEL_ID } from './seedance-models';

export const SEEDANCE_DRAFT_CONTRACT_VERSION = 'seedance-draft-v1';
export const SEEDANCE_DRAFT_RESOLUTION = '480p' as const;

export type SeedanceDraftContentItem = {
  type: 'draft_task';
  draft_task: {
    id: string;
  };
};

export function isSeedanceDraftCreateEnabled() {
  return process.env.SEEDANCE_DRAFT_CREATE_ENABLED?.trim().toLowerCase() !== 'false';
}

export function isSeedanceDraftUpgradeEnabled() {
  return process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED?.trim().toLowerCase() !== 'false';
}

export function canCreateSeedanceDraft(model: string) {
  return model === SEEDANCE_2_5_MODEL_ID;
}

export function buildSeedanceDraftContent(providerDraftTaskId: string): SeedanceDraftContentItem[] {
  const normalized = providerDraftTaskId.trim();
  if (!normalized) throw new Error('provider Draft ID 不能为空');
  return [{ type: 'draft_task', draft_task: { id: normalized } }];
}

export function buildSeedanceDraftUpgradePayload(input: {
  model: string;
  providerDraftTaskId: string;
  clientRequestId: string;
}) {
  if (!canCreateSeedanceDraft(input.model)) {
    throw new Error('Draft 直出只支持 Seedance 2.5');
  }

  return {
    model: input.model,
    content: buildSeedanceDraftContent(input.providerDraftTaskId),
    resolution: '1080p' as const,
    clientRequestId: input.clientRequestId,
  };
}

export function seedanceDraftCapability() {
  const createEnabled = isSeedanceDraftCreateEnabled();
  const upgradeEnabled = isSeedanceDraftUpgradeEnabled();
  const message = createEnabled
    ? upgradeEnabled
      ? '可生成 480p 样片，完成后可另行生成 1080p；两步分别计费。'
      : '可生成 480p 样片；1080p 升级已关闭。'
    : upgradeEnabled
      ? '样片创建已关闭；已完成的样片仍可另行生成 1080p。'
      : '样片创建和 1080p 升级已关闭，请联系管理员启用。';
  return {
    create_enabled: createEnabled,
    upgrade_enabled: upgradeEnabled,
    contract_version: SEEDANCE_DRAFT_CONTRACT_VERSION,
    status: createEnabled || upgradeEnabled ? 'enabled' as const : 'disabled' as const,
    message,
  };
}
