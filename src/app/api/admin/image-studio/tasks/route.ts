import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { prisma } from '@/lib/prisma';
import { publicImageTaskStatus } from '@/lib/image-studio/tasks';
import { imageBillingView } from '@/lib/image-studio/billing-contract';
import { studioTaskStates } from '@/lib/image-studio/pricing-state';
import { readStudioProviderErrorDiagnostics } from '@/lib/image-studio/provider-error-evidence';
import type { StudioProviderErrorDiagnostics } from '@/lib/image-studio/provider-error-diagnostics';

export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

function adminJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function projectProviderErrorDiagnostics(diagnostics: StudioProviderErrorDiagnostics): StudioProviderErrorDiagnostics {
  return {
    schema: diagnostics.schema,
    binding: {
      taskId: diagnostics.binding.taskId,
      ownerId: diagnostics.binding.ownerId,
      fingerprint: diagnostics.binding.fingerprint,
      channelId: diagnostics.binding.channelId,
      configRevision: diagnostics.binding.configRevision,
      localRequestId: diagnostics.binding.localRequestId,
      providerTaskId: diagnostics.binding.providerTaskId,
    },
    frozen: {
      model: diagnostics.frozen.model,
      resolution: diagnostics.frozen.resolution,
      requestedRatio: diagnostics.frozen.requestedRatio,
      resolvedRatio: diagnostics.frozen.resolvedRatio,
      expectedSize: diagnostics.frozen.expectedSize,
    },
    request: {
      dispatchObserved: diagnostics.request.dispatchObserved,
      endpointKind: diagnostics.request.endpointKind,
      protocol: diagnostics.request.protocol,
      model: diagnostics.request.model,
      sentModel: diagnostics.request.sentModel,
      quality: diagnostics.request.quality,
      size: diagnostics.request.size,
      ratio: diagnostics.request.ratio,
      n: diagnostics.request.n,
      referenceCount: diagnostics.request.referenceCount,
    },
    firstObservedAt: diagnostics.firstObservedAt,
    lastObservedAt: diagnostics.lastObservedAt,
    eventCount: diagnostics.eventCount,
    omittedEvents: diagnostics.omittedEvents,
    events: diagnostics.events.map(event => ({
      phase: event.phase,
      observedAt: event.observedAt,
      lastObservedAt: event.lastObservedAt,
      occurrences: event.occurrences,
      dispatchObserved: event.dispatchObserved,
      transportHttpStatus: event.transportHttpStatus,
      providerStatus: event.providerStatus,
      providerReasonCode: event.providerReasonCode,
      providerCauseConfirmed: event.providerCauseConfirmed,
      providerErrorStage: event.providerErrorStage,
      attempt: event.attempt,
      imageRetryCount: event.imageRetryCount,
      recoveryCount: event.recoveryCount,
      clientDropped: event.clientDropped,
      localCode: event.localCode,
      expectedSize: event.expectedSize,
      actualWidth: event.actualWidth,
      actualHeight: event.actualHeight,
      identityEvidence: event.identityEvidence,
      bodyRead: event.bodyRead,
      unknownFields: event.unknownFields.map(field => ({
        field: field.field,
        present: field.present,
        length: field.length,
        recognition: field.recognition,
        disposition: field.disposition,
      })),
      summarySource: event.summarySource,
      summary: event.summary,
    })),
  };
}

export const GET = apiRoute({ access: 'admin', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const params = request.nextUrl.searchParams;
    const text = (key: string, alias?: string) => {
      const value = (params.get(key) || (alias ? params.get(alias) : '') || '').trim();
      if (value.length > 120) throw new AuthError(`筛选内容过长：${key}`, 400);
      return value;
    };
    if (params.has('diagnostics')) {
      if (params.getAll('diagnostics').length !== 1 || params.get('diagnostics') !== '1'
        || params.getAll('task_id').length !== 1) throw new AuthError('错误详情读取条件无效', 400);
      const diagnosticTaskId = text('task_id');
      if (!diagnosticTaskId) throw new AuthError('请提供原图片任务编号', 400);
      try {
        const task = await prisma.imageStudioTask.findUnique({ where: { id: diagnosticTaskId }, select: { id: true } });
        if (!task) return adminJson({ error: '原图片任务不存在' }, 404);
        const result = await readStudioProviderErrorDiagnostics(task.id);
        const recorded = result.state === 'recorded' && result.diagnostics !== null;
        return adminJson({
          taskId: task.id,
          state: result.state === 'recorded' && !recorded ? 'unavailable' : result.state,
          diagnostics: recorded ? projectProviderErrorDiagnostics(result.diagnostics!) : null,
        });
      } catch {
        return adminJson({ error: '图片错误详情暂不可读，请重试' }, 503);
      }
    }
    const cursor = text('cursor'), moduleId = text('moduleId'), ownerId = text('owner_user_id', 'ownerId'), taskId = text('task_id');
    if (params.getAll('task_id').length > 1) throw new AuthError('原任务编号不能重复', 400);
    const status = text('status'), model = text('model'), costStatus = text('cost_status'), resultStatus = text('result_status');
    if (status && !['queued', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'].includes(status)
      || costStatus && !['pending', 'conflict', 'confirmed', 'unconnected'].includes(costStatus)
      || resultStatus && !['not_ready', 'ready'].includes(resultStatus)) throw new AuthError('不支持的图片筛选条件', 400);
    const page = Number(params.get('page') || 1), pageSize = Number(params.get('page_size') || (cursor ? 24 : 30));
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AuthError('分页条件无效', 400);
    const filters: Prisma.Sql[] = [Prisma.sql`1 = 1`];
    if (taskId) filters.push(Prisma.sql`t."id" = ${taskId}`);
    if (moduleId) filters.push(Prisma.sql`t."module_id" = ${moduleId}`);
    if (ownerId) filters.push(Prisma.sql`t."owner_id" = ${ownerId}`);
    if (model) filters.push(Prisma.sql`t."model" = ${model}`);
    if (status) {
      const states = studioTaskStates(status === 'queued' ? ['queued', 'channel_queued'] : status === 'running' ? ['running', 'channel_running'] : [status]);
      filters.push(Prisma.sql`t."status" IN (${Prisma.join(states)})`);
    }
    let from: Date | null = null, to: Date | null = null;
    for (const key of ['date_from', 'date_to'] as const) {
      const value = params.get(key);
      if (!value) continue;
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new AuthError('日期筛选无效', 400);
      if (key === 'date_to' && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
      if (key === 'date_from') { from = date; filters.push(Prisma.sql`t."created_at" >= ${date}`); }
      else { to = date; filters.push(Prisma.sql`t."created_at" <= ${date}`); }
    }
    if (from && to && from > to) throw new AuthError('日期范围无效', 400);
    const billing = Prisma.sql`REPLACE(REPLACE(t."billing_status", 'rate_', ''), 'channel_', '')`;
    const hasCash = Prisma.sql`EXISTS (SELECT 1 FROM "CostLedger" c WHERE c."image_task_id" = t."id" AND c."event_type" IN ('official_charge', 'adjustment', 'reversal'))`;
    const conflict = Prisma.sql`(${billing} = 'conflict' OR EXISTS (SELECT 1 FROM "CostLedger" c WHERE c."image_task_id" = t."id" AND c."confidence" = 'disputed'))`;
    const confirmed = Prisma.sql`(${hasCash} AND NOT EXISTS (SELECT 1 FROM "CostLedger" c WHERE c."image_task_id" = t."id" AND c."event_type" IN ('official_charge', 'adjustment', 'reversal')
      AND (c."confidence" NOT IN ('confirmed', 'reconciled') OR (c."amount_minor" IS NULL AND c."amount_micros" IS NULL) OR c."currency" IS NULL OR c."currency" = '')))`;
    const supplierStatus = Prisma.sql`CASE WHEN ${conflict} THEN 'conflict' WHEN ${confirmed} THEN 'confirmed' WHEN ${hasCash} OR t."billing_mode" = 'actual' THEN 'pending' ELSE 'unconnected' END`;
    if (costStatus) filters.push(Prisma.sql`(${supplierStatus}) = ${costStatus}`);
    if (resultStatus) {
      if (status && status !== 'succeeded') throw new AuthError('结果文件筛选仅适用于已生成图片', 400);
      filters.push(Prisma.sql`t."status" = 'succeeded'`);
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM "Asset" a WHERE a."id" = t."asset_id" AND a."status" = 'active' AND a."original_url" <> '')`;
      filters.push(resultStatus === 'not_ready' ? Prisma.sql`NOT ${exists}` : exists);
    }
    const where = Prisma.join(filters, ' AND ');
    const result = await prisma.$transaction(async tx => {
      const count = await tx.$queryRaw<Array<{ total: bigint | number }>>`SELECT COUNT(*) AS total FROM "ImageStudioTask" t WHERE ${where}`;
      let cursorFilter = Prisma.empty;
      if (cursor) {
        const found = await tx.$queryRaw<Array<{ created_at: Date | number }>>`SELECT t."created_at" FROM "ImageStudioTask" t WHERE ${where} AND t."id" = ${cursor}`;
        if (!found.length) throw new AuthError('分页位置已变化，请重新读取', 409);
        cursorFilter = Prisma.sql`AND (t."created_at" < ${found[0].created_at} OR (t."created_at" = ${found[0].created_at} AND t."id" < ${cursor}))`;
      }
      const ids = await tx.$queryRaw<Array<{ id: string; supplier_cost_status: string }>>`SELECT t."id", ${supplierStatus} AS supplier_cost_status FROM "ImageStudioTask" t WHERE ${where} ${cursorFilter}
        ORDER BY t."created_at" DESC, t."id" DESC LIMIT ${pageSize + 1} OFFSET ${cursor ? 0 : (page - 1) * pageSize}`;
      const rows = await tx.imageStudioTask.findMany({ where: { id: { in: ids.slice(0, pageSize).map(item => item.id) } },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: {
          id: true, batch_id: true, owner_id: true, module_id: true, ordinal: true, prompt: true, model: true,
          status: true, deleted_at: true, error: true, unit_credits: true, provider_cost_usd: true,
          billing_status: true, actual_amount_micros: true, actual_credits: true, billing_contract_json: true,
          aspect_ratio: true, output_size: true, created_at: true, finished_at: true, asset_id: true,
        } });
      const assetIds = rows.flatMap(task => task.asset_id ? [task.asset_id] : []);
      const assets = await tx.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true, status: true } });
      const owners = await tx.user.findMany({ where: { id: { in: Array.from(new Set(rows.map(task => task.owner_id))) } }, select: { id: true, name: true, username: true, email: true, avatar_url: true } });
      const tasks = rows.map(task => ({ id: task.id, batchId: task.batch_id, ownerId: task.owner_id,
        owner: owners.find(owner => owner.id === task.owner_id) || null, moduleId: task.module_id, ordinal: task.ordinal,
        prompt: task.prompt, model: task.model, status: publicImageTaskStatus(task.status), deletedAt: task.deleted_at,
        error: task.error, unitCredits: task.unit_credits, providerCostUsd: task.provider_cost_usd,
        billing: imageBillingView(task, task.owner_id, true), costStatus: ids.find(item => item.id === task.id)?.supplier_cost_status || 'unconnected', aspectRatio: task.aspect_ratio, outputSize: task.output_size,
        createdAt: task.created_at, finishedAt: task.finished_at, asset: assets.find(asset => asset.id === task.asset_id && asset.status === 'active') || null }));
      const total = Number(count[0]?.total || 0);
      return { tasks, nextCursor: ids.length > pageSize ? rows[rows.length - 1]?.id || null : null,
        pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
    });
    return adminJson(result);
  } catch (error) {
    if (error instanceof AuthError) return adminJson({ error: error.message }, error.status);
    console.error('[Admin/ImageStudioTasks] List failed');
    return adminJson({ error: '图片任务审计读取失败，请重试' }, 503);
  }
});
