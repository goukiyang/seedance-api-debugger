import { prisma } from '@/lib/prisma';

export async function listAccessibleResourcesForUser(user: { id: string; role: string }) {
  if (user.role === 'admin') {
    return prisma.sharedResource.findMany({
      where: { status: 'active' },
      orderBy: [{ updated_at: 'desc' }, { created_at: 'desc' }],
    });
  }

  return prisma.sharedResource.findMany({
    where: {
      status: 'active',
      OR: [
        { visibility_scope: 'all_users' },
        {
          visibility_scope: 'specific_users',
          scoped_users: {
            some: { user_id: user.id },
          },
        },
      ],
    },
    orderBy: [{ updated_at: 'desc' }, { created_at: 'desc' }],
  });
}

export async function canUserAccessResource(resourceId: string, user: { id: string; role: string }) {
  const resource = await prisma.sharedResource.findUnique({
    where: { id: resourceId },
    include: {
      scoped_users: {
        where: { user_id: user.id },
        select: { id: true },
      },
    },
  });

  if (!resource || resource.status !== 'active') return false;
  if (user.role === 'admin') return true;
  if (resource.visibility_scope === 'all_users') return true;

  return resource.visibility_scope === 'specific_users' && resource.scoped_users.length > 0;
}
