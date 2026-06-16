import { redirect } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import { getSession } from '@/lib/auth/session';
import NotificationsPageClient from './NotificationsPageClient';

export default async function NotificationsPage() {
  const user = await getSession();
  if (!user) redirect('/login');

  return (
    <div className="notifications-page">
      <PageBanner
        eyebrow="消息"
        title="通知中心"
        description="查看项目、审批、预算和系统状态通知。"
      />
      <NotificationsPageClient />
    </div>
  );
}
