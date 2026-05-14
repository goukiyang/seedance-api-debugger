import type { Prisma } from '@prisma/client';
import { usernameBaseFromEmail } from './config';

async function generateUniqueUsername(tx: Prisma.TransactionClient, email: string): Promise<string> {
  const base = usernameBaseFromEmail(email);
  for (let index = 0; index < 50; index += 1) {
    const candidate = index === 0 ? base : `${base}${index + 1}`;
    const existing = await tx.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

export async function createRegisteredUser(
  tx: Prisma.TransactionClient,
  input: {
    email: string;
    name: string;
    passwordHash: string;
  },
) {
  const username = await generateUniqueUsername(tx, input.email);
  const displayName = input.name || input.email.split('@')[0] || username;

  const user = await tx.user.create({
    data: {
      name: displayName,
      username,
      email: input.email,
	      password_hash: input.passwordHash,
	      role: 'user',
	      account_type: 'internal',
	      user_profile: 'other',
	      feature_profile_id: 'standard_internal',
	      status: 'active',
	    },
  });

  await tx.creditAccount.create({
    data: {
      user_id: user.id,
      balance: 0,
      frozen_credits: 0,
    },
  });

  const project = await tx.project.create({
    data: {
      name: '我的默认项目',
      description: '系统自动创建的个人默认项目',
      type: 'personal',
      visibility: 'private',
      owner_user_id: user.id,
      created_by: user.id,
      status: 'active',
    },
  });

  await tx.projectMember.create({
    data: {
      project_id: project.id,
      user_id: user.id,
      role: 'project_owner',
      joined_by: user.id,
    },
  });

  await tx.operationLog.createMany({
    data: [
      {
        operator_id: user.id,
        action: 'self_register',
        target_type: 'User',
        target_id: user.id,
	        detail: JSON.stringify({
	          account_type: 'internal',
	          user_profile: 'other',
	          feature_profile_id: 'standard_internal',
	        }),
	      },
      {
        operator_id: user.id,
        action: 'project_create_default',
        target_type: 'project',
        target_id: project.id,
        detail: JSON.stringify({ type: 'personal', source: 'self_register' }),
      },
    ],
  });

  return user;
}
