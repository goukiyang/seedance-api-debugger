import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getFeatureProfileLabel, getUserProfileLabel } from '@/lib/users/profiles';
import { isSyntheticFeishuEmail } from '@/lib/users/display';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { readCreditSummary } from '@/lib/credits/policy';

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

  const summary = await readCreditSummary(prisma, user.id);
  const creditAccount = summary.account;

  const emailText = isSyntheticFeishuEmail(user.email) ? '未绑定真实邮箱' : user.email;

  return (
    <div>
      <PageBanner eyebrow="账户" title="个人页" description="查看当前登录账号、权限和积分状态。" />

      <div className="card">
        <h2 className="section-title">账号信息</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">用户名</span>
            <span className="info-value">
              <UserIdentityBadge user={user} size="sm" showEmail />
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">邮箱</span>
            <span className="info-value">{emailText}</span>
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
              {summary.available}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">长期余额</span>
            <span className="info-value">{creditAccount?.balance ?? 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">冻结积分</span>
            <span className="info-value">{summary.frozen_credits}</span>
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
        <h3 className="section-title mt-4">周期额度</h3>
        {summary.periodic?.next_refresh && <p>下次刷新：{formatDate(new Date(summary.periodic.next_refresh))}</p>}
        {summary.buckets.length === 0 ? <p className="text-gray">当前没有可用或待结算的周期额度</p> :
          <div className="table-container"><table className="table"><thead><tr><th>来源</th><th>本期额度</th><th>可用</th><th>生成中占用</th><th>到期时间</th></tr></thead>
            <tbody>{summary.buckets.map(bucket => <tr key={bucket.id}><td>{bucket.name}{bucket.expired ? '（已到期，等待任务结算）' : ''}</td>
              <td>{bucket.total}</td><td>{bucket.remaining}</td><td>{bucket.frozen}</td><td>{formatDate(bucket.expires_at)}</td></tr>)}</tbody></table></div>}
      </div>
    </div>
  );
}
