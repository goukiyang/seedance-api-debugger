import { AuthError } from '@/lib/auth/session';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getProjectAccess } from '@/lib/projects/permissions';

const DELETED_STATUS = 'deleted';

async function loadCanvas(canvasId: string) {
  return prisma.canvasDocument.findUnique({
    where: { id: canvasId },
    include: {
      owner: {
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
        },
      },
      project: {
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          owner_user_id: true,
        },
      },
    },
  });
}

export type CanvasRecord = Awaited<ReturnType<typeof loadCanvas>>;

export async function getCanvasAccess(user: SessionUser, canvasOrId: string | NonNullable<CanvasRecord>) {
  const canvas = typeof canvasOrId === 'string' ? await loadCanvas(canvasOrId) : canvasOrId;

  if (!canvas || canvas.status === DELETED_STATUS) {
    return {
      canvas: null,
      role: null,
      canView: false,
      canEdit: false,
      canDelete: false,
    };
  }

  if (user.role === 'admin') {
    return {
      canvas,
      role: 'admin',
      canView: true,
      canEdit: true,
      canDelete: true,
    };
  }

  if (canvas.owner_user_id === user.id) {
    return {
      canvas,
      role: 'owner',
      canView: true,
      canEdit: true,
      canDelete: true,
    };
  }

  if (!canvas.project_id) {
    return {
      canvas,
      role: null,
      canView: false,
      canEdit: false,
      canDelete: false,
    };
  }

  const projectAccess = await getProjectAccess(user, canvas.project_id);
  const canEdit = projectAccess.role === 'project_owner' || projectAccess.role === 'editor';

  return {
    canvas,
    role: projectAccess.role,
    canView: projectAccess.canView,
    canEdit,
    canDelete: canEdit,
  };
}

export async function assertCanViewCanvas(user: SessionUser, canvasOrId: string | NonNullable<CanvasRecord>) {
  const access = await getCanvasAccess(user, canvasOrId);
  if (!access.canvas) throw new AuthError('画布不存在', 404);
  if (!access.canView) throw new AuthError('无权查看此画布', 403);
  return access.canvas;
}

export async function assertCanEditCanvas(user: SessionUser, canvasOrId: string | NonNullable<CanvasRecord>) {
  const access = await getCanvasAccess(user, canvasOrId);
  if (!access.canvas) throw new AuthError('画布不存在', 404);
  if (!access.canEdit) throw new AuthError('无权编辑此画布', 403);
  return access.canvas;
}

export async function assertCanDeleteCanvas(user: SessionUser, canvasOrId: string | NonNullable<CanvasRecord>) {
  const access = await getCanvasAccess(user, canvasOrId);
  if (!access.canvas) throw new AuthError('画布不存在', 404);
  if (!access.canDelete) throw new AuthError('无权删除此画布', 403);
  return access.canvas;
}
