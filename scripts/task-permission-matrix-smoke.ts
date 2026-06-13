import crypto from 'crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';
import {
  assertCanGenerateInProject,
  assertCanManageProject,
  assertCanViewProject,
} from '../src/lib/projects/permissions';
import {
  assertCanGenerateInVideoCard,
  assertCanManageVideoCard,
  assertCanViewVideoCard,
} from '../src/lib/video-cards/permissions';
import type { SessionUser } from '../src/lib/auth/session';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sessionUser(input: {
  id: string;
  username: string;
  email: string;
  role?: string;
  status?: string;
}): SessionUser {
  return {
    id: input.id,
    name: input.username,
    username: input.username,
    email: input.email,
    role: input.role || 'user',
    account_type: 'internal',
    user_profile: 'other',
    feature_profile_id: null,
    status: input.status || 'active',
    expires_at: null,
  } as SessionUser;
}

async function expectReject(action: () => Promise<unknown>, label: string) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, label);
}

async function main() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let projectId: string | null = null;

  try {
    const owner = await prisma.user.create({
      data: {
        name: `Smoke Owner ${suffix}`,
        username: `smoke_owner_${suffix}`,
        email: `smoke_owner_${suffix}@example.invalid`,
        password_hash: 'smoke-only',
        role: 'user',
      },
    });
    const viewer = await prisma.user.create({
      data: {
        name: `Smoke Viewer ${suffix}`,
        username: `smoke_viewer_${suffix}`,
        email: `smoke_viewer_${suffix}@example.invalid`,
        password_hash: 'smoke-only',
        role: 'user',
      },
    });
    const outsider = await prisma.user.create({
      data: {
        name: `Smoke Outsider ${suffix}`,
        username: `smoke_outsider_${suffix}`,
        email: `smoke_outsider_${suffix}@example.invalid`,
        password_hash: 'smoke-only',
        role: 'user',
      },
    });
    userIds.push(owner.id, viewer.id, outsider.id);

    const project = await prisma.project.create({
      data: {
        name: `Smoke Permission Project ${suffix}`,
        type: 'team',
        visibility: 'private',
        owner_user_id: owner.id,
        created_by: owner.id,
        status: 'active',
      },
    });
    projectId = project.id;
    await prisma.projectMember.createMany({
      data: [
        { project_id: project.id, user_id: owner.id, role: 'project_owner', joined_by: owner.id },
        { project_id: project.id, user_id: viewer.id, role: 'viewer', joined_by: owner.id },
      ],
    });
    const activeCard = await prisma.videoCard.create({
      data: {
        project_id: project.id,
        title: `Active Card ${suffix}`,
        status: 'active',
        created_by: owner.id,
        owner_user_id: owner.id,
      },
    });
    const sealedCard = await prisma.videoCard.create({
      data: {
        project_id: project.id,
        title: `Sealed Card ${suffix}`,
        status: 'sealed',
        created_by: owner.id,
        owner_user_id: owner.id,
        sealed_at: new Date(),
        sealed_by: owner.id,
      },
    });

    const ownerSession = sessionUser(owner);
    const viewerSession = sessionUser(viewer);
    const outsiderSession = sessionUser(outsider);

    await assertCanViewProject(ownerSession, project.id);
    await assertCanManageProject(ownerSession, project.id);
    await assertCanGenerateInProject(ownerSession, project.id);
    await assertCanViewVideoCard(viewerSession, activeCard.id);
    await expectReject(() => assertCanManageProject(viewerSession, project.id), 'viewer should not manage project');
    await expectReject(() => assertCanGenerateInProject(viewerSession, project.id), 'viewer should not generate in project');
    await expectReject(() => assertCanViewProject(outsiderSession, project.id), 'outsider should not view project');
    await assertCanManageVideoCard(ownerSession, activeCard.id);
    await assertCanGenerateInVideoCard(ownerSession, project.id, activeCard.id);
    await expectReject(() => assertCanGenerateInVideoCard(ownerSession, project.id, sealedCard.id), 'sealed card should not generate');

    console.log('[task-permission-matrix-smoke] permission matrix passed; smoke data cleaned up');
  } finally {
    if (projectId) {
      await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
  }
}

main()
  .catch((error) => {
    console.error('[task-permission-matrix-smoke] FAILED', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
