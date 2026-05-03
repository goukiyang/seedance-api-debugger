import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { getVisibleResourceDescriptor } from '@/lib/resources';
import { getOrCreateWorkspace, clearWorkspace, addAssetToWorkspace, findOrCreateExternalImageAsset } from '@/lib/assets/workspace';

type LoadMode = 'append' | 'replace';

function normalizeMode(value: unknown): LoadMode {
  return value === 'replace' ? 'replace' : 'append';
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSessionUser(request);
    const resource = await getVisibleResourceDescriptor(params.id, user);

    if (!resource) {
      return errorJson('资源不存在、已下线或无权限访问', 404);
    }

    const body = await request.json().catch(() => ({}));
    const mode = normalizeMode(body.mode);
    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId);

    if (mode === 'replace' && resource.references.length > 0) {
      await clearWorkspace(workspaceId);
    }

    const addedAssets: Array<{ assetId: string; url: string; name: string; role: string }> = [];

    for (const reference of resource.references) {
      const assetId = await findOrCreateExternalImageAsset({
        url: reference.url,
        name: reference.name,
        thumbnailUrl: reference.thumbnailUrl,
      });
      await addAssetToWorkspace(workspaceId, assetId, reference.role);
      addedAssets.push({
        assetId,
        url: reference.url,
        name: reference.name,
        role: reference.role,
      });
    }

    return NextResponse.json({
      success: true,
      resource,
      mode,
      workspaceId,
      addedAssets,
      draftPatch: {
        prompt: resource.promptText,
        parameters: resource.parameters,
      },
      notes: resource.honestyNote ? [resource.honestyNote] : [],
    });
  } catch (error) {
    console.error('[Resources/Load]', error);
    return errorJson('资源载入失败', 500);
  }
}
