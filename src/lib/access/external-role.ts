export type AccountScopedUser = {
  role?: string | null;
  account_type?: string | null;
  feishu?: {
    user_id?: string | null;
    open_id?: string | null;
    union_id?: string | null;
  } | null;
};

export function isExternalUser(user: AccountScopedUser | null | undefined) {
  if (!user || user.role === 'admin') return false;
  if (user.account_type === 'external') return true;

  // 兼容历史邮箱账号：早期自注册用户曾默认写成 internal。
  // 本轮权限口径是“邮箱登录属于外部、飞书登录属于内部”，所以没有飞书身份的普通用户按外部收口。
  const feishu = user.feishu;
  const hasFeishuIdentity = Boolean(feishu?.user_id || feishu?.open_id || feishu?.union_id);
  return !hasFeishuIdentity;
}

export function externalFallbackPath() {
  return '/generate/ip';
}
