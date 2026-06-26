import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { getTemplateModuleLibrary } from '@/lib/templates/module-library';

export const dynamic = 'force-dynamic';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default async function AdminModulesPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/admin/modules');
  if (user.role !== 'admin') redirect('/generate');

  const library = await getTemplateModuleLibrary();

  return (
    <main className="admin-modules-page">
      <header className="admin-modules-head">
        <div>
          <span>Module Library</span>
          <h1>模块库</h1>
          <p>查看由 Module Builder Agent 保存的正式模块、来源模板和版本记录。</p>
        </div>
        <div>
          <Link href="/templates">LLM 新增模块</Link>
          <Link href="/admin/agent-runs">执行链路</Link>
        </div>
      </header>

      <section className="admin-modules-grid">
        {library.modules.length === 0 ? (
          <article className="admin-modules-empty">
            <strong>还没有正式模块</strong>
            <p>进入模板管理页，打开模板后用 Module Builder 生成并保存模块。</p>
            <Link href="/templates">去模板管理</Link>
          </article>
        ) : library.modules.map((moduleItem) => {
          const latestVersion = moduleItem.versions[moduleItem.versions.length - 1];
          return (
            <article className="admin-module-card" key={moduleItem.id}>
              <div className="admin-module-card-head">
                <span>{moduleItem.module_type}</span>
                <em>{moduleItem.status}</em>
              </div>
              <h2>{moduleItem.name}</h2>
              <dl>
                <div><dt>模块 ID</dt><dd>{moduleItem.id}</dd></div>
                <div><dt>来源模板</dt><dd>{moduleItem.source.template_name}</dd></div>
                <div><dt>范围</dt><dd>{moduleItem.scope === 'global' ? '全局模块' : '模板模块'}</dd></div>
                <div><dt>版本</dt><dd>v{moduleItem.current_version} · {formatDate(moduleItem.updated_at)}</dd></div>
              </dl>
              {latestVersion && (
                <div className="admin-module-card-version">
                  <strong>最新版本</strong>
                  <p>{latestVersion.diff_summary.join(' / ')}</p>
                  <small>{latestVersion.admin_modified ? '管理员修改后保存' : 'LLM 草稿直接保存'}</small>
                </div>
              )}
              {moduleItem.source.agent_run_id && (
                <Link href={`/admin/agent-runs/${moduleItem.source.agent_run_id}`}>查看生成链路</Link>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}
