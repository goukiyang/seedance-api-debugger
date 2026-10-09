import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SessionUser } from '../src/lib/auth/session';
import { INTERNAL_EMAIL_FEATURE_PROFILE_ID } from '../src/lib/users/profiles';

async function main() {
  const scratch = path.resolve('.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'role-ui-'));
  const databaseUrl = `file:${path.join(directory, 'synthetic.db')}`;
  const sessionSecret = randomBytes(32).toString('hex');
  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = sessionSecret;
  globalThis.fetch = async () => { throw new Error('External network forbidden in UI fixture preparation'); };
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.resolve('prisma/schema.prisma')],
    { env: process.env, stdio: 'pipe' });
  const { prisma } = await import('../src/lib/prisma');
  const { hashPassword } = await import('../src/lib/auth/password');
  const { createSession } = await import('../src/lib/auth/session');
  const roles = await import('../src/lib/canvas-roles/repository');
  const { joinRole } = await import('../src/lib/canvas-roles/join');
  const work = await import('../src/lib/canvas-roles/work');
  const owner: SessionUser = { id: 'role-ui-owner', name: '合成测试用户', username: 'role-ui-owner', email: 'role-ui@invalid.test',
    role: 'user', account_type: 'internal', status: 'active', user_profile: 'other', feature_profile_id: INTERNAL_EMAIL_FEATURE_PROFILE_ID, expires_at: null };
  const mutation = () => randomUUID();
  try {
    await prisma.user.create({ data: { ...{ id: owner.id, name: owner.name, username: owner.username, email: owner.email },
      password_hash: hashPassword(randomBytes(32).toString('hex')), account_type: 'internal', status: 'active',
      feature_profile_id: INTERNAL_EMAIL_FEATURE_PROFILE_ID } });
    await prisma.creditAccount.create({ data: { user_id: owner.id, balance: 100 } });
    const project = await prisma.project.create({ data: { name: '角色候选隔离项目', type: 'personal', owner_user_id: owner.id, created_by: owner.id } });
    const card = await prisma.videoCard.create({ data: { project_id: project.id, title: '角色候选画布', owner_user_id: owner.id, created_by: owner.id } });
    await prisma.videoBranch.create({ data: { video_card_id: card.id, title: '合成分支', is_primary: true, created_by: owner.id } });
    const document = await prisma.canvasDocument.create({ data: { title: '角色协作 · 合成候选', owner_user_id: owner.id, project_id: project.id,
      schema_version: 2, protocol_version: 2, document_json: JSON.stringify({ schema: 'ultimate_canvas.v1', schemaVersion: 2,
        context: { project_id: project.id, video_card_id: card.id }, canvas: { viewport: { x: 30, y: 50, zoom: 0.8 },
          nodes: [{ id: 'synthetic-material', type: 'text', x: 60, y: 100,
            data: { title: '合成项目需求', authoredText: '为一个虚构项目整理三条交付要求。全部材料均为合成内容，不调用外部服务。' } },
            { id: 'synthetic-delivery-file', type: 'script', x: 60, y: 380,
              data: { title: '合成交付原稿.txt', authoredText: '  synthetic original file\nline two\n', generatedText: 'obsolete generated text' } }], connections: [] } }) } });
    const nodes: Array<{ id: string; definitionId: string }> = [];
    const names = ['需求整理', '交付复核', '文字AI候选'];
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const ai = index === 2;
      const saved: any = await roles.createRole(owner, { mutation_id: mutation(), snapshot: { schema: 'role.v1', name,
        responsibilities: ai ? '根据已收齐材料提出文字建议' : '整理真实输入并提交可复核的文字', delivery: '文字正文及依据',
        criteria: '与当前需求、材料版本一致', boundary: '不得发起外部操作', executor: ai ? { kind: 'ai', model: 'gpt-5.5' } : { kind: 'person', userId: owner.id },
        tools: ai ? ['text'] : ['manual'], requiredItems: ['依据'] } });
      const current = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: document.id } });
      const joined: any = await joinRole(owner, { mutation_id: mutation(), document_id: document.id, document_revision: current.revision,
        definition_id: saved.role.id, version: 1, position: { x: 460 + index * 370, y: 100 }, pending_connection: null });
      nodes.push({ id: joined.nodeId, definitionId: saved.role.id });
    }
    const current = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: document.id } });
    const run: any = await work.createTaskRun(owner, { mutation_id: mutation(), document_id: document.id, document_revision: current.revision,
      max_rounds: 3, wait_limit_seconds: 600, requirements: { goal: '整理并复核合成项目的交付要求', criteria: '需求、依据和最终成果对应',
        endpoint: 'owner_result', decisionOwnerId: owner.id, materialNodes: ['synthetic-material'], finalNodeId: nodes[1].id,
        participants: nodes.map((node, index) => ({ nodeId: node.id, participation: index === 2 ? 'optional' : 'required',
          reviewerNodeId: index === 0 ? nodes[1].id : null, confirmRequired: index === 0, ownerMaySubmit: false, ownerMayReview: false,
          dependencies: index === 1 ? [{ nodeId: nodes[0].id, required: true }] : [] })) } });
    let detail = await work.readWork(owner, run.works[0].id);
    await work.actOnWork(owner, detail.work.id, { mutation_id: mutation(), base_revision: detail.work.revision,
      requirements_revision: detail.work.requirements_revision, action: 'accept' });
    detail = await work.readWork(owner, run.works[0].id);
    await work.actOnWork(owner, detail.work.id, { mutation_id: mutation(), base_revision: detail.work.revision,
      requirements_revision: detail.work.requirements_revision, action: 'submit', text: '三条交付要求：正文清楚、依据完整、版本一致。',
      items: { 依据: '合成项目需求节点' }, attachments: [{ nodeId: 'synthetic-delivery-file' }], input_digest: detail.input_digest });
    for (let index = 0; index < 31; index++) await prisma.canvasRoleAttempt.create({ data: {
      id: randomUUID(), work_id: run.works[0].id, round: 1, purpose: 'review', attempt: index + 1, request_id: randomUUID(),
      state: 'succeeded', fee_state: 'confirmed', input_snapshot_json: '{"syntheticPrivateInput":"not exposed"}', quote_json: '{}',
      result_json: JSON.stringify({ text: `Synthetic historical advice ${index}`, recommendationOnly: true }),
      reserved_points: 0, reserved_usd_micros: 0, settled_points: 0, settled_usd_micros: 0, settlement_applied: true,
      provider_scope: 'synthetic-history-only', started_at: new Date(Date.now() - (index + 1) * 1000),
    } });
    const fixturePath = path.join(directory, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({ schema: 'role-ui-fixture.v1', synthetic: true, root: process.cwd(), directory,
      databaseUrl, sessionSecret, sessionToken: await createSession(owner.id), ownerId: owner.id, projectId: project.id,
      documentId: document.id, nodes, roleTaskRunId: run.run.id, workIds: run.works.map((row: any) => row.id),
      pagePath: `/tools/ultimate-canvas?document_id=${encodeURIComponent(document.id)}&focus_node=${encodeURIComponent(nodes[0].id)}`,
      providerRequests: 0, providerConfiguration: 'absent; external requests blocked', createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ fixturePath, synthetic: true, providerRequests: 0 }));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
