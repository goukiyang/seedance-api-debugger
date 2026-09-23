import { redirect } from 'next/navigation';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function UltimateCanvasPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/tools/ultimate-canvas');
  if (isExternalUser(user)) redirect(externalFallbackPath());

  return (
    <main className="ultimate-canvas-page">
      <section className="ultimate-canvas-frame-shell" aria-label="无线画布工具">
        <iframe
          title="无线画布"
          src="/tools/ultimate-canvas/index.html"
          className="ultimate-canvas-frame"
          referrerPolicy="no-referrer"
          allow="fullscreen"
        />
      </section>
    </main>
  );
}
