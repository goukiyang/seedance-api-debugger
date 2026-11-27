import type { ApiCustomer } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getVolcengineIpApiSettings, isVolcengineIpApiReady } from '@/lib/integrations/volcengine-ip';
import { customerReady } from './admin';
import { API_SCOPES, CustomerApiError, MEMBER_API_APPROVAL, memberApiApproval, newApiKey, stringList, type ApiTx } from './auth';

const boundKeyFields = { id: true, prefix: true, expires_at: true } as const;

async function activeMember(tx: ApiTx, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'user' || user.account_type !== 'internal' || user.status !== 'active'
    || (user.expires_at && user.expires_at <= new Date())) {
    throw new CustomerApiError('MEMBER_REQUIRED', '请使用有效的站内成员账号。', 403);
  }
  return user;
}

async function activeMemberConfiguration(tx: ApiTx, customer: ApiCustomer) {
  customerReady(customer);
  const models = stringList(customer.models_json);
  const [global, provider, rate] = await Promise.all([
    tx.apiConfiguration.findUnique({ where: { id: 'global' } }),
    getVolcengineIpApiSettings(tx),
    tx.apiRate.findFirst({ where: { customer_id: customer.id, model: { in: models }, enabled: true, cny_per_second: { gt: 0 } } }),
  ]);
  if (!customer.create_enabled || !global?.enabled || !global.license_confirmed || !global.concurrency_limit
    || !global.storage_limit_bytes || !global.max_output_bytes || !isVolcengineIpApiReady(provider) || !rate) {
    throw new CustomerApiError('CONFIGURATION_REQUIRED', '请先在客户 API 配好有效线路、费率与额度，并启用新建。', 409);
  }
  return models;
}

export async function memberApiStatus(userId: string) {
  await activeMember(prisma, userId);
  const [approval, account, customer, global] = await Promise.all([
    memberApiApproval(prisma, userId),
    prisma.creditAccount.findUnique({ where: { user_id: userId }, select: { balance: true, frozen_credits: true } }),
    prisma.apiCustomer.findUnique({ where: { user_id: userId }, include: { keys: { where: { active: true }, take: 1, select: boundKeyFields } } }),
    prisma.apiConfiguration.findUnique({ where: { id: 'global' }, select: { enabled: true } }),
  ]);
  return {
    status: approval?.status || 'unrequested',
    decisionReason: approval?.decision_reason || null,
    key: customer?.keys[0] || null,
    canCreate: approval?.status === 'approved' && approval.effect_status === 'applied'
      && !!customer?.read_enabled && customer.create_enabled && !!global?.enabled,
    available: Math.max(0, (account?.balance ?? 0) - (account?.frozen_credits ?? 0)),
  };
}

export async function requestMemberApi(userId: string) {
  return prisma.$transaction(async tx => {
    const user = await activeMember(tx, userId);
    const prior = await memberApiApproval(tx, userId);
    if (prior?.status === 'pending' || prior?.status === 'approved') return;
    let customer = await tx.apiCustomer.findUnique({ where: { user_id: userId } });
    if (!customer) {
      const project = await tx.project.create({ data: {
        name: 'API 视频', type: 'personal', visibility: 'private', work_audience: 'private',
        owner_user_id: userId, created_by: userId,
      } });
      const card = await tx.videoCard.create({ data: {
        project_id: project.id, title: 'API 视频', owner_user_id: userId, created_by: userId,
      } });
      customer = await tx.apiCustomer.create({ data: {
        name: user.name || user.username, user_id: userId, project_id: project.id, video_card_id: card.id, timezone: 'Asia/Shanghai',
      } });
    }
    await tx.approvalRecord.create({ data: {
      type: MEMBER_API_APPROVAL, requester_user_id: userId, scope_json: JSON.stringify({ customer_id: customer.id }),
    } });
  });
}

export async function assertMemberApiApprovalReady(tx: ApiTx, approverId: string, memberId: string) {
  const administrator = await tx.user.findUnique({ where: { id: approverId }, select: { role: true, status: true, expires_at: true } });
  if (administrator?.role !== 'admin' || administrator.status !== 'active'
    || (administrator.expires_at && administrator.expires_at <= new Date())) {
    throw new CustomerApiError('ADMIN_REQUIRED', '只有管理员可以审批 API 使用权限。', 403);
  }
  await activeMember(tx, memberId);
  const customer = await tx.apiCustomer.findUnique({ where: { user_id: memberId } });
  if (!customer) throw new CustomerApiError('CONFIGURATION_REQUIRED', '成员的 API 配置尚未准备好。', 409);
  await activeMemberConfiguration(tx, customer);
}

export function claimMemberApiKey(userId: string) {
  return prisma.$transaction(async tx => {
    const user = await activeMember(tx, userId);
    const approval = await memberApiApproval(tx, userId);
    const customer = await tx.apiCustomer.findUnique({ where: { user_id: userId } });
    if (!customer || approval?.status !== 'approved' || approval.effect_status !== 'applied') {
      throw new CustomerApiError('APPROVAL_REQUIRED', 'API 使用权限尚未批准。', 403);
    }
    if (await tx.apiKey.findFirst({ where: { customer_id: customer.id, active: true }, select: { id: true } })) {
      throw new CustomerApiError('KEY_ALREADY_BOUND', '账号已绑定 Key，请在个人页核对。', 409);
    }
    const models = await activeMemberConfiguration(tx, customer);
    const secret = newApiKey();
    const expiresAt = new Date(Math.min(user.expires_at?.getTime() ?? Infinity, Date.now() + 365 * 86_400_000));
    const key = await tx.apiKey.create({ data: {
      customer_id: customer.id, name: '成员 API Key', agent_id: 'member-api', digest: secret.digest, prefix: secret.prefix,
      expires_at: expiresAt, scopes_json: JSON.stringify(API_SCOPES), models_json: JSON.stringify(models), requests_per_minute: 30,
    }, select: boundKeyFields });
    await tx.operationLog.create({ data: {
      operator_id: userId, action: 'customer_api_member_issue_key', target_type: 'ApiKey', target_id: key.id,
    } });
    return { token: secret.token, key };
  });
}

export function revokeMemberApiKey(userId: string, keyId: string) {
  return prisma.$transaction(async tx => {
    await activeMember(tx, userId);
    const changed = await tx.apiKey.updateMany({
      where: { id: keyId, active: true, customer: { user_id: userId } }, data: { active: false },
    });
    if (changed.count) await tx.operationLog.create({ data: {
      operator_id: userId, action: 'customer_api_member_revoke_key', target_type: 'ApiKey', target_id: keyId,
    } });
  });
}
