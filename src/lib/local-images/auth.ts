import type { Prisma } from '@prisma/client';
import { credentialId, requireThat, tokenMatches } from './core';

export async function authenticate(tx: Prisma.TransactionClient, token: string, kind: 'caller' | 'worker') {
  const id = credentialId(token, kind);
  const credential = await tx.localImageCredential.findUnique({ where: { id } });
  requireThat(credential && credential.kind === kind && !credential.revoked_at
    && credential.expires_at > new Date() && tokenMatches(token, credential.token_hash), 'INVALID_TOKEN', 401);
  if (kind === 'caller') {
    const user = await tx.user.findUnique({ where: { id: credential.subject_id } });
    requireThat(user && user.role === 'user' && user.account_type === 'internal' && user.status === 'active'
      && (!user.expires_at || user.expires_at > new Date()), 'INTERNAL_USER_REQUIRED', 403);
  }
  return credential;
}
