import AdminPlaceholderPage from '@/components/AdminPlaceholderPage';

export default async function AdminResourcesPage() {
  return (
    <AdminPlaceholderPage
      title="资源管理"
      description="该页面将用于管理共享素材、存储资源以及 Provider 侧关联资源。"
      currentPath="/admin/resources"
    />
  );
}
