import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';
import { getOrCreateWorkspace } from '../src/lib/assets/workspace';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

async function main() {
  const runId = `workspace_tab_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const ownerId = `smoke_owner_${runId}`;
  const legacyWorkspaceId = `legacy_workspace_${runId}`;

  try {
    await prisma.user.create({
      data: {
        id: ownerId,
        name: 'Smoke Workspace Owner',
        username: `${runId}_owner`,
        email: `${runId}_owner@example.invalid`,
        password_hash: 'smoke-only',
        role: 'user',
        account_type: 'internal',
        status: 'active',
      },
    });

    await prisma.workspace.create({
      data: {
        id: legacyWorkspaceId,
        owner_id: ownerId,
        name: '默认工作台',
        status: 'active',
      },
    });

    const tabAFirst = await getOrCreateWorkspace(`tab-a:${runId}`, ownerId);
    const tabASecond = await getOrCreateWorkspace(`tab-a:${runId}`, ownerId);
    const tabB = await getOrCreateWorkspace(`tab-b:${runId}`, ownerId);

    assert.equal(tabAFirst.id, tabASecond.id, 'same tab must reuse its workspace');
    assert.notEqual(tabAFirst.id, tabB.id, 'different tabs must not share workspace');
    assert.notEqual(tabAFirst.id, legacyWorkspaceId, 'tab workspace must not reuse legacy active workspace');

    const created = await prisma.workspace.findMany({
      where: { owner_id: ownerId, status: 'active' },
      orderBy: { created_at: 'asc' },
      select: { id: true, name: true },
    });
    assert.equal(created.length, 3, `expected legacy + two tab workspaces, got ${created.length}`);
    assert.ok(created.some((item) => item.name === `默认工作台:tab-a:${runId}`), 'tab A workspace name missing');
    assert.ok(created.some((item) => item.name === `默认工作台:tab-b:${runId}`), 'tab B workspace name missing');

    console.log('workspace-tab-isolation-smoke: ok');
  } finally {
    await prisma.workspace.deleteMany({ where: { owner_id: ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect();
  console.error(error);
  process.exit(1);
});
