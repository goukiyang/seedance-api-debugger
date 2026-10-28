import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { feedbackPrisma } from '@/lib/feedback/notification';
import PageBanner from '@/components/PageBanner';
import { RelativeTime } from '@/components/RelativeTime';
import styles from '@/components/feedback/feedback-flow.module.css';

export default async function OwnFeedbackPage({ searchParams }: { searchParams: { page?: string } }) {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Ffeedback');
  const actor = await feedbackPrisma.user.findUnique({ where: { id: user.id }, select: { status: true, expires_at: true } });
  if (!actor || actor.status !== 'active' || actor.expires_at && actor.expires_at.getTime() <= Date.now()) redirect('/login?next=%2Ffeedback');
  const total = await feedbackPrisma.feedback.count({ where: { user_id: user.id } }), pages = Math.max(1, Math.ceil(total / 24));
  const requested = Number(searchParams.page), page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  const rows = await feedbackPrisma.feedback.findMany({ where: { user_id: user.id }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * 24, take: 24, select: { id: true, content: true, created_at: true, status: true } });
  return <main className={styles.page}><PageBanner title="我的反馈" backHref="/" backLabel="创作首页" />
    <ul className={styles.list}>{rows.map(row => <li key={row.id}><Link href={`/feedback/${encodeURIComponent(row.id)}`}>{row.content.length > 160 ? `${row.content.slice(0, 160)}…` : row.content}</Link>
      <p><RelativeTime value={row.created_at.toISOString()} /> · {row.status === 'archived' ? '已归档' : row.status === 'reviewed' ? '已查看' : '新反馈'}</p></li>)}</ul>
    {!rows.length && <p>暂无本人反馈</p>}<nav className={styles.toolbar} aria-label="反馈分页">{page > 1 && <Link href={`/feedback?page=${page - 1}`}>上一页</Link>}<span>{page} / {pages} · {total} 条</span>{page < pages && <Link href={`/feedback?page=${page + 1}`}>下一页</Link>}</nav></main>;
}
