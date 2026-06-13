import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth/password';

const prisma = new PrismaClient();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const email = required('ADMIN_EMAIL').toLowerCase();
  const username = process.env.ADMIN_USERNAME?.trim() || email.split('@')[0];
  const name = process.env.ADMIN_NAME?.trim() || '平台管理员';
  const password = required('ADMIN_PASSWORD');
  const initialCredits = Number(process.env.ADMIN_INITIAL_CREDITS || 0);

  if (!Number.isFinite(initialCredits) || initialCredits < 0) {
    throw new Error('ADMIN_INITIAL_CREDITS must be a non-negative number');
  }

  const admin = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });

    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            name,
            username,
            email,
	            password_hash: hashPassword(password),
	            role: 'admin',
	            account_type: 'internal',
	            user_profile: 'other',
	            feature_profile_id: 'standard_internal',
	            status: 'active',
	          },
        })
      : await tx.user.create({
          data: {
            name,
            username,
            email,
	            password_hash: hashPassword(password),
	            role: 'admin',
	            account_type: 'internal',
	            user_profile: 'other',
	            feature_profile_id: 'standard_internal',
	            status: 'active',
	          },
        });

    const account = await tx.creditAccount.upsert({
      where: { user_id: user.id },
      update: {},
      create: {
        user_id: user.id,
        balance: initialCredits,
        frozen_credits: 0,
      },
    });

    if (!existing && initialCredits > 0) {
      await tx.creditLedger.create({
        data: {
          user_id: user.id,
          type: 'admin_grant',
          amount: initialCredits,
          balance_before: 0,
          balance_after: initialCredits,
          frozen_before: 0,
          frozen_after: 0,
          operator_id: user.id,
          reason: 'seed admin initial credits',
        },
      });
    }

    await tx.operationLog.create({
      data: {
        operator_id: user.id,
        action: existing ? 'seed_admin_update' : 'seed_admin_create',
        target_type: 'User',
        target_id: user.id,
        detail: JSON.stringify({
          username,
          email,
          initial_balance: account.balance,
        }),
      },
    });

    return user;
  });

  console.log(`Admin ready: ${admin.email} (${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
