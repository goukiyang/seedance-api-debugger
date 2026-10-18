import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminPricingClient from './AdminPricingClient';
import { PRICING_ADMIN_WRITES_ENABLED } from '@/lib/pricing/build-mode';

export const dynamic = 'force-dynamic';

export default async function AdminPricingPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');
  if (!PRICING_ADMIN_WRITES_ENABLED) return <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
    <h1>费率设置维护中</h1>
    <p role="status">已保存的价格和已有任务保持不变，暂不能修改费率。</p>
    <a href="/admin">返回后台</a>
  </main>;
  return <AdminPricingClient actorId={user.id} />;
}
