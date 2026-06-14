import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { taskDetailHref } from '@/lib/navigation/return-to';
import { AgentRunTraceActions } from '@/components/agent/AgentRunTraceActions';

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
  return JSON.stringify(redactSensitive(value), null, 2);
}

function redactSensitive(value: unknown, parentKey = ''): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, parentKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, childValue]) => [
        key,
        redactSensitive(childValue, key),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  const sensitiveKey = /(token|secret|cookie|authorization|password|api[_-]?key|access[_-]?key|refresh|signature|signed|url|uri)/i;
  if (sensitiveKey.test(parentKey)) return value ? '[已脱敏]' : value;
  return value.replace(/https?:\/\/[^\s"'<>]+/g, '[已脱敏链接]');
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

function formatDuration(ms: number | null) {
  if (ms === null) return '-';
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const TRACE_STEPS = [
  { key: 'intent_parse', label: 'Intent', fallbackTitle: 'Intent 解析' },
  { key: 'template_load', label: 'Template Load', fallbackTitle: '模板加载' },
  { key: 'module_composer', label: 'Module Composer', fallbackTitle: '模块组合' },
  { key: 'rule_compute', label: 'Rule Engine', fallbackTitle: '规则计算' },
  { key: 'prompt_compose', label: 'Prompt Compiler', fallbackTitle: 'Prompt 生成' },
  { key: 'plan_generate', label: 'Plan Generator', fallbackTitle: '方案生成' },
  { key: 'validator', label: 'Validator', fallbackTitle: '提交校验' },
  { key: 'seedance_execution', label: 'Seedance Execution', fallbackTitle: 'Seedance 执行' },
  { key: 'memory_record', label: 'Memory Record', fallbackTitle: 'Memory 记录' },
];

function stepStatusClass(exists: boolean, runStatus: string) {
  if (exists) return 'is-done';
  if (runStatus === 'failed') return 'is-missing';
  return 'is-pending';
}

function ruleTypeLabel(type: string) {
  if (type === 'must') return 'MUST';
  if (type === 'forbid') return 'FORBID';
  return 'SUGGEST';
}

export default async function AdminAgentRunDetailPage({ params }: PageProps) {
  const user = await getSession();
  if (!user) redirect(`/login?next=/admin/agent-runs/${params.id}`);
  if (user.role !== 'admin') redirect('/generate');

  const run = await prisma.agentRun.findUnique({
    where: { id: params.id },
    include: {
      template: {
        select: {
          id: true,
          name: true,
          template_key: true,
          version: true,
          status: true,
          module_bindings_json: true,
          temporal_json: true,
          rules: {
            orderBy: [{ rule_type: 'asc' }, { sort_order: 'asc' }],
            select: { id: true, rule_type: true, content: true, priority: true, status: true },
          },
          assets: {
            orderBy: [{ sort_order: 'asc' }],
            select: { id: true, asset_type: true, label: true, thumbnail_url: true, url: true, status: true },
          },
        },
      },
      steps: { orderBy: { sort_order: 'asc' } },
    },
  });
  if (!run) notFound();

  const memories = await prisma.templateMemory.findMany({
    where: { agent_run_id: run.id },
    orderBy: { created_at: 'desc' },
  });
  const orderedSteps = [...run.steps].sort((a, b) => a.sort_order - b.sort_order);
  const stepsByKey = new Map(run.steps.map((step) => [step.step_key, step]));
  const userInput = safeJson(run.user_input_json, {});
  const plans = safeJson(run.plans_json, []);
  const modules = safeJson(run.template.module_bindings_json, {});
  const temporal = safeJson(run.template.temporal_json, {});
  const moduleRecord = modules && typeof modules === 'object' && !Array.isArray(modules) ? modules as Record<string, unknown> : {};
  const activeRules = run.template.rules.filter((rule) => rule.status === 'active');
  const seedancePayloadSummary = {
    template_id: run.template_id,
    agent_run_id: run.id,
    video_task_id: run.video_task_id,
    video_card_id: run.video_card_id,
    selected_agent_plan_key: run.selected_plan_key,
    final_prompt_snapshot: run.final_prompt_snapshot,
    user_edited: run.user_edited,
  };
  const traceReport = redactSensitive({
    traceId: run.id,
    status: run.status,
    template: run.template,
    userInput,
    modules,
    temporal,
    rules: activeRules,
    plans,
    seedancePayloadSummary,
    steps: run.steps,
    memories,
  });

  return (
    <main className="admin-agent-runs-page">
      <header className="admin-agent-runs-head">
        <div>
          <span>Agent Trace</span>
          <h1>{run.template.name}</h1>
          <p>{run.template.template_key} · {run.template.version} · Trace {run.id}</p>
        </div>
        <div className="admin-agent-runs-actions">
          <Link href="/template-generate">返回模板生成</Link>
          {run.video_task_id && <Link href={taskDetailHref(run.video_task_id, `/admin/agent-runs/${run.id}`)}>查看任务</Link>}
          <Link href="/admin/agent-runs">返回列表</Link>
        </div>
        <AgentRunTraceActions traceId={run.id} report={traceReport} />
      </header>

      <section className="admin-agent-run-summary">
        <div><span>状态</span><strong>{run.status}</strong></div>
        <div><span>选中方案</span><strong>{run.selected_plan_key || '-'}</strong></div>
        <div><span>用户编辑</span><strong>{run.user_edited ? '是' : '否'}</strong></div>
        <div><span>创建时间</span><strong>{formatDate(run.created_at)}</strong></div>
        <div><span>错误信息</span><strong>{run.error_message || '-'}</strong></div>
      </section>

      <section className="admin-agent-run-chain" aria-label="Agent 执行链路">
        {TRACE_STEPS.map((traceStep, index) => {
          const step = stepsByKey.get(traceStep.key);
          return (
            <article className={`admin-agent-run-chain-card ${stepStatusClass(Boolean(step), run.status)}`} key={traceStep.key}>
              <span>{index + 1}</span>
              <strong>{traceStep.label}</strong>
              <small>{step?.title || traceStep.fallbackTitle}</small>
            </article>
          );
        })}
      </section>

      <section className="admin-agent-run-inspector">
        <article className="admin-agent-run-panel">
          <h2>命中规则</h2>
          {activeRules.length === 0 ? (
            <p>当前模板没有启用规则。</p>
          ) : (
            <div className="admin-agent-rule-list">
              {activeRules.map((rule) => (
                <div className={`admin-agent-rule-card is-${rule.rule_type}`} key={rule.id}>
                  <span>{ruleTypeLabel(rule.rule_type)} · P{rule.priority}</span>
                  <strong>{rule.content}</strong>
                  <small>来源：{typeof moduleRecord.rules === 'string' && moduleRecord.rules ? moduleRecord.rules : '模板规则集'}</small>
                </div>
              ))}
            </div>
          )}
        </article>
        <article className="admin-agent-run-panel">
          <h2>输入 / 输出对比</h2>
          <dl className="admin-agent-io-list">
            <div><dt>用户需求</dt><dd><pre>{pretty(userInput)}</pre></dd></div>
            <div><dt>模板模块</dt><dd><pre>{pretty(modules)}</pre></dd></div>
            <div><dt>Temporal</dt><dd><pre>{pretty(temporal)}</pre></dd></div>
            <div><dt>方案</dt><dd><pre>{pretty(plans)}</pre></dd></div>
            <div><dt>Seedance Payload 摘要</dt><dd><pre>{pretty(seedancePayloadSummary)}</pre></dd></div>
          </dl>
        </article>
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
        <h2>执行时间线</h2>
        {orderedSteps.map((step, index) => {
          const previousStep = orderedSteps[index - 1];
          const durationMs = previousStep ? step.created_at.getTime() - previousStep.created_at.getTime() : 0;
          return (
          <article className="admin-agent-run-step" key={step.id}>
            <div className="admin-agent-run-step-head">
              <span>{String(step.sort_order).padStart(2, '0')}</span>
              <div>
                <strong>{step.title}</strong>
                <small>{step.step_key} · 已记录 · 耗时 {formatDuration(durationMs)} · {formatDate(step.created_at)}</small>
              </div>
            </div>
            {run.error_message && run.status === 'failed' && (
              <p className="admin-agent-run-step-error">错误：{run.error_message}</p>
            )}
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
          );
        })}
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
