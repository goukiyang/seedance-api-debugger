import { redirect } from 'next/navigation';
import CanvasWorkspace from '@/components/canvas/full/CanvasWorkspace';
import { getSession } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-user';

export default async function GenerateCanvasPage() {
  const user = await getSession();
  if (isExternalUser(user)) redirect('/generate/ip');
  return <CanvasWorkspace />;
}
