import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import PagePlaceholder from './PagePlaceholder';

interface AdminPlaceholderPageProps {
  title: string;
  description: string;
  currentPath: string;
}

export default async function AdminPlaceholderPage({
  title,
  description,
  currentPath,
}: AdminPlaceholderPageProps) {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/dashboard');

  return (
    <PagePlaceholder
      title={title}
      description={description}
      currentPath={currentPath}
    />
  );
}
