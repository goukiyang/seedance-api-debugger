import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import type { SessionUser } from '@/lib/auth/session';
import { getProjectAccess } from '@/lib/projects/permissions';

export const VIDEO_CARD_STATUSES = ['draft', 'active', 'reviewing', 'finalized', 'sealed', 'merged', 'archived', 'discarded'] as const;
export const VIDEO_CARD_GENERATABLE_STATUSES = ['draft', 'active', 'reviewing'] as const;

export type VideoCardStatus = typeof VIDEO_CARD_STATUSES[number];

export function normalizeVideoCardStatus(value: unknown, fallback: VideoCardStatus = 'active'): VideoCardStatus {
  return VIDEO_CARD_STATUSES.includes(value as VideoCardStatus) ? value as VideoCardStatus : fallback;
}

export function canGenerateInVideoCardStatus(status: string) {
  return VIDEO_CARD_GENERATABLE_STATUSES.includes(status as typeof VIDEO_CARD_GENERATABLE_STATUSES[number]);
}

export async function getVideoCardAccess(user: SessionUser, videoCardId: string) {
  const videoCard = await prisma.videoCard.findUnique({
    where: { id: videoCardId },
    include: {
      project: true,
      owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
    },
  });

  if (!videoCard) {
    return {
      videoCard: null,
      projectAccess: null,
      canView: false,
      canGenerate: false,
      canManage: false,
    };
  }

  const projectAccess = await getProjectAccess(user, videoCard.project_id);
  const canView = projectAccess.canView;
  const canGenerate = projectAccess.canGenerate && canGenerateInVideoCardStatus(videoCard.status);
  const canManage = projectAccess.canManageProject;

  return { videoCard, projectAccess, canView, canGenerate, canManage };
}

export async function assertCanViewVideoCard(user: SessionUser, videoCardId: string) {
  const access = await getVideoCardAccess(user, videoCardId);
  if (!access.videoCard) throw new AuthError('视频卡不存在', 404);
  if (!access.canView) throw new AuthError('无权查看此视频卡', 403);
  return access;
}

export async function assertCanManageVideoCard(user: SessionUser, videoCardId: string) {
  const access = await getVideoCardAccess(user, videoCardId);
  if (!access.videoCard) throw new AuthError('视频卡不存在', 404);
  if (!access.canManage) throw new AuthError('无权管理此视频卡', 403);
  return access;
}

export async function assertCanGenerateInVideoCard(
  user: SessionUser,
  projectId: string,
  videoCardId: string,
) {
  const access = await getVideoCardAccess(user, videoCardId);
  if (!access.videoCard) throw new AuthError('视频卡不存在', 404);
  if (!access.canView) throw new AuthError('无权查看此视频卡', 403);
  if (access.videoCard.project_id !== projectId) {
    throw new AuthError('视频卡不属于当前项目', 400);
  }
  if (!access.projectAccess?.canGenerate) {
    throw new AuthError('无权在此项目中生成内容', 403);
  }
  if (!canGenerateInVideoCardStatus(access.videoCard.status)) {
    throw new AuthError('视频卡已封板或归档，不能继续生成', 403);
  }
  return access;
}
