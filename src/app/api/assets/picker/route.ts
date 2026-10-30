import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getAccessibleProjectIds, assertCanViewTask } from '@/lib/projects/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { getAlbumAccess, assertCanViewReferenceImage, canDownloadOriginal } from '@/lib/reference-albums/permissions';
import { studioHiddenAssetUrls, studioVisibleReferenceWhere } from '@/lib/image-studio/protected-assets';
import { sameOriginPublicUrlForSiteUpload } from '@/lib/assets/site-url';
import type { PickerAlbum, PickerItem, PickerScope, PickerTemplate } from '@/lib/assets/picker-types';
import { templateFilterId } from '@/lib/assets/picker-types';
import { comparisonOriginalVersion } from '@/lib/media/image-comparison-version';
import { removedLibraryResources } from '@/lib/assets/library-removal';
import { generationOrigins } from '@/lib/assets/generation-origin';
import { ordinaryVideoTaskWhere, safeVideoTaskKeywordWhere } from '@/lib/video/multiview-task-privacy';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { observeOperation } from '@/lib/performance/server-operations';
import { catalogReaderReady, readCatalogRevision } from '@/lib/image-studio/catalog-revision';
import { readPickerDirectory, type PickerDirectorySelection } from '@/lib/assets/picker-directory';
import { CatalogSqlCompatibilityError } from '@/lib/assets/catalog-visibility-sql';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { studioViewableOutputSql } from '@/lib/image-studio/output-task-sql';

export const dynamic = 'force-dynamic';
const scopes: PickerScope[] = ['mine', 'project', 'shared', 'public'];

function duration(json: string | null) {
  try {
    const meta = JSON.parse(json || '{}');
    const value = meta.durationSeconds ?? meta.duration_seconds ?? meta.duration;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

// Read-only selection projection. The workspace and studio remain authoritative at attachment time.
export async function GET(request: NextRequest) {
  try {
    let user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    let p = request.nextUrl.searchParams;
    const observed = observeOperation('assets.picker');
    let exactKeys = p.has('keys') ? Array.from(new Set(p.getAll('keys').flatMap(value => value.split(',')))).filter(Boolean) : null;
    if (exactKeys && (exactKeys.length > 80 || exactKeys.some(key => !/^(asset|reference_image|video_task):[a-zA-Z0-9_-]{1,100}$/.test(key)))) {
      return NextResponse.json({ error: '精确素材查询最多80项，编号必须有效' }, { status: 400 });
    }
    let directory: PickerDirectorySelection | undefined;
    if ((p.get('protocol') === 'catalog-paged-v2' || exactKeys) && await catalogReaderReady(prisma)) {
      try { directory = await readPickerDirectory(prisma, user, p, exactKeys); }
      catch (error) { if (!(error instanceof CatalogSqlCompatibilityError)) throw error; }
    }
    if (directory) {
      user = directory.user; exactKeys = directory.keys;
      p = new URLSearchParams(p); for (const field of ['q', 'source', 'template', 'view', 'after']) p.delete(field);
      p.set('page', '1'); p.set('keys', directory.keys.join(','));
    }
    const exactIds = (kind: string) => exactKeys?.filter(key => key.startsWith(`${kind}:`)).map(key => key.slice(kind.length + 1));
    const scope: PickerScope = scopes.includes(p.get('scope') as PickerScope) ? p.get('scope') as PickerScope : 'mine';
    const imageStudio = p.get('target') === 'image-studio';
    const assetOnly = p.get('target') !== 'workspace';
    const q = (p.get('q') || '').trim().slice(0, 160);
    const types = (p.get('types') || 'image,video,audio').split(',').filter(t => ['image', 'video', 'audio'].includes(t));
    const requestedPage = Number(p.get('page'));
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = exactKeys ? 80 : 40;
    const projects = directory ? [] : await getAccessibleProjectIds(user);
    const hidden = await studioHiddenAssetUrls(user, prisma, directory?.keys.filter(key => key.startsWith('asset:')).map(key => key.slice(6)));
    const removals = await removedLibraryResources(user.id, exactKeys || undefined);
    const removed = new Set(Object.entries(removals).flatMap(([kind, ids]) => ids.map(id => `${kind}:${id}`)));
    const visibleRefs = await studioVisibleReferenceWhere(user, prisma, directory?.referenceIds);
    const now = new Date();
    const candidates = await prisma.referenceAlbum.findMany({
      where: { status: 'active', ...(directory ? { images: { some: { id: { in: directory.referenceIds } } } } : exactKeys ? { images: { some: { OR: [
        { id: { in: exactIds('reference_image')! } }, { asset_id: { in: exactIds('asset')! } },
      ] } } } : {}), ...(!directory ? { OR: [
        { owner_user_id: user.id }, { project_id: { in: projects } },
        { visibility: 'public' }, { album_type: { in: ['public', 'system'] } },
        { shares: { some: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: now } }],
          AND: [{ OR: [{ grantee_type: 'user', grantee_id: user.id }, { grantee_type: 'project', grantee_id: { in: projects } }] }] } } },
      ] } : {}) },
      include: {
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        project: { select: { id: true, name: true, owner_user_id: true, status: true } },
        shares: { where: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: now } }] } },
        _count: { select: { images: { where: { status: 'active', AND: [visibleRefs] } } } },
      }, orderBy: [{ updated_at: 'desc' }, { id: 'asc' }],
    });
    const albums: PickerAlbum[] = [];
    const downloadableAlbums = new Set<string>();
    const usableAlbumIds: string[] = [];
    const scopeAlbumIds: string[] = [];
    for (const album of candidates) {
      const access = await getAlbumAccess(user, album);
      if (!access.permissions.view || !access.permissions.use) continue;
      usableAlbumIds.push(album.id);
      if (access.permissions.download) downloadableAlbums.add(album.id);
      const memberships: PickerScope[] = [];
      if (album.owner_user_id === user.id && album.album_type === 'personal') memberships.push('mine');
      if (album.project_id && projects.includes(album.project_id) && album.album_type === 'project') memberships.push('project');
      if (album.shares.some(s => s.grantee_type === 'user' && s.grantee_id === user.id || s.grantee_type === 'project' && projects.includes(s.grantee_id))) memberships.push('shared');
      if (album.visibility === 'public' || ['public', 'system'].includes(album.album_type)) memberships.push('public');
      if (directory) memberships.splice(0, memberships.length, ...directory.albums.filter(item => item.id === album.id).map(item => item.scope));
      for (const member of memberships) albums.push({ id: album.id, name: album.name, scope: member, project: album.project, count: album._count.images });
      if (memberships.includes(scope)) scopeAlbumIds.push(album.id);
    }
    const albumId = p.get('album');
    const projectId = p.get('project');
    const permittedAlbums = scopeAlbumIds.filter(id => (!albumId || id === albumId) && (!projectId || albums.some(a => a.id === id && a.project?.id === projectId)));
    const assetWhere: Prisma.AssetWhereInput = {
      owner_id: user.id, status: 'active', type: { in: imageStudio ? ['image'] : types },
      ...(directory ? { id: { in: directory.directAssetIds } } : exactKeys ? { id: { in: exactIds('asset')! } } : {}),
      ...(hidden.length ? { original_url: { notIn: hidden } } : {}),
    };
    const refWhere: Prisma.ReferenceImageWhereInput = {
      status: 'active', AND: [visibleRefs, ...(directory ? [{ id: { in: directory.referenceIds } }] : exactKeys ? [{ OR: [{ id: { in: exactIds('reference_image')! } }, { asset_id: { in: exactIds('asset')! } }] }] : []), { OR: [
        { album_id: { in: permittedAlbums } },
        ...(scope === 'mine' && !albumId && !projectId
          ? [{ owner_user_id: user.id, asset_id: null, album_id: { in: usableAlbumIds } }] : []),
      ] }, { OR: [
        { asset: { is: { status: 'active', type: { in: imageStudio ? ['image'] : types } } } },
        ...(imageStudio || types.includes('image') ? [{ asset_id: null }] : []),
      ] }],
    };
    const [assets, references, generatedTasks, favorites, videoTasks] = await Promise.all([
      scope === 'mine' && !albumId && !projectId ? prisma.asset.findMany({ where: assetWhere, select: { id: true, owner_id: true, type: true, file_name: true, metadata_json: true, created_at: true } }) : Promise.resolve([]),
      prisma.referenceImage.findMany({ where: refWhere, select: { id: true, album_id: true, owner_user_id: true, source_type: true, created_at: true, asset: { select: { id: true, type: true, file_name: true, metadata_json: true, owner_id: true } } } }),
      exactKeys ? Promise.resolve([]) : prisma.imageStudioTask.findMany({ where: { owner_id: user.id, AND: [studioOutputTaskWhere], asset_id: { not: null } }, select: { asset_id: true, status: true, usage_json: true } }),
      p.get('view') === 'favorites' ? prisma.contentReaction.findMany({ where: { user_id: user.id, OR: [{ liked: true }, { favorited: true }] }, select: { content_key: true } }) : Promise.resolve([]),
      !imageStudio && types.includes('video') && scope === 'mine' && !albumId && !projectId ? prisma.videoTask.findMany({ where: {
        ...(exactKeys ? { id: { in: exactIds('video_task')! } } : {}),
        local_status: 'succeeded', retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] },
        OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }],
        AND: [ordinaryVideoTaskWhere(), ...(q ? [safeVideoTaskKeywordWhere(q)] : [])],
      }, select: { id: true, owner_user_id: true, user_id: true, project_id: true, retention_status: true, local_video_path: true, public_video_url: true, duration: true, created_at: true } }) : Promise.resolve([]),
    ]);
    const selectedGenerationTasks = directory ? [] : exactKeys ? await prisma.imageStudioTask.findMany({ where: { owner_id: user.id,
      AND: [studioOutputTaskWhere], asset_id: { in: Array.from(new Set([...assets.map(asset => asset.id), ...references.flatMap(ref => ref.asset ? [ref.asset.id] : [])])) } },
      select: { asset_id: true, status: true, usage_json: true } }) : generatedTasks;
    const candidateAssetIds = Array.from(new Set([...assets.map(asset => asset.id), ...references.flatMap(ref => ref.asset ? [ref.asset.id] : [])]));
    const selectedGenerated = directory && candidateAssetIds.length ? await prisma.$queryRaw<Array<{ asset_id: string }>>(Prisma.sql`SELECT DISTINCT generated."asset_id" FROM "ImageStudioTask" generated
      WHERE generated."asset_id" IN (${Prisma.join(candidateAssetIds)}) AND generated."owner_id" = ${user.id} AND ${studioViewableOutputSql('generated')}`) : [];
    const generatedIds = new Set(directory ? selectedGenerated.map(row => row.asset_id) : selectedGenerationTasks.filter(studioTaskHasViewableOutput).map(t => t.asset_id));
    const origins = await generationOrigins(user, [...assets, ...references.flatMap(ref => ref.asset ? [ref.asset] : [])], Boolean(directory));
    const assetSource = (asset: { id: string; metadata_json: string | null }): PickerItem['source'] => {
      if (origins.has(asset.id) || generatedIds.has(asset.id)) return 'generated';
      try {
        const meta = JSON.parse(asset.metadata_json || '{}');
        if (typeof meta.studioTaskId === 'string' || ['image_generation_api', 'workspace_generation'].includes(meta.source)) return 'generated';
      } catch { /* The existing Asset history treats non-generated owned files as uploads. */ }
      return 'uploaded';
    };
    const url = (value: string) => sameOriginPublicUrlForSiteUpload(value) || value;
    const items: PickerItem[] = assets.map(a => ({ key: `asset:${a.id}`, identity: `asset:${a.id}`, id: a.id, assetId: a.id,
      type: a.type as PickerItem['type'], originalUrl: '', thumbnailUrl: null,
      fileName: a.file_name, width: null, height: null, duration: null, createdAt: a.created_at.toISOString(), source: assetSource(a) }));
    for (const ref of references) {
      const a = ref.asset;
      if (!a) {
        items.push({ key: `reference_image:${ref.id}`, identity: `reference_image:${ref.id}`, id: ref.id,
          referenceImageId: ref.id, type: 'image', fileName: `参考图-${ref.id}`,
          previewUrl: `/api/reference-images/${ref.id}/content?variant=preview`,
          originalUrl: downloadableAlbums.has(ref.album_id) ? `/api/reference-images/${ref.id}/content?variant=original` : '',
          thumbnailUrl: `/api/reference-images/${ref.id}/content?variant=thumbnail`,
          width: null, height: null, duration: null, createdAt: ref.created_at.toISOString(),
          source: ref.source_type === 'generated' ? 'generated' : ref.source_type === 'upload' ? 'uploaded' : 'other',
          canRemoveFromLibrary: scope === 'mine' && ref.owner_user_id === user.id,
          ...(assetOnly ? downloadableAlbums.has(ref.album_id)
            ? { importUrl: `/api/reference-images/${ref.id}/content?variant=original` }
            : { unavailableReason: '当前用途需要本人素材；此图集未授权原图下载，暂不能添加，可在视频参考区直接使用' } : {}),
        });
        continue;
      }
      const needsImport = assetOnly && a.owner_id !== user.id;
      items.push({ key: `asset:${a.id}`, identity: `asset:${a.id}`, id: assetOnly ? a.id : ref.id,
        assetId: a.id, ...(!assetOnly || needsImport ? { referenceImageId: ref.id } : {}),
        ...(needsImport ? downloadableAlbums.has(ref.album_id) ? { importUrl: `/api/reference-images/${ref.id}/content?variant=original` } : { unavailableReason: '当前用途需要本人素材；此图集未授权原图下载，暂不能添加，可在视频参考区直接使用' } : {}), type: a.type as PickerItem['type'],
        originalUrl: '', thumbnailUrl: null, fileName: a.file_name,
        width: null, height: null, duration: null, createdAt: ref.created_at.toISOString(),
        source: ref.source_type === 'generated' || assetSource(a) === 'generated' ? 'generated' : ref.source_type === 'upload' ? 'uploaded' : 'other' });
    }
    for (const task of videoTasks) {
      try { await assertCanViewTask(user, task); } catch { continue; }
      const ready = Boolean(task.local_video_path || task.public_video_url);
      items.push({ key: `video_task:${task.id}`, identity: `video_task:${task.id}`, id: task.id, type: 'video',
        originalUrl: `/api/video/play/${task.id}`, thumbnailUrl: `/api/video/thumbnail/${task.id}`, fileName: `seedance-${task.id}.mp4`,
        width: null, height: null, duration: task.duration, createdAt: task.created_at.toISOString(), source: 'generated', canRemoveFromLibrary: true,
        ...(ready ? { importUrl: `/api/video/download/${task.id}` } : { unavailableReason: '视频还没有可下载文件，暂不能添加；请在生成记录中完成保存后再选用' }) });
    }
    const favoriteKeys = new Set(favorites.map(f => f.content_key));
    const keys = exactKeys || [];
    const source = p.get('source');
    const templateOptions = new Map<string, PickerTemplate>();
    for (const item of items) {
      if (item.source === 'generated') item.generationOrigin = item.type === 'video' ? { kind: 'video-generated', label: '视频生成' }
        : item.assetId ? origins.get(item.assetId) || { kind: 'unknown', label: '来源待识别' } : { kind: 'unknown', label: '来源待识别' };
      const origin = item.generationOrigin;
      if (!(removed.has(item.identity) && scope === 'mine') && origin?.templateId && origin.templateName) {
        const aliases = Array.from(new Set([...(templateOptions.get(origin.templateId)?.aliases || []), ...(origin.templateAliases || [])]));
        templateOptions.set(origin.templateId, { id: origin.templateId, name: origin.templateName, ...(aliases.length ? { aliases } : {}) });
      }
    }
    const requestedTemplate = templateFilterId(p.get('template'));
    const templateId = requestedTemplate && (templateOptions.get(requestedTemplate)?.id
      || Array.from(templateOptions.values()).find(option => option.aliases?.includes(requestedTemplate))?.id || requestedTemplate);
    const dedup = new Map<string, PickerItem>();
    const albumById = new Map(albums.map(album => [album.id, album.name]));
    const albumNames = new Map<string, string[]>();
    for (const ref of references) {
      const name = albumById.get(ref.album_id);
      if (!name) continue;
      for (const identity of [`reference_image:${ref.id}`, ...(ref.asset ? [`asset:${ref.asset.id}`] : [])]) albumNames.set(identity, [...(albumNames.get(identity) || []), name]);
    }
    for (const item of items) {
      if (removed.has(item.identity) && scope === 'mine') continue;
      if (source && source !== 'all' && item.source !== source && item.generationOrigin?.kind !== source) continue;
      if (templateId && item.generationOrigin?.templateId !== templateId) continue;
      if (q && !item.key.startsWith('video_task:') && ![item.fileName, item.generationOrigin?.templateName || '', ...(albumNames.get(item.identity) || [])].some(name => name.toLocaleLowerCase().includes(q.toLocaleLowerCase()))) continue;
      if (p.get('view') === 'favorites' && !favoriteKeys.has(item.key) && !favoriteKeys.has(`reference_image:${item.referenceImageId}`)) continue;
      if (p.has('keys') && !keys.includes(item.key) && !keys.includes(`reference_image:${item.referenceImageId}`)) continue;
      if (!dedup.has(item.identity)) dedup.set(item.identity, item);
    }
    const sorted = Array.from(dedup.values()).sort((a, b) => p.get('sort') === 'name' ? a.fileName.localeCompare(b.fileName, 'zh-CN') || a.identity.localeCompare(b.identity) : b.createdAt.localeCompare(a.createdAt) || a.identity.localeCompare(b.identity));
    if (p.get('view') === 'recent') sorted.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    // Merge lightweight authorized identities first; load media metadata only for this page.
    const after = p.get('after');
    const afterIndex = after ? sorted.findIndex(item => item.identity === after) : -1;
    if (after && afterIndex < 0) return NextResponse.json({ error: '素材目录已变化，请重新读取' }, { status: 409 });
    const start = after ? afterIndex + 1 : (page - 1) * limit;
    const pageItems = sorted.slice(start, start + limit);
    const pageAssets = await prisma.asset.findMany({ where: { id: { in: pageItems.flatMap(i => i.assetId ? [i.assetId] : []) }, status: 'active', ...(hidden.length ? { original_url: { notIn: hidden } } : {}) } });
    const byId = new Map(pageAssets.map(a => [a.id, a]));
    const projected: PickerItem[] = pageItems.flatMap(item => {
      if (!item.assetId) return [item];
      const asset = byId.get(item.assetId!);
      if (!asset) return [];
      return [{ ...item, canRemoveFromLibrary: scope === 'mine' && asset.owner_id === user.id, width: asset.width, height: asset.height, fileSize: asset.file_size, duration: duration(asset.metadata_json),
        previewUrl: item.referenceImageId ? `/api/reference-images/${item.referenceImageId}/content?variant=preview` : asset.type === 'image' ? `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=preview` : url(asset.original_url),
        originalUrl: asset.type !== 'image' ? item.referenceImageId ? `/api/reference-images/${item.referenceImageId}/content?variant=preview` : url(asset.original_url) : item.referenceImageId
          ? references.some(ref => ref.id === item.referenceImageId && downloadableAlbums.has(ref.album_id)) ? `/api/reference-images/${item.referenceImageId}/content?variant=original` : ''
          : `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=original`,
        thumbnailUrl: item.referenceImageId ? `/api/reference-images/${item.referenceImageId}/content?variant=thumbnail` : asset.type === 'image' ? `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=thumbnail` : asset.thumbnail_url ? url(asset.thumbnail_url) : null }];
    });
    // Only exact foreground selections get an original stat. Library pages stay lightweight.
    if (p.get('comparison') === '1' && keys.length === 1) {
      for (const item of projected) {
        if (item.type !== 'image') continue;
        let original: string | undefined;
        if (item.referenceImageId) {
          const reference = await assertCanViewReferenceImage(user, item.referenceImageId);
          if (await canDownloadOriginal(user, reference)) original = reference.url;
        } else if (item.assetId) {
          const asset = byId.get(item.assetId);
          if (asset?.owner_id === user.id) original = asset.original_url;
        }
        item.comparison = { schema: 2, kind: item.referenceImageId ? 'reference_image' : 'asset',
          id: item.referenceImageId || item.assetId || item.id,
          originalVersion: original ? await comparisonOriginalVersion(original) : null };
      }
    }
    const unavailable = sorted.filter(item => item.unavailableReason).length;
    const hasMore = start + limit < sorted.length;
    if (directory && directory.marker !== await readCatalogRevision(prisma, 'assets')) throw new StudioSharingError('素材目录已变化，请重新读取', 409);
    if (directory && !await catalogReaderReady(prisma)) throw new StudioSharingError('素材目录程序已切换，请重新读取', 409);
    const result = directory ? { protocol: 'catalog-paged-v2', directoryRevision: directory.revision,
      items: directory.keys.flatMap(key => projected.filter(item => item.identity === key)), total: directory.total, page: directory.page, hasMore: directory.hasMore,
      nextCursor: directory.nextCursor, albums: directory.albums, templates: directory.templates,
      ...(unavailable ? { notice: `${unavailable} 个素材暂不能用于此处，原因显示在对应素材下方；其他素材可正常添加` } : {}) }
      : { items: projected, total: sorted.length, page, hasMore,
      nextCursor: hasMore ? pageItems[pageItems.length - 1]?.identity || null : null, albums, templates: Array.from(templateOptions.values()),
      ...(unavailable ? { notice: `${unavailable} 个素材暂不能用于此处，原因显示在对应素材下方；其他素材可正常添加` } : {}),
    };
    observed({ rows: projected.length, bytes: Buffer.byteLength(JSON.stringify(result)) });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof StudioSharingError) return NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    console.error('[AssetPicker] Read failed', error);
    return NextResponse.json({ error: '素材库读取失败，请重试' }, { status: 500 });
  }
}
