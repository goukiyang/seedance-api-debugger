import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

type NotificationClient = Prisma.TransactionClient | typeof prisma;

interface CreateNotificationInput {
  userId: string;
  type: 'version_update' | 'credit' | 'system';
  title: string;
  body: string;
  href?: string | null;
  sourceType: string;
  sourceId: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

function trimText(value: string, maxLength: number) {
  return value.trim().slice(0, maxLength);
}

export async function createNotification(client: NotificationClient, input: CreateNotificationInput) {
  const title = trimText(input.title, 80);
  const body = trimText(input.body, 600);
  if (!title || !body) return null;

  return client.notification.create({
    data: {
      target_user_id: input.userId,
      actor_user_id: input.actorUserId || null,
      type: input.type,
      channel: 'in_app',
      status: 'pending',
      title,
      body,
      metadata_json: JSON.stringify({
        ...(input.metadata || {}),
        href: input.href || null,
        source_type: input.sourceType,
        source_id: input.sourceId,
      }),
    },
  });
}

export function creditNotificationCopy(type: string, amount: number, reason?: string | null) {
  const absAmount = Math.abs(amount);
  const formatted = Number.isInteger(absAmount) ? String(absAmount) : absAmount.toFixed(2);
  const suffix = reason?.trim() ? `，原因：${reason.trim().slice(0, 80)}` : '';

  if (type === 'admin_grant' || type === 'periodic_grant' || type === 'new_user_initial_grant' || amount > 0) {
    return {
      title: '点数已到账',
      body: `你的账户获得 ${formatted} 点${suffix}。`,
    };
  }

  if (type === 'admin_deduct' || amount < 0) {
    return {
      title: '点数已扣减',
      body: `你的账户扣减 ${formatted} 点${suffix}。`,
    };
  }

  return {
    title: '点数已更新',
    body: `你的账户点数已调整为 ${formatted} 点${suffix}。`,
  };
}
