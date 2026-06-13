import crypto from 'crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';
import { createApprovalRequest, decideApproval } from '../src/lib/approvals';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

class SmokeRollback extends Error {
  constructor() {
    super('approval effects smoke rollback');
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function log(message: string) {
  console.log(`[approval-effects-smoke] ${message}`);
}

async function main() {
  const suffix = crypto.randomUUID().slice(0, 8);
  let verified = false;

  try {
    await prisma.$transaction(async (tx) => {
      // 事务内制造完整审批链路，最后主动回滚，避免污染真实数据库。
      const requester = await tx.user.create({
        data: {
          name: `Smoke Requester ${suffix}`,
          username: `smoke_requester_${suffix}`,
          email: `smoke_requester_${suffix}@example.invalid`,
          password_hash: 'smoke-only',
          role: 'user',
        },
      });
      const approver = await tx.user.create({
        data: {
          name: `Smoke Approver ${suffix}`,
          username: `smoke_approver_${suffix}`,
          email: `smoke_approver_${suffix}@example.invalid`,
          password_hash: 'smoke-only',
          role: 'admin',
        },
      });

      const projectCreate = await createApprovalRequest(tx, {
        type: 'project_create',
        requesterUserId: requester.id,
        reason: 'smoke public project approval',
        payload: {
          project_name: `Smoke Public Project ${suffix}`,
          project_description: 'created by approval-effects-smoke',
          initial_budget_credits: 120,
        },
      });
      const approvedProjectCreate = await decideApproval(tx, {
        approvalId: projectCreate.id,
        approverUserId: approver.id,
        action: 'approve',
        reason: 'smoke approve project create',
      });

      assert(approvedProjectCreate.project_id, 'project_create approval did not attach created project');
      const project = await tx.project.findUnique({
        where: { id: approvedProjectCreate.project_id },
        include: { budget_account: true, members: true },
      });
      assert(project, 'approved project_create did not create project');
      assert(project.type === 'public', `created project type is ${project.type}, expected public`);
      assert(project.owner_user_id === requester.id, 'created project owner is not requester');
      assert(project.budget_account?.budget_credits === 120, 'initial budget account was not funded');
      assert(project.members.some((member) => member.user_id === requester.id && member.role === 'project_owner'), 'requester was not added as project_owner');

      const initialLedger = await tx.projectBudgetLedger.findUnique({
        where: { idempotency_key: `approval:${projectCreate.id}:project_create_initial_budget` },
      });
      assert(initialLedger?.amount === 120, 'initial budget ledger was not written');

      const rejectedBudget = await createApprovalRequest(tx, {
        type: 'budget_increase',
        requesterUserId: requester.id,
        projectId: project.id,
        reason: 'smoke rejected budget increase',
        payload: { amount: 30 },
      });
      await decideApproval(tx, {
        approvalId: rejectedBudget.id,
        approverUserId: approver.id,
        action: 'reject',
        reason: 'smoke reject budget increase',
      });
      const afterReject = await tx.projectBudgetAccount.findUnique({ where: { project_id: project.id } });
      assert(afterReject?.budget_credits === 120, 'rejected budget approval changed project budget');
      const rejectedLedger = await tx.projectBudgetLedger.findUnique({
        where: { idempotency_key: `approval:${rejectedBudget.id}:budget_increase` },
      });
      assert(!rejectedLedger, 'rejected budget approval wrote a ledger');

      const approvedBudget = await createApprovalRequest(tx, {
        type: 'budget_increase',
        requesterUserId: requester.id,
        projectId: project.id,
        reason: 'smoke approved budget increase',
        payload: { amount: 45 },
      });
      await decideApproval(tx, {
        approvalId: approvedBudget.id,
        approverUserId: approver.id,
        action: 'approve',
        reason: 'smoke approve budget increase',
      });
      const afterApprove = await tx.projectBudgetAccount.findUnique({ where: { project_id: project.id } });
      assert(afterApprove?.budget_credits === 165, 'approved budget increase did not update project budget');
      const approvedLedger = await tx.projectBudgetLedger.findUnique({
        where: { idempotency_key: `approval:${approvedBudget.id}:budget_increase` },
      });
      assert(approvedLedger?.amount === 45, 'approved budget increase ledger was not written');

      const effectLogs = await tx.operationLog.findMany({
        where: {
          operator_id: approver.id,
          action: { in: ['approval_effect_project_create', 'approval_effect_budget_increase'] },
        },
      });
      assert(effectLogs.length >= 2, 'approval side effects were not logged');

      verified = true;
      throw new SmokeRollback();
    });
  } catch (error) {
    if (error instanceof SmokeRollback && verified) {
      log('project_create and budget_increase approval effects passed; transaction rolled back');
      return;
    }
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('[approval-effects-smoke] FAILED', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
