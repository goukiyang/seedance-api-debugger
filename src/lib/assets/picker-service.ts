import { prisma } from '@/lib/prisma';
import type { Asset, Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { getAccessibleProjectIds, assertCanViewTask } from '@/lib/projects/permissions';
import { getAlbumAccess, getAlbumByIdForAccess, getReferenceImageByIdForAccess } from '@/lib/reference-albums/permissions';
import { studioHiddenAssetUrls } from '@/lib/image-studio/protected-assets';
import { ordinaryVideoTaskWhere, safeVideoTaskKeywordWhere } from '@/lib/video/multiview-task-privacy';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { decideMedia } from '@/lib/access/media-policy';
import { mediaProjection } from '@/lib/media/outlet';
import { comparisonOriginalVersion } from '@/lib/media/image-comparison-version';
import { validComparisonVersion } from '@/lib/media/image-comparison-contract';
import { PaginationError, assertPageOwner } from '@/lib/pagination/cursor';
import type { PickerAlbum, PickerItem, PickerScope, PickerTemplate } from './picker-types';
import { templateFilterId } from './picker-types';
import { pickerOrigin } from './picker-origin';
import { pickerRows, pickerSeek, pickerPage, pickerFingerprint } from './picker-stream';

type Candidate = PickerItem & { mediaRef: { type: 'asset' | 'reference' | 'video'; id: string }; canonical?: string; download: boolean };
type DirectoryAlbum = PickerAlbum & { sortAt: string; membershipOrder: number };
const unavailable = '当前用途需要本人素材；此图集未授权原图下载，暂不能添加，可在视频参考区直接使用';
function mediaDuration(json: string | null) {
  try { const meta = JSON.parse(json || '{}'), value = meta.durationSeconds ?? meta.duration_seconds ?? meta.duration;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export async function readPicker(user: SessionUser, p: URLSearchParams, headers: Headers) {
  assertPageOwner(headers, user.id);
  const scope: PickerScope = ['mine', 'project', 'shared', 'public'].includes(p.get('scope') || '') ? p.get('scope') as PickerScope : 'mine';
  const imageStudio = p.get('target') === 'image-studio', assetOnly = p.get('target') !== 'workspace';
  const q = (p.get('q') || '').trim().slice(0, 160), source = p.get('source'), view = p.get('view');
  const types = Array.from(new Set((imageStudio ? 'image' : p.get('types') || 'image,video,audio').split(',').filter(type => ['image', 'video', 'audio'].includes(type)))).sort();
  const page = p.has('page') ? Number(p.get('page')) : 1;
  const limit = p.has('limit') ? Number(p.get('limit')) : 40;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new PaginationError('分页参数无效');
  const size = Math.min(100, limit), albumId = p.get('album'), projectId = p.get('project');
  const rawKeys = p.getAll('keys').flatMap(key => key.split(',')).filter(Boolean);
  if (rawKeys.length > 80 || rawKeys.some(key => !/^(asset|reference_image|video_task):[a-zA-Z0-9_-]{1,180}$/.test(key))) throw new PaginationError('最多查询80个有效素材编号');
  const keys = Array.from(new Set(rawKeys));
  const requestedTemplate = templateFilterId(p.get('template'));
  const templateContext = templateFilterId(p.get('template_context'));
  let effectiveTemplate = requestedTemplate;
  if (p.get('template') && !requestedTemplate) throw new PaginationError('模板筛选无效');
  if (p.get('template_context') && !templateContext) throw new PaginationError('模板上下文无效');
  const projects = new Set(await getAccessibleProjectIds(user)), hidden = await studioHiddenAssetUrls(user);
  const now = new Date();
  const visibleAlbums: Prisma.ReferenceAlbumWhereInput = { status: 'active', OR: [
    { owner_user_id: user.id }, { project_id: { in: Array.from(projects) } }, { visibility: 'public' }, { album_type: { in: ['public', 'system'] } },
    { shares: { some: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: now } }],
      AND: [{ OR: [{ grantee_type: 'user', grantee_id: user.id }, { grantee_type: 'project', grantee_id: { in: Array.from(projects) } }] }] } } },
  ] };
  const context = JSON.stringify(['picker-v2', user.id, scope, imageStudio, assetOnly, q, types, source, view, p.get('sort'), albumId, projectId, requestedTemplate, templateContext, keys, p.has('keys'), p.get('comparison')]);
  const contains = (value: string) => value.toLocaleLowerCase().includes(q.toLocaleLowerCase());
  const memberships = (album: NonNullable<Awaited<ReturnType<typeof getAlbumByIdForAccess>>>) => {
    const result: PickerScope[] = [];
    if (album.owner_user_id === user.id && album.album_type === 'personal') result.push('mine');
    if (album.project_id && projects.has(album.project_id) && album.album_type === 'project') result.push('project');
    if (album.shares.some(share => share.grantee_type === 'user' && share.grantee_id === user.id || share.grantee_type === 'project' && projects.has(share.grantee_id))) result.push('shared');
    if (album.visibility === 'public' || ['public', 'system'].includes(album.album_type)) result.push('public');
    return result;
  };
  async function removed(identity: string) {
    if (scope !== 'mine') return false;
    const [kind, id] = identity.split(':');
    const markers = [`resource-library-removal:v1:${user.id}:${identity}`, ...(kind === 'asset' ? [`asset-library-removal:v1:${user.id}:${id}`] : [])];
    for (const key of markers) {
      const row = await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
      if (row && JSON.parse(row.value_json)?.removed === true) return true;
    }
    return false;
  }
  async function reference(id: string) {
    const ref = await getReferenceImageByIdForAccess(id);
    if (!ref || ref.album.status !== 'active') return null;
    const access = await getAlbumAccess(user, ref.album);
    if (!access.permissions.view || !access.permissions.use) return null;
    const ownOrphan = scope === 'mine' && !albumId && !projectId && !ref.asset_id && ref.owner_user_id === user.id;
    if (!ownOrphan && (!memberships(ref.album).includes(scope) || albumId && ref.album_id !== albumId || projectId && ref.album.project_id !== projectId)) return null;
    const decision = await decideMedia(user, { type: 'reference', id }, 'use');
    return decision.allowed ? { ref, decision } : null;
  }
  async function matches(item: Candidate, refId?: string, filtered = true) {
    if (await removed(item.identity)) return false;
    if (!filtered) return true;
    if (source && source !== 'all' && item.source !== source && item.generationOrigin?.kind !== source) return false;
    if (effectiveTemplate && item.generationOrigin?.templateId !== effectiveTemplate && !item.generationOrigin?.templateAliases?.includes(requestedTemplate)) return false;
    if (p.has('keys') && !keys.includes(item.key) && !(refId && keys.includes(`reference_image:${refId}`))) return false;
    if (view === 'favorites') {
      const favorite = await prisma.contentReaction.findFirst({ where: { user_id: user.id,
        content_key: { in: [item.key, ...(refId ? [`reference_image:${refId}`] : [])] }, OR: [{ liked: true }, { favorited: true }] }, select: { id: true } });
      if (!favorite) return false;
    }
    return true;
  }
  async function assetCandidate(asset: Asset, filtered = true): Promise<Candidate | null> {
    if (asset.status !== 'active' || !types.includes(asset.type) || hidden.includes(asset.original_url)) return null;
    const ownDecision = scope === 'mine' && !albumId && !projectId && asset.owner_id === user.id
      ? await decideMedia(user, { type: 'asset', id: asset.id }, 'use') : null;
    const own = Boolean(ownDecision?.allowed);
    const refs = () => pickerRows((after, take) => prisma.referenceImage.findMany({ where: { asset_id: asset.id, status: 'active', ...pickerSeek(after) }, orderBy: { id: 'asc' }, take, select: { id: true } }));
    let accessible = own;
    if (!accessible) for await (const row of refs()) if (await reference(row.id)) { accessible = true; break; }
    if (!accessible) return null;
    const provenance = await pickerOrigin(user, asset);
    const baseSource = provenance.generated ? 'generated' as const : 'uploaded' as const;
    const origin = provenance.generated ? asset.type === 'video' ? { kind: 'video-generated' as const, label: '视频生成' } : provenance.origin || { kind: 'unknown' as const, label: '来源待识别' } : undefined;
    const base: Candidate = { key: `asset:${asset.id}`, identity: `asset:${asset.id}`, id: asset.id, assetId: asset.id,
      type: asset.type as PickerItem['type'], fileName: asset.file_name, createdAt: asset.created_at.toISOString(), source: baseSource,
      originalUrl: '', thumbnailUrl: null, width: asset.width, height: asset.height, fileSize: asset.file_size, duration: mediaDuration(asset.metadata_json),
      generationOrigin: origin, mediaRef: { type: 'asset', id: asset.id }, canonical: asset.original_url, download: Boolean(ownDecision?.rights.download), canRemoveFromLibrary: scope === 'mine' && asset.owner_id === user.id };
    let selected = own && await matches(base, undefined, filtered) ? base : null;
    let queryMatch = !q || contains(base.fileName) || contains(origin?.templateName || '');
    for await (const row of refs()) {
      const access = await reference(row.id); if (!access) continue;
      queryMatch ||= contains(access.ref.album.name);
      if (selected) continue;
      const needsImport = assetOnly && asset.owner_id !== user.id;
      const download = access.decision.rights.download;
      const item: Candidate = { ...base, id: assetOnly ? asset.id : access.ref.id, referenceImageId: access.ref.id,
        createdAt: access.ref.created_at.toISOString(), mediaRef: { type: 'reference', id: access.ref.id }, download,
        source: access.ref.source_type === 'generated' || baseSource === 'generated' ? 'generated' : access.ref.source_type === 'upload' ? 'uploaded' : 'other',
        ...(needsImport && !download ? { unavailableReason: unavailable } : {}) };
      if (item.source === 'generated' && !item.generationOrigin) item.generationOrigin = { kind: 'unknown', label: '来源待识别' };
      if (await matches(item, access.ref.id, filtered)) selected = item;
    }
    return selected && (!filtered || queryMatch) ? selected : null;
  }
  async function* scan(filtered = true): AsyncGenerator<Candidate> {
    // The Asset table is the unique identity source, not a full asset/ref map.
    const keyFilter: Prisma.AssetWhereInput = filtered && p.has('keys') ? { OR: [
      { id: { in: keys.filter(key => key.startsWith('asset:')).map(key => key.slice(6)) } },
      { reference_images: { some: { id: { in: keys.filter(key => key.startsWith('reference_image:')).map(key => key.slice(16)) } } } },
    ] } : {};
    for await (const asset of pickerRows((after, take) => prisma.asset.findMany({ where: { status: 'active', type: { in: types }, AND: [keyFilter, pickerSeek(after), { OR: [
      ...(scope === 'mine' && !albumId && !projectId ? [{ owner_id: user.id }] : []),
      { reference_images: { some: { status: 'active', album: visibleAlbums } } },
    ] }], ...(hidden.length ? { original_url: { notIn: hidden } } : {}) }, orderBy: { id: 'asc' }, take }))) {
      const item = await assetCandidate(asset, filtered); if (item) yield item;
    }
    for await (const row of pickerRows((after, take) => prisma.referenceImage.findMany({ where: { status: 'active', asset_id: null, album: visibleAlbums, AND: [pickerSeek(after), ...(filtered && p.has('keys') ? [{ id: { in: keys.filter(key => key.startsWith('reference_image:')).map(key => key.slice(16)) } }] : [])] }, orderBy: { id: 'asc' }, take, select: { id: true } }))) {
      if (!types.includes('image')) continue;
      const access = await reference(row.id); if (!access) continue;
      const ref = access.ref, download = access.decision.rights.download;
      const item: Candidate = { key: `reference_image:${ref.id}`, identity: `reference_image:${ref.id}`, id: ref.id, referenceImageId: ref.id,
        type: 'image', fileName: `参考图-${ref.id}`, createdAt: ref.created_at.toISOString(), source: ref.source_type === 'generated' ? 'generated' : ref.source_type === 'upload' ? 'uploaded' : 'other',
        originalUrl: '', thumbnailUrl: null, width: null, height: null, duration: null, mediaRef: { type: 'reference', id: ref.id }, canonical: ref.url, download,
        canRemoveFromLibrary: scope === 'mine' && ref.owner_user_id === user.id, ...(assetOnly && !download ? { unavailableReason: unavailable } : {}) };
      if (item.source === 'generated') item.generationOrigin = { kind: 'unknown', label: '来源待识别' };
      if ((!filtered || !q || contains(item.fileName) || contains(ref.album.name)) && await matches(item, ref.id, filtered)) yield item;
    }
    if (!imageStudio && types.includes('video') && scope === 'mine' && !albumId && !projectId) {
      for await (const task of pickerRows((after, take) => prisma.videoTask.findMany({ where: { local_status: 'succeeded', retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] },
        OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }], AND: [pickerSeek(after), ordinaryVideoTaskWhere(), ...(filtered && q ? [safeVideoTaskKeywordWhere(q)] : []),
          ...(filtered && p.has('keys') ? [{ id: { in: keys.filter(key => key.startsWith('video_task:')).map(key => key.slice(11)) } }] : [])] }, orderBy: { id: 'asc' }, take,
        select: { id: true, owner_user_id: true, user_id: true, project_id: true, retention_status: true, local_video_path: true, public_video_url: true, duration: true, created_at: true } }))) {
        try { await assertCanViewTask(user, task); } catch { continue; }
        const decision = await decideMedia(user, { type: 'video', id: task.id }, 'use'); if (!decision.allowed) continue;
        const item: Candidate = { key: `video_task:${task.id}`, identity: `video_task:${task.id}`, id: task.id, type: 'video', fileName: `seedance-${task.id}.mp4`,
          originalUrl: '', thumbnailUrl: null, width: null, height: null, duration: task.duration, createdAt: task.created_at.toISOString(), source: 'generated', generationOrigin: { kind: 'video-generated', label: '视频生成' },
          mediaRef: { type: 'video', id: task.id }, canonical: task.local_video_path || task.public_video_url || undefined, download: decision.rights.download,
          canRemoveFromLibrary: true, ...(!task.local_video_path && !task.public_video_url ? { unavailableReason: '视频还没有可下载文件，暂不能添加；请在生成记录中完成保存后再选用' } : {}) };
        if (await matches(item, undefined, filtered)) yield item;
      }
    }
  }
  const compare = (a: Candidate, b: Candidate) => {
    if (view === 'recent') {
      const rank = (item: Candidate) => { const index = keys.indexOf(item.key); return index >= 0 ? index : keys.indexOf(`reference_image:${item.referenceImageId}`); };
      const delta = rank(a) - rank(b); if (delta) return delta;
    }
    return (p.get('sort') === 'name' ? a.fileName.localeCompare(b.fileName, 'zh-CN') : b.createdAt.localeCompare(a.createdAt)) || a.identity.localeCompare(b.identity);
  };

  async function* albumDirectory() {
    for await (const row of pickerRows((after, take) => prisma.referenceAlbum.findMany({ where: { AND: [visibleAlbums, pickerSeek(after)] }, orderBy: { id: 'asc' }, take, select: { id: true } }))) {
      const album = await getAlbumByIdForAccess(row.id); if (!album) continue;
      const access = await getAlbumAccess(user, album); if (!access.permissions.view || !access.permissions.use) continue;
      let count = 0;
      for await (const image of pickerRows((after, take) => prisma.referenceImage.findMany({ where: { album_id: album.id, status: 'active', ...pickerSeek(after) }, orderBy: { id: 'asc' }, take, select: { id: true } }))) if ((await decideMedia(user, { type: 'reference', id: image.id }, 'use')).allowed) count++;
      for (const [membershipOrder, member] of memberships(album).entries()) yield { id: album.id, name: album.name, scope: member, count,
        project: album.project ? { id: album.project.id, name: album.project.name } : null, sortAt: album.updated_at.toISOString(), membershipOrder } satisfies DirectoryAlbum;
    }
  }
  async function findTemplate(id: string, module: boolean) {
    // Project the selected/context aliases, not an unbounded inventory of every
    // workspace alias. The relation alone is insufficient: an output proves it.
    const requestedAliases = Array.from(new Set([requestedTemplate, templateContext].filter(Boolean)));
    const wanted = new Set((await prisma.imageStudioModule.findMany({ where: { id: { in: requestedAliases }, owner_id: user.id, source_preset_id: id }, select: { id: true }, take: 2 })).map(row => row.id));
    const verified = new Set<string>();
    async function* conditions(): AsyncGenerator<Prisma.ImageStudioTaskWhereInput> {
      if (!module) for await (const workspace of pickerRows((after, take) => prisma.imageStudioModule.findMany({ where: { owner_id: user.id, source_preset_id: id, ...pickerSeek(after) }, orderBy: { id: 'asc' }, take, select: { id: true } }))) yield { module_id: workspace.id };
      yield module ? { module_id: id } : { OR: [{ source_preset_id: id }, { snapshot_json: { contains: id } }] };
    }
    let first: PickerTemplate | null = null;
    for await (const condition of conditions()) for await (const task of pickerRows((after, take) => prisma.imageStudioTask.findMany({ where: { AND: [condition, pickerSeek(after)], asset_id: { not: null } }, orderBy: { id: 'asc' }, take, select: { id: true, asset_id: true } }))) {
      const asset = task.asset_id ? await prisma.asset.findUnique({ where: { id: task.asset_id } }) : null;
      if (!asset) continue;
      const candidate = await assetCandidate(asset, false), origin = candidate?.generationOrigin;
      if (origin?.templateId === id && origin.templateName) {
        const option = { id, name: origin.templateName, ...(origin.templateAliases?.length ? { aliases: origin.templateAliases } : {}) } satisfies PickerTemplate;
        first ||= option;
        for (const alias of origin.templateAliases || []) if (wanted.has(alias)) verified.add(alias);
        if (Array.from(wanted).every(alias => verified.has(alias))) return { ...first, aliases: Array.from(new Set([...(first.aliases || []), ...verified])) };
      }
    }
    return first ? { ...first, aliases: Array.from(new Set([...(first.aliases || []), ...verified])) } : null;
  }
  async function* templateDirectory() {
    for await (const preset of pickerRows((after, take) => prisma.imageStudioPreset.findMany({ where: { OR: [{ owner_id: user.id }, { is_shared: true }], AND: [pickerSeek(after)] }, orderBy: { id: 'asc' }, take, select: { id: true } }))) {
      const option = await findTemplate(preset.id, false); if (option) yield option;
    }
    for await (const studioModule of pickerRows((after, take) => prisma.imageStudioModule.findMany({ where: { owner_id: user.id, ...pickerSeek(after) }, orderBy: { id: 'asc' }, take, select: { id: true } }))) {
      if (await prisma.imageStudioPreset.findUnique({ where: { id: studioModule.id }, select: { id: true } })) continue;
      const option = await findTemplate(studioModule.id, true); if (option) yield option;
    }
  }
  const directory = p.get('directory');
  if (requestedTemplate) {
    for await (const task of pickerRows((after, take) => prisma.imageStudioTask.findMany({ where: { module_id: requestedTemplate, asset_id: { not: null }, ...pickerSeek(after) }, orderBy: { id: 'asc' }, take, select: { id: true, asset_id: true } }))) {
      const asset = task.asset_id ? await prisma.asset.findUnique({ where: { id: task.asset_id } }) : null;
      if (!asset) continue;
      const origin = (await assetCandidate(asset, false))?.generationOrigin;
      if (origin?.templateAliases?.includes(requestedTemplate) && origin.templateId) { effectiveTemplate = origin.templateId; break; }
    }
  }
  if (directory) {
    if (!['albums', 'templates'].includes(directory)) throw new PaginationError('目录类型无效');
    const result = directory === 'albums' ? await pickerPage({ scan: albumDirectory, identity: row => `${row.scope}:${row.id}`, fingerprint: pickerFingerprint,
      compare: (a, b) => b.sortAt.localeCompare(a.sortAt) || a.id.localeCompare(b.id) || a.membershipOrder - b.membershipOrder, context: `${context}:albums`, after: p.get('directory_after'), page: 1, limit: size })
      : await pickerPage({ scan: templateDirectory, identity: row => row.id, fingerprint: pickerFingerprint, compare: (a, b) => a.id.localeCompare(b.id),
        context: `${context}:templates`, after: p.get('directory_after'), page: 1, limit: size });
    return { items: [], total: 0, page: 1, hasMore: false, nextCursor: null,
      albums: directory === 'albums' ? (result.items as DirectoryAlbum[]).map(item => ({ id: item.id, name: item.name, scope: item.scope, count: item.count, project: item.project })) : [],
      templates: directory === 'templates' ? result.items : [], directoryPage: { total: result.total, hasMore: result.hasMore, nextCursor: result.nextCursor } };
  }
  const result = await pickerPage({ scan: () => scan(true), identity: item => item.identity,
    fingerprint: item => pickerFingerprint([item.identity, item.createdAt, item.fileName, item.referenceImageId, item.source, item.generationOrigin]),
    compare, context, after: p.get('after'), page, limit: size });
  const items: PickerItem[] = [];
  for (const candidate of result.items) {
    const media = await mediaProjection(user, candidate.mediaRef);
    if (!media || !media.canUse) throw new PaginationError('素材权限已变化，请重新读取', 409);
    const { mediaRef, canonical, download, ...item } = candidate;
    const canDownload = download && media.canDownload;
    item.previewUrl = media.previewUrl || undefined; item.originalUrl = (canDownload ? media.originalUrl : null) || (item.type === 'image' ? '' : media.previewUrl) || '';
    item.thumbnailUrl = media.thumbnailUrl;
    if (!item.unavailableReason && (mediaRef.type === 'video' || assetOnly && (item.referenceImageId || !item.assetId))) item.importUrl = canDownload ? media.originalUrl || undefined : undefined;
    if (p.get('comparison') === '1' && keys.length === 1 && item.type === 'image') {
      const originalVersion = canDownload && canonical ? await comparisonOriginalVersion(canonical) : null;
      item.comparison = { schema: 2, kind: item.referenceImageId ? 'reference_image' : 'asset', id: item.referenceImageId || item.assetId || item.id, originalVersion };
      if (validComparisonVersion(originalVersion) && item.previewUrl) {
        const preview = new URL(item.previewUrl, 'https://picker-projection.invalid');
        // Comparison adds its version selector to the authenticated issuing
        // endpoint. A signed ticket is immutable; the outlet issues it afresh.
        if (preview.origin === 'https://picker-projection.invalid' && preview.pathname.startsWith('/m/') && preview.searchParams.has('ticket')) item.previewUrl = preview.pathname;
      }
    }
    items.push(item);
  }
  return { items, total: result.total, page, hasMore: result.hasMore, nextCursor: result.nextCursor, albums: [], templates: [], directoryDeferred: true,
    ...(result.unavailable ? { notice: `${result.unavailable} 个素材暂不能用于此处，原因显示在对应素材下方；其他素材可正常添加` } : {}) };
}
