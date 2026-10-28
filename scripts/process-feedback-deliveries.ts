import { processFeedbackDeliveries } from '../src/lib/feedback/delivery';
import { processFeedbackRetestDeliveries } from '../src/lib/feedback/retest-delivery';
import { processVideoFeishuDeliveries } from '../src/lib/video/feishu-delivery';
import { processImageFeishuDeliveries } from '../src/lib/image-studio/feishu-delivery';
import { feedbackPrisma as prisma } from '../src/lib/feedback/notification';
import { prisma as videoPrisma } from '../src/lib/prisma';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

async function deliveries() {
  // These queues own different notification types. One unavailable queue must not starve the others.
  const names = ['feedback', 'retest', 'video', 'image'];
  const outcomes = await Promise.allSettled([processFeedbackDeliveries(), processFeedbackRetestDeliveries(), processVideoFeishuDeliveries(1), processImageFeishuDeliveries(1)]);
  const failedQueues = names.filter((_, index) => outcomes[index].status === 'rejected');
  if (failedQueues.length) process.exitCode = 1;
  return { queues: Object.fromEntries(outcomes.map((item, index) => [names[index], item.status === 'fulfilled' ? item.value : null])), failedQueues };
}
deliveries().then(result => {
  console.log(JSON.stringify(result));
  if (process.env.TMPDIR !== '/data/video-api-debugger/feedback-delivery/tmp') return;
  try {
    const cwd = realpathSync(process.cwd());
    const hash = (file: string) => createHash('sha256').update(readFileSync(path.join(cwd, file))).digest('hex');
    const receipt = { at: new Date().toISOString(), cwd, version: JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).version,
      notificationSha: hash('src/lib/feedback/notification.ts'), deliverySha: hash('src/lib/feedback/delivery.ts'),
      retestDeliverySha: hash('src/lib/feedback/retest-delivery.ts'), videoDeliverySha: hash('src/lib/video/feishu-delivery.ts'),
      imageDeliverySha: hash('src/lib/image-studio/feishu-delivery.ts'),
      attachmentsSha: hash('src/lib/feedback/attachments.ts'), result };
    const temporary = path.join(process.env.TMPDIR, `last-run-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(process.env.TMPDIR, 'last-run.json'));
  } catch { console.error('feedback_delivery_receipt_unavailable'); }
})
  .catch(() => { console.error('feedback_delivery_worker_failed'); process.exitCode = 1; })
  .finally(() => Promise.all([prisma.$disconnect(), videoPrisma.$disconnect()]));
