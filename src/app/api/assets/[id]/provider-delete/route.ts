import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { deleteAsset } from '@/lib/provider/seedance-assets';
import { assertMedia } from '@/lib/access/media-policy';
import { prisma } from '@/lib/prisma';

export const DELETE = apiRoute({ access: 'admin', rateLimit: false }, async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const user = await getSession();
    if (!user || user.role !== 'admin' || user.account_type !== 'internal') throw new AuthError('仅管理员可删除供应商素材', 403);
    const body = await request.json().catch(() => null);
    if (body?.confirm_asset_id !== id) throw new AuthError('请再次确认要永久删除的素材', 400);
    await assertMedia(user, { type: 'seedance', id }, 'delete');
    const record = await prisma.$transaction(async tx => {
      const current = await tx.seedanceAsset.findUnique({ where: { id } });
      if (!current || current.ownership_status !== 'owned' || !current.owner_id || current.local_status !== 'Active') throw new AuthError('归属或删除状态待核对，未再次发送', 409);
      const claimed = await tx.seedanceAsset.updateMany({ where: { id, local_status: 'Active', owner_id: current.owner_id, ownership_status: 'owned' }, data: { local_status: 'ProviderDeletePending' } });
      if (claimed.count !== 1) throw new AuthError('删除状态已变化，未再次发送', 409);
      await tx.operationLog.create({ data: { operator_id: user.id, action: 'seedance_provider_delete_requested', target_type: 'SeedanceAsset', target_id: id,
        detail: JSON.stringify({ confirmedAssetId: id, ownerId: current.owner_id }) } });
      return current;
    });
    // A timeout/exception keeps ProviderDeletePending. Never resend an unknown deletion.
    const result = await deleteAsset({ providerAssetId: record.provider_asset_id });
    if (result.error) return NextResponse.json({ error: '供应商删除结果待核对，未再次发送' }, { status: 502 });
    await prisma.$transaction(async tx => {
      await tx.seedanceAsset.updateMany({ where: { id, local_status: 'ProviderDeletePending' }, data: { local_status: 'ProviderDeleted', provider_deleted_at: new Date() } });
      await tx.operationLog.create({ data: { operator_id: user.id, action: 'seedance_provider_delete_succeeded', target_type: 'SeedanceAsset', target_id: id } });
    });
    return NextResponse.json({ success: true, localId: id, status: 'ProviderDeleted' });
  } catch (error) {
    return error instanceof AuthError ? NextResponse.json({ error: error.message }, { status: error.status }) : apiErrorResponse(error);
  }
});
