import 'server-only';

type WorksIdentity = {
  id: string;
  account_type?: string | null;
  feishu?: {
    tenant_key?: string | null;
    user_id?: string | null;
    open_id?: string | null;
    union_id?: string | null;
  } | null;
};

/** Recommendation experiments remain limited to the original configured account. */
export function canUseWorksRecommendationTrial(user: WorksIdentity | null | undefined) {
  const allowedUserId = process.env.WORKS_PREVIEW_USER_ID?.trim();
  return Boolean(allowedUserId && user?.id === allowedUserId && user.account_type === 'internal');
}

/** Product entry is open to internal Feishu users; individual work permissions remain separate. */
export function canUseWorksPreview(user: WorksIdentity | null | undefined) {
  if (canUseWorksRecommendationTrial(user)) return true;
  if (user?.account_type !== 'internal') return false;
  const feishu = user.feishu;
  const allowedTenant = process.env.FEISHU_ALLOWED_TENANT_KEY?.trim();
  return Boolean(feishu?.tenant_key
    && (!allowedTenant || feishu.tenant_key === allowedTenant)
    && (feishu.user_id || feishu.open_id || feishu.union_id));
}
