/**
 * DELETE /api/assets/[id]/provider-delete
 * 彻底删除官方 Seedance asset
 * 警告：这是不可逆操作，请确认后再调用
 *
 * 调用前检查：
 * 1. 资产确实存在
 * 2. 资产状态不是 ProviderDeleted
 * 3. 用户明确触发
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteAsset } from '@/lib/provider/seedance-assets';
import { seedanceStore } from '@/lib/assets/seedance-store';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const record = seedanceStore.get(params.id);
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
      seedanceStore.update(params.id, { status: 'DeleteFailed' });
      return NextResponse.json(
        { error: `官方删除失败：${result.error}` },
        { status: 502 }
      );
    }

    // 官方删除成功
    seedanceStore.update(params.id, { status: 'ProviderDeleted' });
    const updated = seedanceStore.get(params.id);

    return NextResponse.json({
      success: true,
      asset: updated,
      message: '官方资产已删除',
    });
  } catch (err) {
    console.error('[ProviderDeleteAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 }
    );
  }
}
