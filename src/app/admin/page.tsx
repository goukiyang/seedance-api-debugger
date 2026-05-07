import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import PagePlaceholder from '@/components/PagePlaceholder';

export default async function AdminPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');

  return (
    <PagePlaceholder
      title="管理总览"
      description="该页面将用于查看平台运行概览、关键运营指标与后台快捷入口。"
      currentPath="/admin"
    />
  );
}
