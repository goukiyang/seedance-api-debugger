import { redirect } from 'next/navigation';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import CanvasFrame from './CanvasFrame';

export const dynamic = 'force-dynamic';

export default async function UltimateCanvasPage({ searchParams }: { searchParams?: { document_id?: string; focus_node?: string } }) {
  const user = await getSession();
  const documentId = typeof searchParams?.document_id === 'string' ? searchParams.document_id : undefined;
  const focusNodeId = typeof searchParams?.focus_node === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(searchParams.focus_node)
    ? searchParams.focus_node : undefined;
  if (!user) {
    const query = new URLSearchParams();
    if (documentId) query.set('document_id', documentId);
    if (focusNodeId) query.set('focus_node', focusNodeId);
    const target = `/tools/ultimate-canvas${query.size ? `?${query}` : ''}`;
    redirect(`/login?next=${encodeURIComponent(target)}`);
  }
  if (isExternalUser(user)) redirect(externalFallbackPath());

  return (
    <main className="ultimate-canvas-page">
      <section className="ultimate-canvas-frame-shell" aria-label="无线画布工具">
        <CanvasFrame documentId={documentId} focusNodeId={focusNodeId} />
      </section>
    </main>
  );
}
