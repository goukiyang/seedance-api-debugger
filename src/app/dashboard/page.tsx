import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import PageBanner from '@/components/PageBanner';

export default async function DashboardPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return (
    <div>
      <PageBanner
        eyebrow="平台入口"
        title="控制台"
        description="统一导航入口，可快速前往生成、任务、素材与后台管理等主要页面。"
      />

      <div className="card">
        <h2 className="section-title">常用入口</h2>
        <div className="shell-link-grid">
          <Link href="/generate" className="shell-link-card">
            <strong>生成视频</strong>
            <span>进入现有完整生成页面，保留当前可用的任务创建与最近任务能力。</span>
          </Link>
          <Link href="/generate/enhance" className="shell-link-card">
            <strong>视频超分</strong>
            <span>选择已成功的视频，创建 AI MediaKit 超分任务。</span>
          </Link>
          <Link href="/projects" className="shell-link-card">
            <strong>我的项目</strong>
            <span>创建项目、查看参与项目，并从项目空间进入生成内容。</span>
          </Link>
          <Link href="/tasks" className="shell-link-card">
            <strong>我的任务</strong>
            <span>查看任务进度、结果列表以及已存在的任务详情页面。</span>
          </Link>
          <Link href="/collections" className="shell-link-card">
            <strong>参考图集</strong>
            <span>管理个人、项目和共享参考图，并把图集图片作为生成参考图继续使用。</span>
          </Link>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">管理快捷入口</h2>
        <div className="shell-link-grid">
          <Link href="/admin/users" className="shell-link-card">
            <strong>用户管理</strong>
            <span>进入现有用户与积分操作页面，保留当前可工作的管理能力。</span>
          </Link>
          <Link href="/admin/projects" className="shell-link-card">
            <strong>项目管理</strong>
            <span>查看全部项目、进入项目详情并直接添加项目成员。</span>
          </Link>
          <Link href="/admin/feedback" className="shell-link-card">
            <strong>反馈管理</strong>
            <span>查看用户反馈、导出反馈材料，并跟进已提交的问题。</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
