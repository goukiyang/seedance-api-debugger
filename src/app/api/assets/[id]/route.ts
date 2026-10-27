import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
/**
 * GET /api/assets/[id]          — 查询单条资产 + 同步官方详情
 * PATCH /api/assets/[id]        — 更新资产（名称）
 * DELETE /api/assets/[id]         — 软删除：本地状态改为 Deleted，不删官方 asset
 *
 * 真正的官方删除走 /api/assets/[id]/provider-delete
 */

import { NextRequest, NextResponse } from 'next/server';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, getSession } from '@/lib/auth/session';
import { getAsset, updateAsset as providerUpdate } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';
import { assertMedia } from '@/lib/access/media-policy';
import { seedanceMediaDTO } from '@/lib/media/seedance-projection';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权访问旧版 Seedance 官方素材。');

    const record = await seedanceAssetRepository.get(params.id);
    if (!record) {
      return NextResponse.json({ error: '资产不存在' }, { status: 404 });
    }
    await assertMedia(user, { type: 'seedance', id: params.id }, 'view-preview');
    if (record.ownershipStatus !== 'owned' || !record.ownerId) {
      return NextResponse.json({ asset: await seedanceMediaDTO(user, record), quarantined: true });
    }

    // 同步查询官方最新详情
    const result = await getAsset({ providerAssetId: record.providerAssetId });

    if (result.error) {
      const syncFailed = result.statusCode === 404 ? 'ProviderDeleted' : 'Unknown';
      return NextResponse.json({
        asset: {
          ...await seedanceMediaDTO(user, record),
          status: syncFailed,
          providerPreviewUrl: '',
        },
        providerSyncError: result.error,
      });
    }

    // 更新本地记录的预览 URL 和状态
    const { item } = result.data!;
    const updated = await seedanceAssetRepository.update(params.id, {
      providerPreviewUrl: item.url,
      providerStatus: item.status,
      rawProviderResponse: JSON.stringify(item),
      lastSyncedAt: new Date(),
    });

    return NextResponse.json({ asset: await seedanceMediaDTO(user, updated ?? record) });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    return apiErrorResponse(err);
  }
});

export const PATCH = apiRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权修改旧版 Seedance 官方素材。');

    const body = await request.json();
    await assertMedia(user, { type: 'seedance', id: params.id }, 'edit');
    const { name } = body as { name?: string };

    const record = await seedanceAssetRepository.get(params.id);
    if (!record) {
      return NextResponse.json({ error: '资产不存在' }, { status: 404 });
    }

    // 如果改了名称，同步更新官方
    if (name && name !== record.name) {
      const result = await providerUpdate({
        providerAssetId: record.providerAssetId,
        name: name.trim(),
      });
      if (result.error) {
        return NextResponse.json({ error: `官方更新失败：${result.error}` }, { status: 502 });
      }
    }

    // 更新本地数据库
    const updated = await seedanceAssetRepository.update(params.id, {
      name: name ? name.trim() : record.name,
    });

    return NextResponse.json({ asset: updated ? await seedanceMediaDTO(user, updated) : null });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    return apiErrorResponse(err);
  }
});

export const DELETE = apiRoute({ access: 'user', rateLimit: false }, async function DELETE(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权删除旧版 Seedance 官方素材。');

    const record = await seedanceAssetRepository.get(params.id);
    if (!record) {
      return NextResponse.json({ error: '资产不存在' }, { status: 404 });
    }

    // 软删除：只改状态，不删官方 asset
    await assertMedia(user, { type: 'seedance', id: params.id }, 'delete');
    const updated = await seedanceAssetRepository.softDelete(params.id);

    return NextResponse.json({
      success: true,
      asset: updated ? await seedanceMediaDTO(user, updated) : null,
      message: '已从素材库移除，官方资产保留',
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    return apiErrorResponse(err);
  }
});
