import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getFeatureProfileLabel, getUserProfileLabel } from '@/lib/users/profiles';

function formatDate(value: Date | null) {
  if (!value) return '无';
  return value.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function roleLabel(role: string) {
  return role === 'admin' ? '管理员' : '普通用户';
}

function accountTypeLabel(type: string) {
  return type === 'external' ? '外部账号' : '内部账号';
}

export default async function AccountPage() {
  const user = await getSession();
  if (!user) redirect('/login');

  const creditAccount = await prisma.creditAccount.findUnique({
    where: { user_id: user.id },
    select: {
      balance: true,
      frozen_credits: true,
      total_used: true,
      monthly_used: true,
      updated_at: true,
    },
  });

  const displayName = user.name || user.username || user.email;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">个人页</h1>
        <p className="page-description">查看当前登录账号、权限和积分状态。</p>
      </div>

      <div className="card">
        <h2 className="section-title">账号信息</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">用户名</span>
            <span className="info-value">{displayName}</span>
          </div>
          <div className="info-item">
            <span className="info-label">邮箱</span>
            <span className="info-value">{user.email}</span>
          </div>
          <div className="info-item">
            <span className="info-label">角色</span>
            <span className="info-value">{roleLabel(user.role)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">账号类型</span>
            <span className="info-value">{accountTypeLabel(user.account_type)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">用户类型</span>
            <span className="info-value">{getUserProfileLabel(user.user_profile)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">能力档案</span>
            <span className="info-value">{getFeatureProfileLabel(user.feature_profile_id)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">账号状态</span>
            <span className="info-value">{user.status === 'active' ? '正常' : user.status}</span>
          </div>
          <div className="info-item">
            <span className="info-label">到期时间</span>
            <span className="info-value">{formatDate(user.expires_at)}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">积分状态</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">可用积分</span>
            <span className="info-value">
              {creditAccount ? Math.max(0, creditAccount.balance - creditAccount.frozen_credits) : 0}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">总余额</span>
            <span className="info-value">{creditAccount?.balance ?? 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">冻结积分</span>
            <span className="info-value">{creditAccount?.frozen_credits ?? 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">本月已用</span>
            <span className="info-value">{creditAccount?.monthly_used ?? 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">累计已用</span>
            <span className="info-value">{creditAccount?.total_used ?? 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">更新时间</span>
            <span className="info-value">{formatDate(creditAccount?.updated_at ?? null)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
