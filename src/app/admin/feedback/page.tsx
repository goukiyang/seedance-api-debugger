import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { displayUserName } from '@/lib/users/display';
import AdminFeedbackClient from './AdminFeedbackClient';

export default async function AdminFeedbackPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminFeedbackClient currentUserName={displayUserName(user)} />;
}
