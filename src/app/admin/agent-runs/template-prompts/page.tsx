import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminStudioRunList from '@/components/template-studio/AdminStudioRunList';
import styles from '@/components/template-studio/admin-studio-runs.module.css';

export const dynamic = 'force-dynamic';

export default async function AdminTemplatePromptRunsPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/admin/agent-runs/template-prompts');
  if (user.role !== 'admin') redirect('/generate');

  return (
    <main className="admin-agent-runs-page">
      <header className="admin-agent-runs-head">
        <div>
          <span>模板工作台</span>
          <h1>提示词异常</h1>
          <p>只读查看本站运行结果与关联视频；异常结果需要人工核对。</p>
        </div>
        <div className="admin-agent-runs-actions">
          <Link href="/admin/agent-runs">旧执行链路</Link>
          <Link href="/template-studio?type=video&view=prompts">模板工作台</Link>
        </div>
      </header>
      <div className={styles.adminPageBody}><AdminStudioRunList /></div>
    </main>
  );
}
