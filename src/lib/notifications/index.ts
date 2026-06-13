import type { Prisma } from '@prisma/client';

type NotificationClient = Prisma.TransactionClient;

export async function createInAppNotification(
  tx: NotificationClient,
  input: {
    targetUserId: string;
    type: string;
    title: string;
    body?: string | null;
    actorUserId?: string | null;
    projectId?: string | null;
    videoCardId?: string | null;
    approvalId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  if (!input.targetUserId || !input.title.trim()) return null;
  return tx.notification.create({
    data: {
      target_user_id: input.targetUserId,
      actor_user_id: input.actorUserId || null,
      type: input.type,
      channel: 'in_app',
      status: 'sent',
      project_id: input.projectId || null,
      video_card_id: input.videoCardId || null,
      approval_id: input.approvalId || null,
      title: input.title.trim(),
      body: input.body || null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      sent_at: new Date(),
    },
  });
}

export async function notifyProjectOwner(
  tx: NotificationClient,
  input: {
    projectId: string;
    type: string;
    title: string;
    body?: string | null;
    actorUserId?: string | null;
    videoCardId?: string | null;
    approvalId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const project = await tx.project.findUnique({
    where: { id: input.projectId },
    select: { owner_user_id: true },
  });
  if (!project?.owner_user_id) return null;
  return createInAppNotification(tx, {
    targetUserId: project.owner_user_id,
    type: input.type,
    title: input.title,
    body: input.body,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    videoCardId: input.videoCardId,
    approvalId: input.approvalId,
    metadata: input.metadata,
  });
}
