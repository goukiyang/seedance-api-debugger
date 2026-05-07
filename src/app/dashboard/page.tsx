import Link from 'next/link';
import { getSession } from '@/lib/auth/session';

export default async function DashboardPage() {
  const user = await getSession();
  const isAdmin = user?.role === 'admin';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">控制台</h1>
        <p className="page-description">
          这里是统一导航入口，可快速前往生成、任务、素材与后台管理等主要页面。
        </p>
      </div>

      <div className="card">
        <h2 className="section-title">常用入口</h2>
        <div className="shell-link-grid">
          <Link href="/generate/quick" className="shell-link-card">
            <strong>快速生成</strong>
            <span>进入轻量化生成入口，后续用于承载快速发起任务的流程。</span>
          </Link>
          <Link href="/generate" className="shell-link-card">
            <strong>生成视频</strong>
            <span>进入现有完整生成页面，保留当前可用的任务创建与最近任务能力。</span>
          </Link>
          <Link href="/tasks" className="shell-link-card">
            <strong>我的任务</strong>
            <span>查看任务进度、结果列表以及已存在的任务详情页面。</span>
          </Link>
          <Link href="/videos" className="shell-link-card">
            <strong>视频库</strong>
            <span>后续用于浏览生成结果、沉淀视频资产与统一管理成片。</span>
          </Link>
          <Link href="/collections" className="shell-link-card">
            <strong>素材分组</strong>
            <span>后续用于管理参考图分组、共享素材与可复用输入资源。</span>
          </Link>
          <Link href="/points" className="shell-link-card">
            <strong>积分流水</strong>
            <span>后续用于查看可用积分、消耗明细以及结算相关记录。</span>
          </Link>
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <h2 className="section-title">管理快捷入口</h2>
          <div className="shell-link-grid">
            <Link href="/admin" className="shell-link-card">
              <strong>管理总览</strong>
              <span>后续用于承载平台总览、运行状态与管理端快捷入口。</span>
            </Link>
            <Link href="/admin/users" className="shell-link-card">
              <strong>用户管理</strong>
              <span>进入现有用户与积分操作页面，保留当前可工作的管理能力。</span>
            </Link>
            <Link href="/admin/tasks" className="shell-link-card">
              <strong>任务管理</strong>
              <span>后续用于集中查看任务队列、审核状态与人工处理入口。</span>
            </Link>
            <Link href="/admin/feedback" className="shell-link-card">
              <strong>反馈管理</strong>
              <span>后续用于承载反馈工单、问题追踪与处理流程。</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
