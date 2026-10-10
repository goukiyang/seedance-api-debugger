import { feedbackPrisma as prisma, FEEDBACK_NOTIFICATION_TYPE, parseFeedbackDelivery } from '../src/lib/feedback/notification';

prisma.notification.findMany({ where: { channel: 'feishu', type: FEEDBACK_NOTIFICATION_TYPE },
  orderBy: { created_at: 'desc' }, take: 50,
  select: { id: true, status: true, metadata_json: true, error_message: true, created_at: true, sent_at: true },
}).then(rows => console.log(JSON.stringify(rows.map(row => {
  const meta = parseFeedbackDelivery(row.metadata_json);
  return { id: row.id, status: row.status, state: meta?.state || 'invalid', feedbackId: meta?.feedbackId,
    attempts: meta?.attempts, nextAttemptAt: meta?.nextAttemptAt, firstSendAt: meta?.firstSendAt,
    receiptId: meta?.receiptId, errorCode: row.error_message, createdAt: row.created_at, sentAt: row.sent_at };
}))))
  .catch(() => { console.error('feedback_delivery_inspection_failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
