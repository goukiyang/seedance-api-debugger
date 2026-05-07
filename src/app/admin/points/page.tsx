import AdminPlaceholderPage from '@/components/AdminPlaceholderPage';

export default async function AdminPointsPage() {
  return (
    <AdminPlaceholderPage
      title="积分管理"
      description="该页面将用于管理平台积分规则、手工调整操作与审核追踪流程。"
      currentPath="/admin/points"
    />
  );
}
