import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { listBindings } from '@/lib/bridge/device-bindings';
import { displayUserName } from '@/lib/users/display';
import AdminBridgeDevicesClient from './AdminBridgeDevicesClient';

export const dynamic = 'force-dynamic';

export default async function AdminBridgeDevicesPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');
  const [bindings, users] = await Promise.all([
    listBindings(user, 'all'),
    prisma.user.findMany({ where: { status: { not: 'deleted' } },
      select: { id: true, name: true, username: true, avatar_url: true }, orderBy: { name: 'asc' } }),
  ]);
  return <AdminBridgeDevicesClient key={user.id} viewerId={user.id} initialBindings={bindings}
    owners={users.map(owner => ({ id: owner.id, name: displayUserName(owner), avatar_url: owner.avatar_url }))} />;
}
