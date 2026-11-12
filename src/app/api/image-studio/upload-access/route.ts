import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canAccessImageTemplates, canUseCompanyTemplates, canViewStudioPreset, isExplicitPresetAsset, isExternalImageStudioActor } from '@/lib/image-studio/access';
import { siteUploadBaseUrls } from '@/lib/assets/site-url';
import { studioHiddenAssetUrls } from '@/lib/image-studio/protected-assets';
import { multiviewSystemReferenceFileAccess } from '@/lib/video/multiview-recipe-storage.server';
import { multiviewOutputFileAccess } from '@/lib/video/multiview-output-access.server';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_CHECK_HEADER = 'x-image-studio-upload-access-check';

export async function GET(request: NextRequest) {
  if (request.headers.get(ACCESS_CHECK_HEADER) !== '1') {
    return new NextResponse(null, { status: 404 });
  }

  const pathname = request.nextUrl.searchParams.get('path') || '';
  const user = await getSession();
  const guide = await multiviewSystemReferenceFileAccess(user, pathname);
  if (guide.protected) return new NextResponse(null, { status: guide.allowed ? 204 : 404 });
  const output = await multiviewOutputFileAccess(user, pathname);
  if (output.protected) return new NextResponse(null, { status: output.allowed ? 204 : 404 });
  if ((await studioHiddenAssetUrls(user)).includes(pathname)) return new NextResponse(null, { status: 404 });
  if (!pathname.startsWith('/uploads/assets/') && !pathname.startsWith('/uploads/thumbs/')) {
    return new NextResponse(null, { status: 204 });
  }

  const aliases = [pathname, ...siteUploadBaseUrls().map(base => `${base}${pathname}`)];
  const assets = await prisma.asset.findMany({
    where: { OR: [{ original_url: { in: aliases } }, { thumbnail_url: { in: aliases } }] },
    select: { id: true, owner_id: true },
  });
  if (!assets.length) return new NextResponse(null, { status: user && canUseCompanyTemplates(user) ? 204 : 404 });

  if (!user) return new NextResponse(null, { status: 404 });
  if (!canAccessImageTemplates(user)) return new NextResponse(null, { status: 404 });
  if (assets.some(asset => asset.owner_id === user.id) || canUseCompanyTemplates(user) && user.role === 'admin') return new NextResponse(null, { status: 204 });
  // Source sharing never authorizes external access to the underlying files,
  // including after a source stops referring to an old asset.
  if (isExternalImageStudioActor(user)) return new NextResponse(null, { status: 404 });

  const generatedTasks = await prisma.imageStudioTask.findMany({
    where: { asset_id: { in: assets.map(asset => asset.id) }, owner_id: user.id, AND: [studioOutputTaskWhere], deleted_at: null },
    select: { owner_id: true, deleted_at: true, asset_id: true, status: true, usage_json: true },
  });
  if (generatedTasks.some(studioTaskHasViewableOutput)) {
    return new NextResponse(null, { status: 204 });
  }

  const templates = await prisma.imageStudioPreset.findMany({
    where: { owner_id: { in: Array.from(new Set(assets.map(asset => asset.owner_id))) }, OR: [
      { banner_asset_id: { in: assets.map(asset => asset.id) } },
      ...assets.map(asset => ({ reference_ids: { contains: `\"${asset.id}\"` } })),
    ] },
    select: { owner_id: true, scope: true, is_shared: true, banner_asset_id: true, reference_ids: true },
  });
  if (templates.some(template => canViewStudioPreset(user, template) && assets.some(asset => asset.owner_id === template.owner_id && isExplicitPresetAsset(template, asset.id)))) return new NextResponse(null, { status: 204 });
  return new NextResponse(null, { status: 404 });
}
