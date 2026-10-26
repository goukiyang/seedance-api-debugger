import { processFeedbackDeliveries } from '../src/lib/feedback/delivery';
import { feedbackPrisma as prisma } from '../src/lib/feedback/notification';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

processFeedbackDeliveries().then(result => {
  console.log(JSON.stringify(result));
  if (process.env.TMPDIR !== '/data/video-api-debugger/feedback-delivery/tmp') return;
  try {
    const cwd = realpathSync(process.cwd());
    const hash = (file: string) => createHash('sha256').update(readFileSync(path.join(cwd, file))).digest('hex');
    const receipt = { at: new Date().toISOString(), cwd, version: JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).version,
      notificationSha: hash('src/lib/feedback/notification.ts'), deliverySha: hash('src/lib/feedback/delivery.ts'),
      attachmentsSha: hash('src/lib/feedback/attachments.ts'), result };
    const temporary = path.join(process.env.TMPDIR, `last-run-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(process.env.TMPDIR, 'last-run.json'));
  } catch { console.error('feedback_delivery_receipt_unavailable'); }
})
  .catch(() => { console.error('feedback_delivery_worker_failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
