import { INTERNAL_EMAIL_FEATURE_PROFILE_ID } from '@/lib/users/profiles';

export type AccountScopedUser = {
  role?: string | null;
  account_type?: string | null;
  feature_profile_id?: string | null;
  feishu?: {
    user_id?: string | null;
    open_id?: string | null;
    union_id?: string | null;
  } | null;
};

export function hasInternalEmailAuthorization(user: AccountScopedUser | null | undefined) {
  return user?.role === 'user'
    && user.account_type === 'internal'
    && user.feature_profile_id === INTERNAL_EMAIL_FEATURE_PROFILE_ID;
}

export function isExternalUser(user: AccountScopedUser | null | undefined) {
  if (!user || user.role === 'admin') return false;
  if (user.account_type === 'external') return true;
  if (hasInternalEmailAuthorization(user)) return false;

  // 兼容历史邮箱账号：早期自注册用户曾默认写成 internal。
  // 邮箱默认属于外部；只有管理员逐账号明确授权时才例外，不扩大旧内部标签的权限。
  const feishu = user.feishu;
  const hasFeishuIdentity = Boolean(feishu?.user_id || feishu?.open_id || feishu?.union_id);
  return !hasFeishuIdentity;
}

export function externalFallbackPath() {
  return '/generate/ip';
}
