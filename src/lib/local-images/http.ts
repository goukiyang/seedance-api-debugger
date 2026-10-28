import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from '@/lib/prisma';
import profiles from './profiles.json';
import { LocalImageService } from './service';
import { assertIsolatedEnvironment, identifier, isolationRoot, LocalImageError, object, requireThat, type Profile } from './core';
import { boundedBody, readOutput, receiveOutput } from './files';
import { authenticate } from './auth';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' } });
export async function localImageHandler(request: Request, parts: string[], kind: 'caller' | 'worker', testService?: LocalImageService) {
  try {
    assertIsolatedEnvironment();
    const authorization = request.headers.get('authorization') || '';
    const match = /^Bearer (\S+)$/.exec(authorization); requireThat(match, 'INVALID_TOKEN', 401);
    const token = match[1];
    // Only an explicit local qualification allow-list enables a registered profile.
    let enabled: string[] = [];
    try { enabled = JSON.parse(await fs.readFile(path.join(isolationRoot(), 'qualified-profiles.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    requireThat(Array.isArray(enabled) && enabled.every(x => typeof x === 'string'), 'QUALIFICATION_CONFIG_INVALID', 503);
    const service = testService ?? new LocalImageService(prisma, profiles as Profile[], enabled);
    await service.auth(token, kind); // Reject before reading potentially large/untrusted bodies.
    const route = parts.join('/');
    if (kind === 'caller') {
      if (request.method === 'GET' && route === 'models') return json(await service.catalog(token));
      if (request.method === 'GET' && parts.length === 2 && parts[0] === 'requests') return json(await service.findRequest(token, parts[1]));
      if (request.method === 'POST' && route === 'tasks') {
        const result = await service.create(token, JSON.parse((await boundedBody(request)).toString('utf8')));
        return json(result, result.replayed ? 200 : 202);
      }
      const task = /^tasks\/([A-Za-z0-9_-]+)(?:\/(cancel|outputs\/image-1))?$/.exec(route);
      if (task && request.method === 'GET' && !task[2]) return json(await service.get(token, task[1]));
      if (task && request.method === 'POST' && task[2] === 'cancel') return json(await service.cancel(token, task[1]));
      if (task && request.method === 'GET' && task[2] === 'outputs/image-1') {
        const output = await service.download(token, task[1], 'image-1');
        const bytes = await readOutput(path.join(isolationRoot(), 'outputs'), output.file_path, output.delivered_sha256);
        return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length),
          'Content-Disposition': `attachment; filename="${task[1]}.png"`, 'Cache-Control': 'private, no-store', 'Vary': 'Authorization',
          'X-Content-SHA256': output.delivered_sha256, 'X-Content-Type-Options': 'nosniff' } });
      }
    } else {
      const operationId = identifier(request.headers.get('idempotency-key'));
      if (request.method === 'PUT' && /^tasks\/[A-Za-z0-9_-]+\/outputs\/image-1$/.test(route)) {
        const body = { operationId, workerSessionId: identifier(request.headers.get('x-worker-session-id')),
          attemptId: identifier(request.headers.get('x-attempt-id')), fencingEpoch: Number(request.headers.get('x-fencing-epoch')),
          sha256: request.headers.get('x-content-sha256') || '', bytes: Number(request.headers.get('content-length')) };
        await service.transaction(async tx => {
          const credential = await authenticate(tx, token, 'worker');
          await service.bound(tx, credential, parts[1], body);
        });
        const output = await receiveOutput(request, path.join(isolationRoot(), 'outputs'), body.attemptId, body.sha256, body.bytes);
        return json(await service.write(token, operationId, route, body, output));
      }
      if (request.method === 'POST') {
        const body = object(JSON.parse((await boundedBody(request, 262144)).toString('utf8')));
        return json(await service.write(token, operationId, route, body));
      }
    }
    throw new LocalImageError('ROUTE_NOT_FOUND', 404);
  } catch (error) {
    if (error instanceof LocalImageError) return json({ error: error.code }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'INVALID_JSON' }, 400);
    // Never echo Prisma messages, paths, credentials or full request payloads.
    return json({ error: 'LOCAL_IMAGE_REQUEST_FAILED' }, 503);
  }
}
