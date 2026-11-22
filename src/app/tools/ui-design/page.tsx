import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import UiDesignFrame from './UiDesignFrame';
export const dynamic = 'force-dynamic';
export default async function UiDesignPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Ftools%2Fui-design');
  if (user.status !== 'active' || user.account_type !== 'internal' || !canUseCompanyTemplates(user)) redirect('/');
  return <UiDesignFrame userId={user.id} />;
}
