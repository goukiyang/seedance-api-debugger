/**
 * DELETE /api/assets/[id]/provider-delete
 * 彻底删除官方 Seedance asset
 * 警告：不可逆操作
 *
 * TODO: 未来接入生成任务后，需增加“是否被任务引用”检查
 */

import { NextRequest, NextResponse } from 'next/server';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, getSession } from '@/lib/auth/session';
import { deleteAsset } from '@/lib/provider/seedance-assets';
import { seedanceAssetRepository } from '@/lib/assets/seedanceAssetRepository';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权删除旧版 Seedance 官方素材。');

    const record = await seedanceAssetRepository.get(params.id);
    if (!record) {
      return NextResponse.json({ error: '资产不存在' }, { status: 404 });
    }

    if (record.status === 'ProviderDeleted') {
      return NextResponse.json({ error: '官方资产已被删除，无需重复操作' }, { status: 400 });
    }

    // 调用官方删除
    const result = await deleteAsset({ providerAssetId: record.providerAssetId });

    if (result.error) {
      // 官方删除失败，标记为失败状态
      await seedanceAssetRepository.markDeleteFailed(params.id, result.error);
      return NextResponse.json(
        { error: `官方删除失败：${result.error}` },
        { status: 502 }
      );
    }

    // 官方删除成功
    const updated = await seedanceAssetRepository.markProviderDeleted(params.id);

    return NextResponse.json({
      success: true,
      asset: updated,
      message: '官方资产已删除',
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[ProviderDeleteAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 }
    );
  }
}
