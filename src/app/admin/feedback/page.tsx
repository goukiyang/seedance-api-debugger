import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminFeedbackClient from './AdminFeedbackClient';

export default async function AdminFeedbackPage({ searchParams }: { searchParams: { feedbackId?: string | string[] } }) {
  const feedbackId = typeof searchParams.feedbackId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(searchParams.feedbackId) ? searchParams.feedbackId : undefined;
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/admin/feedback${feedbackId ? `?feedbackId=${feedbackId}` : ''}`)}`);
  if (user.role !== 'admin') redirect('/generate');

  return <AdminFeedbackClient key={user.id} currentUser={user} feedbackId={feedbackId} />;
}
