import { redirect } from 'next/navigation';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import AnimationWorkbenchClient from '@/components/animation/AnimationWorkbenchClient';
import styles from '@/components/animation/animation-workbench.module.css';
import { sanitizeAnimationWorkbenchReturnTo } from '@/components/animation/model';

export const dynamic = 'force-dynamic';

export default async function AnimationWorkbenchPage({
  searchParams,
}: {
  searchParams?: { document_id?: string; project_id?: string; return_to?: string };
}) {
  const user = await getSession();
  const params = new URLSearchParams();
  if (typeof searchParams?.document_id === 'string') params.set('document_id', searchParams.document_id);
  if (typeof searchParams?.project_id === 'string') params.set('project_id', searchParams.project_id);
  const returnTo = sanitizeAnimationWorkbenchReturnTo(searchParams?.return_to);
  if (returnTo) params.set('return_to', returnTo);
  const query = params.size ? `?${params.toString()}` : '';

  if (!user) redirect(`/login?next=${encodeURIComponent(`/tools/animation-workbench${query}`)}`);
  if (isExternalUser(user)) redirect(externalFallbackPath());

  return (
    <main className={styles.page}>
      <AnimationWorkbenchClient
        currentUserId={user.id}
        initialDocumentId={searchParams?.document_id}
        initialProjectId={searchParams?.project_id}
        initialReturnTo={returnTo}
      />
    </main>
  );
}
