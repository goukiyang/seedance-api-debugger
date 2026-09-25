import { redirect } from 'next/navigation';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import CanvasFrame from './CanvasFrame';

export const dynamic = 'force-dynamic';

export default async function UltimateCanvasPage({ searchParams }: { searchParams?: { document_id?: string } }) {
  const user = await getSession();
  const documentId = typeof searchParams?.document_id === 'string' ? searchParams.document_id : undefined;
  if (!user) {
    const target = `/tools/ultimate-canvas${documentId ? `?document_id=${encodeURIComponent(documentId)}` : ''}`;
    redirect(`/login?next=${encodeURIComponent(target)}`);
  }
  if (isExternalUser(user)) redirect(externalFallbackPath());

  return (
    <main className="ultimate-canvas-page">
      <section className="ultimate-canvas-frame-shell" aria-label="无线画布工具">
        <CanvasFrame documentId={documentId} />
      </section>
    </main>
  );
}
