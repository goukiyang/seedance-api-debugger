import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function UltimateCanvasPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/tools/ultimate-canvas');
  if (user.role !== 'admin') redirect('/generate');

  return (
    <div className="ultimate-canvas-page">
      <header className="ultimate-canvas-header">
        <div>
          <div className="ultimate-canvas-kicker">Tools</div>
          <h1>无线画布</h1>
        </div>
        <div className="ultimate-canvas-actions">
          <span className="ultimate-canvas-badge">正式工具</span>
          <span className="ultimate-canvas-badge muted">统一后台配置</span>
          <Link href="/generate" className="ultimate-canvas-link">生成视频</Link>
          <a
            href="/tools/ultimate-canvas/index.html"
            target="_blank"
            rel="noreferrer"
            className="ultimate-canvas-link primary"
          >
            全屏打开
          </a>
        </div>
      </header>

      <section className="ultimate-canvas-frame-shell" aria-label="无线画布工具">
        <iframe
          title="无线画布"
          src="/tools/ultimate-canvas/index.html"
          className="ultimate-canvas-frame"
          referrerPolicy="no-referrer"
          allow="fullscreen"
        />
      </section>
    </div>
  );
}
