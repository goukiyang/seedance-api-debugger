import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isVideoDeliveryJobTerminal,
  nextVideoDeliveryRunAfter,
} from '@/lib/video/delivery-queue';

const base = new Date('2026-08-11T10:00:00.000Z');
assert.equal(nextVideoDeliveryRunAfter(0, base).toISOString(), base.toISOString(), 'first delivery attempt should run immediately');
assert.equal(nextVideoDeliveryRunAfter(1, base).toISOString(), '2026-08-11T10:01:00.000Z', 'second attempt should wait 1 minute');
assert.equal(nextVideoDeliveryRunAfter(3, base).toISOString(), '2026-08-11T10:04:00.000Z', 'retry backoff should grow but stay predictable');
assert.equal(isVideoDeliveryJobTerminal('succeeded'), true);
assert.equal(isVideoDeliveryJobTerminal('failed'), true);
assert.equal(isVideoDeliveryJobTerminal('pending'), false);
assert.equal(isVideoDeliveryJobTerminal('running'), false);

const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
assert.match(schema, /model VideoDeliveryJob \{/, 'schema must define the durable video delivery queue table');
assert.match(schema, /task_id\s+String\s+@unique/, 'one task should only have one active delivery job');
assert.match(schema, /delivery_status\s+String\?/, 'VideoTask should expose stable delivery status separately from local_status');

const queueSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/video/delivery-queue.ts'), 'utf8');
assert.match(queueSource, /updateMany/, 'queue claim must use a conditional update to avoid duplicate worker claims');
assert.match(queueSource, /claim\.count !== 1/, 'queue claim must verify that the worker actually claimed the job');

console.log('video-delivery-queue smoke passed');
