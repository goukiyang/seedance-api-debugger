import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type ContentAuditClient = typeof prisma | Prisma.TransactionClient;

export type ContentAuditParams = {
  actorUserId: string | null;
  action: string;
  contentType: string;
  contentId: string;
  ownerUserId?: string | null;
  projectId?: string | null;
  detail?: Record<string, unknown>;
};

export async function recordContentAuditLog(
  params: ContentAuditParams,
  client: ContentAuditClient = prisma,
) {
  await client.contentAuditLog.create({
    data: {
      actor_user_id: params.actorUserId,
      action: params.action,
      content_type: params.contentType,
      content_id: params.contentId,
      owner_user_id: params.ownerUserId || null,
      project_id: params.projectId || null,
      detail_json: params.detail ? JSON.stringify(params.detail) : null,
    },
  });
}
