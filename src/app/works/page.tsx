import { Suspense } from 'react';
import WorksWorkspace from '@/components/works/WorksWorkspace';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseWorksPreview } from '@/lib/works/rollout.server';

export const dynamic = 'force-dynamic';

export default async function WorksPage() {
  const user = await getSession();
  if (!user) redirect('/register');
  if (!canUseWorksPreview(user)) notFound();
  return <Suspense fallback={<div className="container" role="status">正在读取作品…</div>}><WorksWorkspace /></Suspense>;
}
