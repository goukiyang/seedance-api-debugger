import { redirect } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import { getSession } from '@/lib/auth/session';
import { getVolcengineIpPublicConfigStatus } from '@/lib/provider/volcengine-ip';

export const dynamic = 'force-dynamic';

function statusText(ready: boolean) {
  return ready ? '已配置' : '未配置';
}

function missingText(missing: string[]) {
  if (missing.length === 0) return '无';
  return missing.map((item) => {
    if (item === 'api_key') return 'API Key';
    if (item === 'model') return 'Model ID';
    return item;
  }).join('、');
}

export default async function VolcengineIpIntegrationPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const config = getVolcengineIpPublicConfigStatus();

  return (
    <div className="admin-integrations-page">
      <PageBanner
        eyebrow="管理后台"
        title="火山 IP 生成配置"
        description="只读检查服务端环境变量是否就绪。API Key 不会在页面或接口中回显。"
        backHref="/admin/integrations"
        backLabel="返回 API 设置"
      />

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">火山 IP 生成</span>
          <strong className="stat-value">{statusText(config.ready)}</strong>
          <span className="stat-sub">
            {config.ready ? '可以进入下一批服务端创建任务接入' : `缺少：${missingText(config.missing)}`}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">API Key</span>
          <strong className="stat-value">{statusText(config.api_key_configured)}</strong>
          <span className="stat-sub">仅显示是否配置，不回显任何密钥内容。</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Model ID</span>
          <strong className="stat-value">{statusText(config.model_configured)}</strong>
          <span className="stat-sub">{config.model || '未配置'}</span>
        </div>
      </div>

      <section className="card codex-config-form">
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">服务端配置状态</h2>
            <p className="text-gray text-sm mt-2">
              本页只读取 `VOLCENGINE_IP_API_KEY`、`VOLCENGINE_IP_MODEL`、`VOLCENGINE_IP_BASE_URL`
              或兼容的 `ARK_*` 环境变量，不保存、不修改配置。
            </p>
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">Base URL</span>
            <strong>{config.base_url}</strong>
          </div>
          <div>
            <span className="info-label">创建任务路径</span>
            <strong>{config.create_task_path}</strong>
          </div>
          <div>
            <span className="info-label">缺失项</span>
            <strong>{missingText(config.missing)}</strong>
          </div>
          <div>
            <span className="info-label">真实请求</span>
            <strong>未启用</strong>
          </div>
        </div>
      </section>
    </div>
  );
}
