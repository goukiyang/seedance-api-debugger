import type { SessionUser } from '@/lib/auth/session';

type FeishuIdentity = {
  user_id?: string | null;
  open_id?: string | null;
  union_id?: string | null;
  tenant_key?: string | null;
};

export type ImageStudioIdentity = {
  id: string;
  role: string;
  account_type: string;
  feishu?: FeishuIdentity | null;
  feishu_user_id?: string | null;
  feishu_open_id?: string | null;
  feishu_union_id?: string | null;
  feishu_tenant_key?: string | null;
};

export type StudioPresetAccessRow = {
  owner_id: string;
  scope: string;
  is_shared: boolean;
};

function identityFeishu(user: ImageStudioIdentity) {
  return {
    userId: user.feishu?.user_id ?? user.feishu_user_id ?? null,
    openId: user.feishu?.open_id ?? user.feishu_open_id ?? null,
    unionId: user.feishu?.union_id ?? user.feishu_union_id ?? null,
    tenantKey: user.feishu?.tenant_key ?? user.feishu_tenant_key ?? null,
  };
}

/**
 * Image Studio's sharing boundary is narrower than the general internal-user
 * feature guard. Shared templates require an internal Feishu identity from
 * the configured tenant when one is configured. An internal administrator may
 * still manage their own templates when their account predates Feishu login,
 * but a regular user must have a Feishu identity. An external account never
 * crosses this boundary, even if its role column says admin.
 */
export function canUseCompanyTemplates(user: ImageStudioIdentity | SessionUser) {
  if (user.account_type !== 'internal') return false;
  if (user.role === 'admin') return true;
  const feishu = identityFeishu(user);
  const allowedTenant = process.env.FEISHU_ALLOWED_TENANT_KEY?.trim();
  return Boolean(
    feishu.tenantKey
    && (!allowedTenant || feishu.tenantKey === allowedTenant)
    && (feishu.userId || feishu.openId || feishu.unionId),
  );
}

export function canViewStudioPreset(
  user: ImageStudioIdentity | SessionUser,
  preset: StudioPresetAccessRow,
) {
  if (!canUseCompanyTemplates(user)) return false;
  if (preset.owner_id === user.id) return true;
  return (preset.scope === 'admin' || preset.scope === 'creator') && preset.is_shared;
}

export function canManageStudioPreset(
  user: ImageStudioIdentity | SessionUser,
  preset: StudioPresetAccessRow,
) {
  return canUseCompanyTemplates(user)
    && user.role === 'admin'
    && preset.scope === 'admin'
    && preset.owner_id === user.id;
}

export function isExplicitPresetAsset(preset: { banner_asset_id: string | null; reference_ids: string }, assetId: string) {
  if (preset.banner_asset_id === assetId) return true;
  try {
    const ids = JSON.parse(preset.reference_ids) as unknown;
    return Array.isArray(ids) && ids.includes(assetId);
  } catch {
    return false;
  }
}
