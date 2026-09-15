import { processCreditDeliveries } from '../src/lib/credits/request-delivery';
import { prisma } from '../src/lib/prisma';

processCreditDeliveries().then((result) => console.log(JSON.stringify(result)))
  .catch(() => { console.error('credit_delivery_worker_failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
