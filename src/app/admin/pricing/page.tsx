import AdminPlaceholderPage from '@/components/AdminPlaceholderPage';

export default async function AdminPricingPage() {
  return (
    <AdminPlaceholderPage
      title="计费规则"
      description="该页面将用于定义价格梯度、计费规则以及成本治理配置。"
      currentPath="/admin/pricing"
    />
  );
}
