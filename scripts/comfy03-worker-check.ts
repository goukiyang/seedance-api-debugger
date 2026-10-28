import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../src/lib/prisma';
import { localImageHandler } from '../src/lib/local-images/http';
import { assertIsolatedEnvironment, isolationRoot, newCredential, tokenHash, sha256, type Profile } from '../src/lib/local-images/core';
import { LocalImageService } from '../src/lib/local-images/service';

async function main() {
  assertIsolatedEnvironment();
  const run = randomUUID(); const root = path.join(isolationRoot(), 'protocol', run); await fs.mkdir(root, { recursive: true });
  const openssl = process.env.COMFY03_OPENSSL || 'C:/Program Files/Git/usr/bin/openssl.exe';
  const certificate = path.join(root, 'tls.pem'); const privateKey = path.join(root, 'tls.key');
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey,
    '-out', certificate, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  if (generated.status !== 0) throw new Error('Local test certificate generation failed');
  const graphText = JSON.stringify({ '1': { class_type: 'FixtureOutput', inputs: { text: '', filename_prefix: '' } } });
  const profile = { capability: 'text-to-image', executionProfileId: 'protocol-worker-fixture', modelId: 'fixture', modelVersion: '1', workflowId: 'fixture',
    workflowVersion: '1', workflowSha256: sha256(graphText), environmentRevision: 'fixture', parameterSchemaVersion: '1', workflowFile: 'workflow.json',
    parameterSchema: { fields: { prompt: { type: 'string', required: true }, width: { type: 'integer', default: 8 }, height: { type: 'integer', default: 8 } },
      allowedDimensions: [[8, 8]], maxPixels: 64, inputMax: 0 }, parameterMapping: { prompt: [{ node: '1', input: 'text' }] }, outputNodes: ['1'], outputMin: 1, outputMax: 1, resources: [] } as Profile;
  const callerId = `caller-${run}`; const workerId = `worker-${run}`; const user = `user-${run}`; const machine = `machine-${run}`;
  const callerToken = newCredential('caller', callerId); const workerToken = newCredential('worker', workerId);
  await prisma.user.create({ data: { id: user, name: 'Protocol test only', username: user, email: user + '@invalid.test', password_hash: '!disabled' } });
  for (const [id, kind, subject, token] of [[callerId, 'caller', user, callerToken], [workerId, 'worker', machine, workerToken]]) {
    await prisma.localImageCredential.create({ data: { id, kind, subject_id: subject, token_hash: tokenHash(token), profile_ids_json: JSON.stringify([profile.executionProfileId]), expires_at: new Date(Date.now() + 3600000) } });
  }
  const service = new LocalImageService(prisma, [profile], [profile.executionProfileId]);
  const server = https.createServer({ key: await fs.readFile(privateKey), cert: await fs.readFile(certificate) }, async (req, res) => {
    try {
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of req) { total += chunk.length; if (total > 1024 * 1024) throw new Error('Too large'); chunks.push(chunk); }
      const url = new URL(req.url!, 'https://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>,
        ...(chunks.length ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}) });
      const response = await localImageHandler(request, parts.slice(2), parts[1] === 'local-workers' ? 'worker' : 'caller', service);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries())); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const fixturePng = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#549060' } }).png().toBuffer()).toString('base64');
    const script = path.resolve('../COMFY03-service/scripts/check_website_protocol.py');
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('python', [script], { env: { ...process.env, PYTHONUTF8: '1', SSL_CERT_FILE: certificate }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      child.stdin.end(JSON.stringify({ root: path.join(root, 'worker'), graphText, profile, fixturePng,
        base: `https://127.0.0.1:${address.port}`, workerId: machine, callerToken, workerToken, requestId: randomUUID() }));
    });
    const report = JSON.parse(result); await fs.mkdir('docs/comfy03', { recursive: true });
    await fs.writeFile('docs/comfy03/worker-protocol-check.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.localImageCredential.updateMany({ where: { id: { in: [callerId, workerId] } }, data: { revoked_at: new Date() } });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
