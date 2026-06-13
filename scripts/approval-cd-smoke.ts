import crypto from 'crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';
import { consumeApprovalForTask, createApprovalRequest, decideApproval } from '../src/lib/approvals';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

class SmokeRollback extends Error {
  constructor() {
    super('approval cd smoke rollback');
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function log(message: string) {
  console.log(`[approval-cd-smoke] ${message}`);
}

async function main() {
  const suffix = crypto.randomUUID().slice(0, 8);
  let verified = false;

  try {
    await prisma.$transaction(async (tx) => {
      const requester = await tx.user.create({
        data: {
          name: `Smoke CD Requester ${suffix}`,
          username: `smoke_cd_requester_${suffix}`,
          email: `smoke_cd_requester_${suffix}@example.invalid`,
          password_hash: 'smoke-only',
          role: 'user',
        },
      });
      const approver = await tx.user.create({
        data: {
          name: `Smoke CD Approver ${suffix}`,
          username: `smoke_cd_approver_${suffix}`,
          email: `smoke_cd_approver_${suffix}@example.invalid`,
          password_hash: 'smoke-only',
          role: 'admin',
        },
      });
      const project = await tx.project.create({
        data: {
          name: `Smoke CD Project ${suffix}`,
          type: 'public',
          visibility: 'private',
          owner_user_id: requester.id,
          created_by: requester.id,
          status: 'active',
        },
      });
      await tx.projectMember.create({
        data: {
          project_id: project.id,
          user_id: requester.id,
          role: 'project_owner',
          joined_by: approver.id,
        },
      });
      const card = await tx.videoCard.create({
        data: {
          project_id: project.id,
          title: `Smoke CD Card ${suffix}`,
          objective: 'approval C/D smoke card',
          status: 'active',
          owner_user_id: requester.id,
          platform: 'douyin',
          ratio: '16:9',
          original_ratio: '16:9',
          ratio_locked: true,
          duration: 5,
          target_resolution: '720p',
          delivery_specs_json: JSON.stringify({ platform: 'douyin', ratio: '16:9', duration: 5, target_resolution: '720p' }),
          created_by: requester.id,
        },
      });
      const baselineTask = await tx.videoTask.create({
        data: {
          provider: 'seedance',
          model: 'smoke-model',
          generation_mode: 'all_in_one_reference',
          prompt: 'baseline candidate for 1080p approval',
          ratio: '16:9',
          duration: 5,
          resolution: '720p',
          local_status: 'succeeded',
          user_id: requester.id,
          owner_user_id: requester.id,
          project_id: project.id,
          video_card_id: card.id,
          version_role: 'candidate',
          visibility: 'project',
          billing_scope: 'project',
          billing_account_id: project.id,
        },
      });
      const highResTask = await tx.videoTask.create({
        data: {
          provider: 'seedance',
          model: 'smoke-model',
          generation_mode: 'all_in_one_reference',
          prompt: '1080p task consuming approval quota',
          ratio: '16:9',
          duration: 5,
          resolution: '1080p',
          local_status: 'submitted',
          user_id: requester.id,
          owner_user_id: requester.id,
          project_id: project.id,
          video_card_id: card.id,
          visibility: 'project',
          billing_scope: 'project',
          billing_account_id: project.id,
        },
      });
      const secondHighResTask = await tx.videoTask.create({
        data: {
          provider: 'seedance',
          model: 'smoke-model',
          generation_mode: 'all_in_one_reference',
          prompt: 'second 1080p task should be rejected by quota',
          ratio: '16:9',
          duration: 5,
          resolution: '1080p',
          local_status: 'submitted',
          user_id: requester.id,
          owner_user_id: requester.id,
          project_id: project.id,
          video_card_id: card.id,
          visibility: 'project',
          billing_scope: 'project',
          billing_account_id: project.id,
        },
      });

      const resolutionApproval = await createApprovalRequest(tx, {
        type: 'resolution_1080p',
        requesterUserId: requester.id,
        projectId: project.id,
        videoCardId: card.id,
        taskId: baselineTask.id,
        reason: 'smoke 1080p approval',
        payload: {
          quota_count: 1,
          estimated_budget_credits: 18,
          intended_use: 'smoke high resolution export',
        },
      });
      await decideApproval(tx, {
        approvalId: resolutionApproval.id,
        approverUserId: approver.id,
        action: 'approve',
        reason: 'smoke approve 1080p quota',
      });
      await consumeApprovalForTask(tx, {
        approvalId: resolutionApproval.id,
        taskId: highResTask.id,
        userId: requester.id,
        metadata: { project_id: project.id, video_card_id: card.id, baseline_task_id: baselineTask.id },
      });
      const consumed = await tx.approvalRecord.findUnique({ where: { id: resolutionApproval.id } });
      assert(consumed?.used_count === 1, '1080p approval quota was not consumed');
      let quotaBlocked = false;
      try {
        await consumeApprovalForTask(tx, {
          approvalId: resolutionApproval.id,
          taskId: secondHighResTask.id,
          userId: requester.id,
        });
      } catch {
        quotaBlocked = true;
      }
      assert(quotaBlocked, '1080p approval quota can be reused beyond limit');

      const ratioApproval = await createApprovalRequest(tx, {
        type: 'ratio_change',
        requesterUserId: requester.id,
        projectId: project.id,
        videoCardId: card.id,
        reason: 'smoke ratio change',
        payload: {
          target_ratio: '9:16',
          change_reason: 'smoke vertical delivery',
        },
      });
      await decideApproval(tx, {
        approvalId: ratioApproval.id,
        approverUserId: approver.id,
        action: 'approve',
        reason: 'smoke approve ratio change',
      });
      const changedCard = await tx.videoCard.findUnique({ where: { id: card.id } });
      assert(changedCard?.ratio === '9:16', 'ratio_change approval did not update card ratio');
      assert(changedCard?.original_ratio === '16:9', 'ratio_change approval did not retain original ratio');
      assert(changedCard?.ratio_locked === true, 'ratio_change approval did not lock target ratio');

      await tx.videoCard.update({
        where: { id: card.id },
        data: { status: 'sealed', sealed_at: new Date(), sealed_by: approver.id },
      });
      const reopenApproval = await createApprovalRequest(tx, {
        type: 'video_card_reopen',
        requesterUserId: requester.id,
        projectId: project.id,
        videoCardId: card.id,
        reason: 'smoke reopen sealed card',
        payload: {
          reopen_reason: 'smoke continue iteration',
          target_status: 'active',
        },
      });
      await decideApproval(tx, {
        approvalId: reopenApproval.id,
        approverUserId: approver.id,
        action: 'approve',
        reason: 'smoke approve reopen',
      });
      const reopenedCard = await tx.videoCard.findUnique({ where: { id: card.id } });
      assert(reopenedCard, 'video_card_reopen approval card missing');
      assert(reopenedCard.status === 'active', 'video_card_reopen approval did not reopen card');
      assert(reopenedCard.sealed_at === null && reopenedCard.sealed_by === null, 'video_card_reopen approval did not clear sealed flags');

      const effectLogs = await tx.operationLog.findMany({
        where: {
          operator_id: approver.id,
          action: { in: ['approval_effect_ratio_change', 'approval_effect_video_card_reopen'] },
        },
      });
      assert(effectLogs.length >= 2, 'C/D approval side effects were not logged');

      verified = true;
      throw new SmokeRollback();
    });
  } catch (error) {
    if (error instanceof SmokeRollback && verified) {
      log('1080p quota, ratio change and video card reopen effects passed; transaction rolled back');
      return;
    }
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('[approval-cd-smoke] FAILED', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
