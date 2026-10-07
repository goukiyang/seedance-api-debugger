import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getAccessibleProjectIds, assertCanViewTask } from '@/lib/projects/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { getAlbumAccess } from '@/lib/reference-albums/permissions';
import { studioHiddenAssetUrls, studioVisibleReferenceWhere } from '@/lib/image-studio/protected-assets';
import { sameOriginPublicUrlForSiteUpload } from '@/lib/assets/site-url';
import type { PickerAlbum, PickerItem, PickerScope } from '@/lib/assets/picker-types';
import { removedLibraryResources } from '@/lib/assets/library-removal';
import { generationOrigins } from '@/lib/assets/generation-origin';

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
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const p = request.nextUrl.searchParams;
    const scope: PickerScope = scopes.includes(p.get('scope') as PickerScope) ? p.get('scope') as PickerScope : 'mine';
    const imageStudio = p.get('target') === 'image-studio';
    const assetOnly = p.get('target') !== 'workspace';
    const q = (p.get('q') || '').trim().slice(0, 160);
    const types = (p.get('types') || 'image,video,audio').split(',').filter(t => ['image', 'video', 'audio'].includes(t));
    const requestedPage = Number(p.get('page'));
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = 40;
    const projects = await getAccessibleProjectIds(user);
    const hidden = await studioHiddenAssetUrls(user);
    const removals = await removedLibraryResources(user.id);
    const removed = new Set(Object.entries(removals).flatMap(([kind, ids]) => ids.map(id => `${kind}:${id}`)));
    const visibleRefs = await studioVisibleReferenceWhere(user);
    const now = new Date();
    const candidates = await prisma.referenceAlbum.findMany({
      where: { status: 'active', OR: [
        { owner_user_id: user.id }, { project_id: { in: projects } },
        { visibility: 'public' }, { album_type: { in: ['public', 'system'] } },
        { shares: { some: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: now } }],
          AND: [{ OR: [{ grantee_type: 'user', grantee_id: user.id }, { grantee_type: 'project', grantee_id: { in: projects } }] }] } } },
      ] },
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
      for (const member of memberships) albums.push({ id: album.id, name: album.name, scope: member, project: album.project, count: album._count.images });
      if (memberships.includes(scope)) scopeAlbumIds.push(album.id);
    }
    const albumId = p.get('album');
    const projectId = p.get('project');
    const permittedAlbums = scopeAlbumIds.filter(id => (!albumId || id === albumId) && (!projectId || albums.some(a => a.id === id && a.project?.id === projectId)));
    const assetWhere: Prisma.AssetWhereInput = {
      owner_id: user.id, status: 'active', type: { in: imageStudio ? ['image'] : types },
      ...(hidden.length ? { original_url: { notIn: hidden } } : {}),
    };
    const refWhere: Prisma.ReferenceImageWhereInput = {
      status: 'active', AND: [visibleRefs, { OR: [
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
      prisma.imageStudioTask.findMany({ where: { owner_id: user.id, status: 'succeeded', asset_id: { not: null } }, select: { asset_id: true } }),
      p.get('view') === 'favorites' ? prisma.contentReaction.findMany({ where: { user_id: user.id, OR: [{ liked: true }, { favorited: true }] }, select: { content_key: true } }) : Promise.resolve([]),
      !imageStudio && types.includes('video') && scope === 'mine' && !albumId && !projectId ? prisma.videoTask.findMany({ where: {
        local_status: 'succeeded', retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] },
        OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }],
        ...(q ? { AND: [{ OR: [{ id: { contains: q } }, { prompt: { contains: q } }] }] } : {}),
      }, select: { id: true, owner_user_id: true, user_id: true, project_id: true, retention_status: true, local_video_path: true, public_video_url: true, duration: true, created_at: true } }) : Promise.resolve([]),
    ]);
    const generatedIds = new Set(generatedTasks.map(t => t.asset_id));
    const origins = await generationOrigins(user, [...assets, ...references.flatMap(ref => ref.asset ? [ref.asset] : [])]);
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
    const keys = p.getAll('keys').flatMap(k => k.split(',')).filter(k => /^(asset|reference_image|video_task):[a-zA-Z0-9_-]+$/.test(k)).slice(0, 80);
    const source = p.get('source');
    const templateOptions = new Map<string, string>();
    for (const item of items) {
      if (item.source === 'generated') item.generationOrigin = item.type === 'video' ? { kind: 'video-generated', label: '视频生成' }
        : item.assetId ? origins.get(item.assetId) || { kind: 'unknown', label: '来源待识别' } : { kind: 'unknown', label: '来源待识别' };
      if (item.generationOrigin?.templateId && item.generationOrigin.templateName) templateOptions.set(item.generationOrigin.templateId, item.generationOrigin.templateName);
    }
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
      if (p.get('template') && item.generationOrigin?.templateId !== p.get('template')) continue;
      if (q && !item.key.startsWith('video_task:') && ![item.fileName, item.generationOrigin?.templateName || '', ...(albumNames.get(item.identity) || [])].some(name => name.toLocaleLowerCase().includes(q.toLocaleLowerCase()))) continue;
      if (p.get('view') === 'favorites' && !favoriteKeys.has(item.key) && !favoriteKeys.has(`reference_image:${item.referenceImageId}`)) continue;
      if (p.has('keys') && !keys.includes(item.key) && !keys.includes(`reference_image:${item.referenceImageId}`)) continue;
      if (!dedup.has(item.identity)) dedup.set(item.identity, item);
    }
    const sorted = Array.from(dedup.values()).sort((a, b) => p.get('sort') === 'name' ? a.fileName.localeCompare(b.fileName, 'zh-CN') || a.identity.localeCompare(b.identity) : b.createdAt.localeCompare(a.createdAt) || a.identity.localeCompare(b.identity));
    if (p.get('view') === 'recent') sorted.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    // Merge lightweight authorized identities first; load media metadata only for this page.
    const pageItems = sorted.slice((page - 1) * limit, page * limit);
    const pageAssets = await prisma.asset.findMany({ where: { id: { in: pageItems.flatMap(i => i.assetId ? [i.assetId] : []) }, status: 'active', ...(hidden.length ? { original_url: { notIn: hidden } } : {}) } });
    const byId = new Map(pageAssets.map(a => [a.id, a]));
    const projected = pageItems.flatMap(item => {
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
    const unavailable = sorted.filter(item => item.unavailableReason).length;
    return NextResponse.json({ items: projected, total: sorted.length, page, hasMore: page * limit < sorted.length, albums, templates: Array.from(templateOptions, ([id, name]) => ({ id, name })),
      ...(unavailable ? { notice: `${unavailable} 个素材暂不能用于此处，原因显示在对应素材下方；其他素材可正常添加` } : {}),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[AssetPicker] Read failed', error);
    return NextResponse.json({ error: '素材库读取失败，请重试' }, { status: 500 });
  }
}
