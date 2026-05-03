import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listVisibleResourceDescriptors } from '@/lib/resources';
import ResourcesLibraryClient from './ResourcesLibraryClient';

export default async function ResourcesPage() {
  const user = await getSession();
  if (!user) redirect('/login');

  const resources = await listVisibleResourceDescriptors(user);

  return <ResourcesLibraryClient initialResources={resources} currentUserName={user.name} />;
}
