'use client';

import { Suspense, useEffect } from 'react';
import Link from 'next/link';
import PageBanner from '@/components/PageBanner';
import UsageWorkspace from '@/components/usage/UsageWorkspace';
import { useAppSession } from '@/lib/context/AppSessionContext';

function PersonalUsagePage() {
  const { user, hasLoadedUser, loadingUser, refreshUser } = useAppSession();
  useEffect(() => { if (!hasLoadedUser && !loadingUser) void refreshUser(); }, [hasLoadedUser, loadingUser, refreshUser]);
  return <div>
    <PageBanner title="我的用量" backHref="/projects" backLabel="返回我的项目" />
    {!hasLoadedUser || loadingUser ? <p role="status">正在确认账号…</p> : user
      ? <UsageWorkspace key={user.id} ownerId={user.id} />
      : <p>登录后查看本人的用量。<Link className="link" href="/login?return_to=%2Fusage">前往登录</Link></p>}
  </div>;
}

export default function UsagePage() {
  return <Suspense fallback={<p role="status">正在读取用量…</p>}><PersonalUsagePage /></Suspense>;
}
