import AdminPlaceholderPage from '@/components/AdminPlaceholderPage';

export default async function AdminFeedbackPage() {
  return (
    <AdminPlaceholderPage
      title="反馈管理"
      description="该页面将用于分流用户反馈、缺陷上报以及支持请求处理流程。"
      currentPath="/admin/feedback"
    />
  );
}
