import { processFeedbackDeliveries } from '../src/lib/feedback/delivery';
import { feedbackPrisma as prisma } from '../src/lib/feedback/notification';

processFeedbackDeliveries().then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error('feedback_delivery_worker_failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
