import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminTasksClient from './AdminTasksClient';

const allowedAttentionFilters = new Set(['exceptions', 'abnormal', 'failed', 'frozen', 'refund', 'all']);

function readString(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : '';
}

function readPositiveInt(value: string | string[] | undefined) {
  const parsed = parseInt(readString(value) || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export default async function AdminTasksPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const params = searchParams ? await searchParams : undefined;
  const attention = readString(params?.attention);

  return (
    <AdminTasksClient
      currentUser={user}
      initialFilters={{
        user: readString(params?.user),
        status: readString(params?.status),
        model: readString(params?.model),
        from: readString(params?.from),
        to: readString(params?.to),
        frozen: readString(params?.frozen) === '1',
        attention: allowedAttentionFilters.has(attention) ? attention : 'exceptions',
        page: readPositiveInt(params?.page),
      }}
    />
  );
}
