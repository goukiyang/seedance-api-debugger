import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { defaultLandingForUser } from '@/lib/access/external-user';

export default async function Home() {
  const user = await getSession();
  if (!user) redirect('/register');
  redirect(defaultLandingForUser(user));
}
