import { SEEDANCE_2_5_MODEL_ID } from './seedance-models';

export const SEEDANCE_DRAFT_CONTRACT_VERSION = 'seedance-draft-v1';

export type SeedanceDraftContentItem = {
  type: 'draft_task';
  draft_task_id: string;
};

export function isSeedanceDraftCreateEnabled() {
  return process.env.SEEDANCE_DRAFT_CREATE_ENABLED === 'true';
}

export function isSeedanceDraftUpgradeEnabled() {
  return process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED === 'true';
}

export function canCreateSeedanceDraft(model: string) {
  return model === SEEDANCE_2_5_MODEL_ID;
}

export function buildSeedanceDraftContent(providerDraftTaskId: string): SeedanceDraftContentItem[] {
  const normalized = providerDraftTaskId.trim();
  if (!normalized) throw new Error('provider Draft ID 不能为空');
  return [{ type: 'draft_task', draft_task_id: normalized }];
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
  return {
    create_enabled: createEnabled,
    upgrade_enabled: upgradeEnabled,
    contract_version: SEEDANCE_DRAFT_CONTRACT_VERSION,
    status: upgradeEnabled ? 'enabled' as const : 'provider_contract_pending' as const,
    message: upgradeEnabled
      ? '可以从已完成的 Draft 直接生成 1080p。'
      : '供应商升级接口尚未完成核验，样片 Draft 入口暂不可用。',
  };
}
