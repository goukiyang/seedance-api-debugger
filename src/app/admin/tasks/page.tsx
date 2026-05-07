import AdminPlaceholderPage from '@/components/AdminPlaceholderPage';

export default async function AdminTasksPage() {
  return (
    <AdminPlaceholderPage
      title="任务管理"
      description="该页面将用于查看任务队列、审核状态以及后台人工处理入口。"
      currentPath="/admin/tasks"
    />
  );
}
