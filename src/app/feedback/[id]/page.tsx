import { redirect, notFound } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import PageBanner from '@/components/PageBanner';
import { FeedbackLifecyclePanel } from '@/components/feedback/FeedbackLifecyclePanel';
import styles from '@/components/feedback/feedback-flow.module.css';

export default async function FeedbackDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { round?: string } }) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(params.id)) notFound();
  const user = await getSession();
  const number = Number(searchParams.round), round = Number.isSafeInteger(number) && number > 0 ? number : undefined;
  if (!user) redirect(`/login?next=${encodeURIComponent(`/feedback/${params.id}${round ? `?round=${round}` : ''}`)}`);
  return <main className={styles.page}><PageBanner title="反馈详情" backHref="/feedback" backLabel="我的反馈" />
    <FeedbackLifecyclePanel key={`${user.id}:${params.id}`} owner={user.id} feedbackId={params.id} initialRound={round} /></main>;
}
