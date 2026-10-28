/** Local-only issue/revoke. Never prints a bearer secret or accepts one in argv. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import profiles from '../src/lib/local-images/profiles.json';
import { assertIsolatedEnvironment, identifier, isolationRoot, newCredential, requireThat, tokenHash } from '../src/lib/local-images/core';

async function main() {
  assertIsolatedEnvironment();
  const [action, kindOrId, subjectId, profileId, projectId] = process.argv.slice(2);
  if (action === 'revoke') {
    const row = await prisma.localImageCredential.update({ where: { id: identifier(kindOrId) }, data: { revoked_at: new Date() } });
    console.log(JSON.stringify({ id: row.id, revoked: true })); return;
  }
  requireThat(action === 'issue' && ['caller', 'worker'].includes(kindOrId), 'USE_issue_caller_OR_worker_SUBJECT_PROFILE_OPTIONAL_PROJECT');
  const kind = kindOrId as 'caller' | 'worker'; identifier(subjectId);
  requireThat(profiles.some(p => p.executionProfileId === profileId), 'UNKNOWN_PROFILE');
  if (kind === 'caller') {
    const user = await prisma.user.findUnique({ where: { id: subjectId } });
    requireThat(user && user.status === 'active' && user.role === 'user' && user.account_type === 'internal'
      && (!user.expires_at || user.expires_at > new Date()), 'ACTIVE_INTERNAL_USER_REQUIRED');
  }
  if (projectId) identifier(projectId);
  requireThat(kind === 'caller' || !projectId, 'WORKER_CANNOT_BIND_PROJECT');
  const directory = path.join(isolationRoot(), 'credentials');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)?.[0];
    requireThat(sid, 'CANNOT_RESTRICT_CREDENTIAL_DIRECTORY');
    execFileSync('icacls', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
  } else await fs.chmod(directory, 0o700);
  const id = randomUUID(); const token = newCredential(kind, id); const expires = new Date(Date.now() + 7 * 86400000);
  const target = path.join(directory, id + '.json');
  // File first; if DB creation fails this secret was never authorized.
  await fs.writeFile(target, JSON.stringify({ environment: 'isolated-test', id, kind, token, expiresAt: expires.toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
  await prisma.localImageCredential.create({ data: { id, kind, subject_id: subjectId, token_hash: tokenHash(token),
    profile_ids_json: JSON.stringify([profileId]), project_id: projectId || null, expires_at: expires } });
  console.log(JSON.stringify({ id, kind, credentialFile: target, expiresAt: expires.toISOString(), production: false }));
}
main().catch(error => { console.error(error.code || 'Credential operation failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
