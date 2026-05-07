import AdminPlaceholderPage from '@/components/AdminPlaceholderPage';

export default async function AdminExceptionsPage() {
  return (
    <AdminPlaceholderPage
      title="异常任务"
      description="该页面将用于查看失败、阻塞或异常状态任务，并支持后续人工跟进。"
      currentPath="/admin/exceptions"
    />
  );
}
