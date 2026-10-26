import Link from 'next/link';
import { redirect } from 'next/navigation';
import AdminStudioRunDetail from '@/components/template-studio/AdminStudioRunDetail';
import styles from '@/components/template-studio/admin-studio-runs.module.css';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

type PageProps = { params: { id: string } };

export default async function AdminTemplatePromptRunDetailPage({ params }: PageProps) {
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/admin/agent-runs/template-prompts/${params.id}`)}`);
  if (user.role !== 'admin') redirect('/generate');

  return (
    <main className="admin-agent-runs-page">
      <header className="admin-agent-runs-head">
        <div>
          <span>模板工作台</span>
          <h1>运行详情</h1>
          <p>仅展示本站安全投影的数据，不提供上游查询、重试或退款操作。</p>
        </div>
        <div className="admin-agent-runs-actions">
          <Link href="/admin/agent-runs/template-prompts">返回异常记录</Link>
          <Link href="/admin/agent-runs">旧执行链路</Link>
        </div>
      </header>
      <div className={styles.adminPageBody}><AdminStudioRunDetail runId={params.id} /></div>
    </main>
  );
}
