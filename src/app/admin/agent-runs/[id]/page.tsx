import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { taskDetailHref } from '@/lib/navigation/return-to';

export const dynamic = 'force-dynamic';

type PageProps = { params: { id: string } };

function safeJson(value: string | null, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatDate(value: Date | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export default async function AdminAgentRunDetailPage({ params }: PageProps) {
  const user = await getSession();
  if (!user) redirect(`/login?next=/admin/agent-runs/${params.id}`);
  if (user.role !== 'admin') redirect('/generate');

  const run = await prisma.agentRun.findUnique({
    where: { id: params.id },
    include: {
      template: { select: { id: true, name: true, template_key: true, version: true, status: true } },
      steps: { orderBy: { sort_order: 'asc' } },
    },
  });
  if (!run) notFound();

  const memories = await prisma.templateMemory.findMany({
    where: { agent_run_id: run.id },
    orderBy: { created_at: 'desc' },
  });

  return (
    <main className="admin-agent-runs-page">
      <header className="admin-agent-runs-head">
        <div>
          <span>Agent Trace</span>
          <h1>{run.template.name}</h1>
          <p>{run.template.template_key} · {run.template.version} · {formatDate(run.created_at)}</p>
        </div>
        <div className="admin-agent-runs-actions">
          {run.video_task_id && <Link href={taskDetailHref(run.video_task_id, `/admin/agent-runs/${run.id}`)}>查看任务</Link>}
          <Link href="/admin/agent-runs">返回列表</Link>
        </div>
      </header>

      <section className="admin-agent-run-summary">
        <div><span>状态</span><strong>{run.status}</strong></div>
        <div><span>选中方案</span><strong>{run.selected_plan_key || '-'}</strong></div>
        <div><span>用户编辑</span><strong>{run.user_edited ? '是' : '否'}</strong></div>
        <div><span>完成时间</span><strong>{formatDate(run.completed_at)}</strong></div>
      </section>

      <section className="admin-agent-run-prompts">
        <article>
          <h2>Agent Prompt</h2>
          <pre>{run.agent_prompt_snapshot || '暂无'}</pre>
        </article>
        <article>
          <h2>最终 Prompt</h2>
          <pre>{run.final_prompt_snapshot || '暂无'}</pre>
        </article>
      </section>

      <section className="admin-agent-run-timeline">
        <h2>执行步骤</h2>
        {run.steps.map((step) => (
          <article className="admin-agent-run-step" key={step.id}>
            <div className="admin-agent-run-step-head">
              <span>{String(step.sort_order).padStart(2, '0')}</span>
              <div>
                <strong>{step.title}</strong>
                <small>{step.step_key}</small>
              </div>
            </div>
            <div className="admin-agent-run-step-grid">
              <div>
                <h3>输入</h3>
                <pre>{pretty(safeJson(step.input_json, null))}</pre>
              </div>
              <div>
                <h3>输出</h3>
                <pre>{pretty(safeJson(step.output_json, null))}</pre>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="admin-agent-run-memory">
        <h2>Memory 记录</h2>
        {memories.length === 0 ? (
          <p>暂无 Memory 记录。</p>
        ) : memories.map((memory) => (
          <div key={memory.id}>
            <span>{memory.memory_type} · {memory.signal}</span>
            <strong>{memory.summary}</strong>
            <small>{formatDate(memory.created_at)}</small>
          </div>
        ))}
      </section>
    </main>
  );
}
