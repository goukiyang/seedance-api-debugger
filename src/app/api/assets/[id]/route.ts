/**
 * GET /api/assets/[id]          — 查询单条资产
 * PATCH /api/assets/[id]        — 更新资产（名称或状态）
 * DELETE /api/assets/[id]       — 软删除：从列表移除，不删官方 asset
 *
 * 真正的官方删除走 /api/assets/[id]/provider-delete
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAsset, updateAsset as providerUpdate, deleteAsset as providerDelete } from '@/lib/provider/seedance-assets';
import { seedanceStore } from '@/lib/assets/seedance-store';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const record = seedanceStore.get(params.id);
    if (!record) {
      return NextResponse.json({ error: '资产不存在' }, { status: 404 });
    }

    // 同步查询官方最新详情
    const result = await getAsset({ providerAssetId: record.providerAssetId });
    if (result.error) {
      // 官方查询失败时返回本地记录，标记状态
      return NextResponse.json({
        asset: {
          ...record,
          status: result.statusCode === 404 ? 'ProviderDeleted' : 'Unknown',
          providerPreviewUrl: '',
        },
        providerSyncError: result.error,
      });
    }

    // 更新本地记录的预览 URL 和状态
    const { item } = result.data!;
    const updated = seedanceStore.update(params.id, {
      providerPreviewUrl: item.url,
      status: item.status === 'Active' ? 'Active' : 'Unknown',
    });

    return NextResponse.json({ asset: updated ?? record });
  } catch (err) {
    console.error('[GetAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '查询失败' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { name } = body as { name?: string };

    const record = seedanceStore.get(params.id);
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

    // 更新本地
    const updated = seedanceStore.update(params.id, {
      name: name ? name.trim() : record.name,
    });

    return NextResponse.json({ asset: updated });
  } catch (err) {
    console.error('[PatchAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '更新失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const record = seedanceStore.get(params.id);
    if (!record) {
      return NextResponse.json({ error: '资产不存在' }, { status: 404 });
    }

    // 软删除：只改状态，不删官方 asset
    const updated = seedanceStore.update(params.id, { status: 'Deleted' });

    return NextResponse.json({
      success: true,
      asset: updated,
      message: '已从素材库移除，官方资产保留',
    });
  } catch (err) {
    console.error('[DeleteAsset] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 }
    );
  }
}
