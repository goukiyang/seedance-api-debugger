import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { imageBillingReadinessPayload, saveImageBillingIntent } from '@/lib/image-studio/billing-readiness';
import { prisma } from '@/lib/prisma';
import { getImageGenerationSettingsForModel } from '@/lib/integrations/image-generation';
import { matchImageSupplierCharge, readImageSupplierBills } from '@/lib/image-studio/billing-provider';
import { settleImageSupplierCharge } from '@/lib/image-studio/billing';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { await getAdminUser(request); return NextResponse.json(await imageBillingReadinessPayload(), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return NextResponse.json({ error: error instanceof AuthError ? error.message : '读取计费状态失败' }, { status: error instanceof AuthError ? error.status : 503 }); }
}
export async function PUT(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json();
    if (typeof body.enabled !== 'boolean' || !Number.isSafeInteger(body.revision) || body.revision < 0
      || body.confirmNewImageActualBilling !== true || !Array.isArray(body.enabledModels)
      || body.enabledModels.some((model: unknown) => typeof model !== 'string' || !IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number]))) return NextResponse.json({ error: '请明确选择新图片实扣模型并确认意向' }, { status: 400 });
    const saved = await saveImageBillingIntent(body.enabled, body.revision, user.id, body.enabledModels);
    if (!saved) return NextResponse.json({ error: '计费设置已变化，请重新读取' }, { status: 409 });
    return NextResponse.json(await imageBillingReadinessPayload(), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return NextResponse.json({ error: error instanceof AuthError ? error.message : '保存计费意向失败，未确认启用' }, { status: error instanceof AuthError ? error.status : 503 }); }
}

export async function POST(request: NextRequest) {
  try {
    await getAdminUser(request);
    const body = await request.json();
    if (body.action !== 'record-late-provider-cost' || typeof body.taskId !== 'string' || body.taskId.length > 120)
      return NextResponse.json({ error: '请选择需要核对迟到账单的图片任务' }, { status: 400 });
    const task = await prisma.imageStudioTask.findUnique({ where: { id: body.taskId } });
    if (!task?.billing_scope || !task.gateway_request_id || !['manual', 'conflict', 'deadline_expired', 'unmatched'].includes(task.billing_status))
      return NextResponse.json({ error: '该任务不属于已退出自动结算的可核对任务' }, { status: 409 });
    const settings = await getImageGenerationSettingsForModel(task.model);
    const match = matchImageSupplierCharge(await readImageSupplierBills(settings, task.billing_scope), task.gateway_request_id, task.model);
    if (match.state !== 'matched') return NextResponse.json({ state: match.state, userCharged: false }, { status: 409 });
    return NextResponse.json({ recorded: await settleImageSupplierCharge(task.id, match.charge, true), userCharged: false }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return NextResponse.json({ error: error instanceof AuthError ? error.message : '账单核对未确认；用户不会被追扣' }, { status: error instanceof AuthError ? error.status : 503 }); }
}
