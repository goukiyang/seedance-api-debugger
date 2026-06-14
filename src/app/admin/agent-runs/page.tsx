import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { taskDetailHref } from '@/lib/navigation/return-to';

export const dynamic = 'force-dynamic';

function formatDate(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function parsePlans(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export default async function AdminAgentRunsPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/admin/agent-runs');
  if (user.role !== 'admin') redirect('/generate');

  const runs = await prisma.agentRun.findMany({
    orderBy: { created_at: 'desc' },
    take: 80,
    include: {
      template: { select: { id: true, name: true, template_key: true, version: true } },
    },
  });

  return (
    <main className="admin-agent-runs-page">
      <header className="admin-agent-runs-head">
        <div>
          <span>Agent Trace</span>
          <h1>执行链路</h1>
          <p>查看模板、规则、方案和 Prompt 如何进入 Seedance 任务。</p>
        </div>
        <Link href="/generate">返回生成页</Link>
      </header>

      <section className="admin-agent-runs-table">
        <div className="admin-agent-runs-row is-head">
          <span>时间</span>
          <span>模板</span>
          <span>状态</span>
          <span>方案</span>
          <span>任务</span>
          <span>操作</span>
        </div>
        {runs.length === 0 ? (
          <p className="admin-agent-runs-empty">暂无 Agent 执行记录。</p>
        ) : runs.map((run) => (
          <div className="admin-agent-runs-row" key={run.id}>
            <span>{formatDate(run.created_at)}</span>
            <span>
              <strong>{run.template.name}</strong>
              <small>{run.template.template_key} · {run.template.version}</small>
            </span>
            <span><em>{run.status}</em></span>
            <span>
              <strong>{run.selected_plan_key || '-'}</strong>
              <small>{parsePlans(run.plans_json)} 个方案</small>
            </span>
            <span>
              {run.video_task_id ? (
                <Link href={taskDetailHref(run.video_task_id, '/admin/agent-runs')}>查看任务</Link>
              ) : '-'}
            </span>
            <span>
              <Link href={`/admin/agent-runs/${run.id}`}>查看链路</Link>
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}
