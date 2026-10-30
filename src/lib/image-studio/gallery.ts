import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { readSharedStudioSnapshot } from './read-snapshot';
import { createGalleryReadContext, type GalleryPageSelection } from './gallery-context';
import { assertStudioActor, getStudioRemovedDefaultGroups, sharedStudioAvailability, studioSharedBinding, studioPublisherModule, StudioSharingError } from './shared-contract';
import { canManageStudioPreset, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { resolveStudioTemplateAuthor } from './template-author';
import { studioFixedCoverDTO } from './module-cover';
import { studioVisibleAssetWhere } from './protected-assets';
import { studioAssetUrl, studioTemplateAssetUrl } from './media';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from './dimension-mismatch';
import { studioPresetArchived } from './preset-lifecycle';
import { listStudioDeletedSources, readStudioDeletedSource, readStudioWorkspaceDeletion, studioSourceDeletionCapability, studioWorkspaceDeletionCapability } from './workspace-deletion';
import type { GalleryAuthor, GalleryItem, GalleryNavigationItem, GalleryQuery, GalleryQueryResult, GalleryReactionKey } from './gallery-types';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = (value: string | null) => value ? Date.parse(value) || 0 : 0;
const knownKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(value);

export function parseGalleryQuery(value: unknown): GalleryQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioSharingError('封面查询格式无效', 400);
  const input = value as GalleryQuery;
  if (input.protocol !== undefined && input.protocol !== 'catalog-paged-v2'
    || input.navigationPage !== undefined && (!Number.isSafeInteger(input.navigationPage) || input.navigationPage < 1)
    || input.locate !== undefined && (!input.locate || typeof input.locate !== 'object' || Array.isArray(input.locate)
      || Object.keys(input.locate).some(key => !['moduleId', 'presetId'].includes(key))
      || Object.values(input.locate).some(id => typeof id !== 'string' || id.length > 180 || !/^[a-zA-Z0-9:_-]+$/.test(id)))
    || input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 160)
    || input.navigationOnly !== undefined && typeof input.navigationOnly !== 'boolean'
    || input.scope !== undefined && !['all', 'mine', 'shared', 'favorites'].includes(input.scope)
    || input.sort !== undefined && !['created', 'updated', 'likes', 'recent', 'name', 'directory'].includes(input.sort)
    || input.authorKey != null && !knownKey(input.authorKey)
    || input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1)
    || input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 12 || input.pageSize > 24)
    || input.catalogRevision !== undefined && (typeof input.catalogRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.catalogRevision))) {
    throw new StudioSharingError('封面查询条件无效', 400);
  }
  if (input.recentHints !== undefined && (!input.recentHints || typeof input.recentHints !== 'object' || Array.isArray(input.recentHints)
    || Object.keys(input.recentHints).length > 1000 || Object.entries(input.recentHints).some(([key, stamp]) => !knownKey(key)
      || !Number.isSafeInteger(stamp) || stamp <= 0 || stamp > Date.now()))) throw new StudioSharingError('最近使用记录无效', 400);
  if (input.directoryOrder !== undefined && (!input.directoryOrder || typeof input.directoryOrder !== 'object'
    || Buffer.byteLength(JSON.stringify(input.directoryOrder)) > 256 * 1024
    || ['groups', 'entries'].some(field => {
      const rows = input.directoryOrder![field as 'groups' | 'entries'];
      return rows !== undefined && (!Array.isArray(rows) || rows.some(row => typeof row !== 'string' || row.length > 200));
    }))) throw new StudioSharingError('目录顺序超限或无效', 400);
  return input;
}

export async function readGalleryCatalog(user: ImageStudioIdentity, tx: Prisma.TransactionClient, selection?: GalleryPageSelection) {
  const actor = await assertStudioActor(user.id, tx);
  const context = await createGalleryReadContext(tx, actor.id, selection), client = context.client;
  const deletedRows = selection ? (await Promise.all(context.sources.map(row => readStudioDeletedSource(actor.id, row.id, client)))).filter(row => row !== null)
    : await listStudioDeletedSources(actor.id, client);
  const deleted = new Set(deletedRows.filter(row => !row.reopenedModuleId).map(row => row.presetId));
  const available = new Map<string, boolean>();
  for (const source of context.sources) available.set(source.id, await sharedStudioAvailability(actor, source, client));
  const author = async (target: { presetId?: string; moduleId?: string }): Promise<GalleryAuthor> => {
    const resolved = await resolveStudioTemplateAuthor(actor, target, client);
    const value = resolved.templateRead.author;
    return value.state === 'known' && resolved.owner ? { known: true, key: `author:${digest(resolved.owner.id)}`,
      displayName: value.displayName || '作者未知', avatarUrl: value.avatarUrl }
      : { known: false, key: null, displayName: '作者未知', avatarUrl: null };
  };
  const entries = new Map<string, GalleryNavigationItem>();
  const targets = new Map<string, { kind: 'module' | 'preset'; id: string }>();
  const sourceById = new Map(context.sources.map(source => [source.id, source]));
  for (const row of context.modules) {
    if (await readStudioWorkspaceDeletion(actor.id, row.id, client)) continue;
    let binding: Awaited<ReturnType<typeof studioSharedBinding>> = null, bindingInvalid = false;
    try {
      binding = await studioSharedBinding(actor.id, row.id, client);
      if (binding && (binding.presetId !== row.source_preset_id || binding.mode === 'publisher'
        && await studioPublisherModule(actor.id, binding.presetId, client) !== row.id)) { binding = null; bindingInvalid = true; }
    } catch (error) {
      if (!(error instanceof StudioSharingError) || error.status !== 409) throw error;
      bindingInvalid = true;
    }
    const source = row.source_preset_id ? sourceById.get(row.source_preset_id) : null;
    const sourceVisible = Boolean(source && canViewStudioPreset(actor, source) && !await studioPresetArchived(source.id, client));
    const usable = !bindingInvalid && (!row.source_preset_id || sourceVisible && available.get(row.source_preset_id) === true);
    const merged = Boolean(binding && source && binding.presetId === source.id);
    const key = merged ? `image_template:${binding!.presetId}` : `image_module:${row.id}`;
    const item: GalleryNavigationItem = { key, id: row.id, title: merged && sourceVisible ? source!.name : row.name, name: merged && sourceVisible ? source!.name : row.name,
      groupName: (merged && sourceVisible ? source!.group_name : row.group_name) || '未分组', mine: merged ? source!.owner_id === actor.id : true,
      shared: merged && sourceVisible && source!.is_shared, navigationTarget: { moduleId: row.id }, ...(merged ? { presetId: binding!.presetId } : {}),
      sourcePresetId: row.source_preset_id, sourcePresetShared: sourceVisible ? source!.is_shared : row.source_preset_id ? null : false,
      objectKind: binding ? binding.mode : row.source_preset_id ? 'legacy-copy' : 'local',
      author: bindingInvalid || row.source_preset_id && !sourceVisible ? { known: false, key: null, displayName: '作者未知', avatarUrl: null }
        : await author(merged ? { presetId: binding!.presetId } : { moduleId: row.id }),
      createdAt: merged ? sourceVisible ? source!.created_at?.toISOString() || null : null : row.created_at?.toISOString() || null,
      updatedAt: merged ? sourceVisible ? source!.updated_at.toISOString() : null : row.updated_at?.toISOString() || null, available: usable,
      reaction: null, coverEditable: !bindingInvalid && (!row.source_preset_id || sourceVisible)
        && (!merged || binding!.mode === 'publisher' && canManageStudioPreset(actor, source!)),
      deletion: studioWorkspaceDeletionCapability(actor.id, row.id, row.revision) };
    entries.set(key, item); targets.set(key, { kind: 'module', id: row.id });
  }
  for (const source of context.sources) {
    const key = `image_template:${source.id}`;
    if (entries.has(key) || selection && !selection.presetIds.includes(source.id) || !source.is_shared || !available.get(source.id) || deleted.has(source.id)) continue;
    entries.set(key, { key, id: `shared:${source.id}`, title: source.name, name: source.name, groupName: source.group_name || '未分组',
      mine: source.owner_id === actor.id, shared: true, presetId: source.id, navigationTarget: { presetId: source.id },
      author: await author({ presetId: source.id }), createdAt: source.created_at?.toISOString() || null, updatedAt: source.updated_at.toISOString(),
      available: true, reaction: null, coverEditable: canManageStudioPreset(actor, source), deletion: studioSourceDeletionCapability(actor, source) });
    targets.set(key, { kind: 'preset', id: source.id });
  }
  const keys = Array.from(entries.keys());
  const own = await tx.contentReaction.findMany({ where: { user_id: actor.id, content_key: { in: keys } } });
  const counts = await tx.contentReaction.groupBy({ by: ['content_key'], where: { content_key: { in: keys }, liked: true }, _count: { _all: true } });
  const ownByKey = new Map(own.map(row => [row.content_key, row])), countByKey = new Map(counts.map(row => [row.content_key, row._count._all]));
  for (const entry of Array.from(entries.values())) {
    const row = ownByKey.get(entry.key);
    entry.reaction = { key: entry.key as GalleryReactionKey, liked: row?.liked || false, favorited: row?.favorited || false,
      version: row?.version || 0, available: entry.available, likeCount: entry.available ? countByKey.get(entry.key) || 0 : null };
  }
  const defaultId = `default-${actor.id}`;
  if ((!selection || selection.moduleIds.includes(defaultId)) && !context.modules.some(row => row.id === defaultId) && !await readStudioWorkspaceDeletion(actor.id, defaultId, client)) {
    entries.set(`image_module:${defaultId}`, { key: `image_module:${defaultId}`, id: defaultId, name: '默认模块', title: '默认模块',
      groupName: '常用', mine: true, shared: false, navigationTarget: { moduleId: defaultId },
      author: { known: false, key: null, displayName: '作者未知', avatarUrl: null }, createdAt: null, updatedAt: null,
      available: true, reaction: null, coverEditable: false, deletion: studioWorkspaceDeletionCapability(actor.id, defaultId, 0, false) });
  }
  return { ...context, actor, entries: Array.from(entries.values()).sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId)), targets, sourceById, deletedRows };
}

export async function queryStudioGallery(user: ImageStudioIdentity, raw: unknown, projection?: { tx: Prisma.TransactionClient; selection: GalleryPageSelection }): Promise<GalleryQueryResult> {
  const input = parseGalleryQuery(raw);
  const read = async (tx: Prisma.TransactionClient): Promise<GalleryQueryResult> => {
    const catalog = await readGalleryCatalog(user, tx, projection?.selection), entries = catalog.entries;
    const recent = input.recentHints || {}, directory = input.directoryOrder || {};
    const orderIndex = (entry: GalleryNavigationItem) => {
      const legacy = entry.presetId ? `preset:${entry.presetId}` : `module:${entry.id}`;
      const index = directory.entries?.findIndex(key => [entry.key, entry.id, legacy].includes(key)) ?? -1;
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const groupIndex = (entry: GalleryNavigationItem) => { const index = directory.groups?.indexOf(entry.groupName) ?? -1; return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    const natural = new Map(entries.map((entry, index) => [entry.key, index]));
    const directoryCompare = (a: GalleryNavigationItem, b: GalleryNavigationItem) => groupIndex(a) - groupIndex(b) || orderIndex(a) - orderIndex(b) || natural.get(a.key)! - natural.get(b.key)!;
    const recentTime = (entry: GalleryNavigationItem) => Math.max(recent[entry.key] || 0,
      recent[entry.presetId ? `preset:${entry.presetId}` : `module:${entry.id}`] || 0);
    const revision = digest([catalog.actor.id, catalog.actor.role, catalog.actor.account_type, catalog.actor.feature_profile_id,
      entries, catalog.dependency, catalog.settings.filter(row => /archived|binding|publisher|deleted/.test(row.key)),
      input.query || '', input.scope || 'all', input.authorKey || null, input.sort || 'created', recent, directory]);
    if (input.catalogRevision && input.catalogRevision !== revision) throw new StudioSharingError('封面目录已变化，请重新读取', 409, 'state-conflict');
    const search = input.query?.trim().toLocaleLowerCase() || '';
    const matches = entries.filter(entry => (!input.scope || input.scope === 'all' || input.scope === 'mine' && entry.mine
      || input.scope === 'shared' && entry.shared || input.scope === 'favorites' && entry.reaction?.favorited === true)
      && (!input.authorKey || entry.author.known && entry.author.key === input.authorKey)
      && (!search || [entry.name, entry.groupName, entry.author.known ? entry.author.displayName : ''].some(text => text.toLocaleLowerCase().includes(search))));
    const sort = input.sort || 'created';
    matches.sort((a, b) => (sort === 'created' ? time(b.createdAt) - time(a.createdAt) || directoryCompare(a, b)
      : sort === 'updated' ? time(b.updatedAt) - time(a.updatedAt) || directoryCompare(a, b)
      : sort === 'likes' ? (b.reaction?.likeCount ?? -1) - (a.reaction?.likeCount ?? -1) || time(b.createdAt) - time(a.createdAt)
      : sort === 'recent' ? recentTime(b) - recentTime(a) || directoryCompare(a, b)
      : sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : directoryCompare(a, b)) || a.key.localeCompare(b.key));
    const pageSize = input.pageSize || 12, page = Math.min(input.page || 1, Math.max(1, Math.ceil(matches.length / pageSize)));
    const items: GalleryItem[] = [];
    for (const entry of input.navigationOnly ? [] : matches.slice((page - 1) * pageSize, page * pageSize)) {
      const target = catalog.targets.get(entry.key);
      let fixedCover: GalleryItem['fixedCover'] = null, banner: GalleryItem['banner'] = null;
      let cover: GalleryItem['cover'] = null;
      if (entry.available && target) {
        fixedCover = await studioFixedCoverDTO(catalog.actor, target, catalog.client);
        const row = target.kind === 'module' ? catalog.modules.find(row => row.id === target.id) : catalog.sourceById.get(target.id);
        if (!fixedCover && row?.banner_asset_id) {
          const asset = await tx.asset.findFirst({ where: { id: row.banner_asset_id, owner_id: row.owner_id, status: 'active', type: 'image',
            AND: [await studioVisibleAssetWhere(catalog.actor, catalog.client, [row.banner_asset_id])] }, select: { id: true, width: true, height: true } });
          if (asset) banner = { id: asset.id, thumbnailUrl: studioTemplateAssetUrl(asset.id, true), originalUrl: studioTemplateAssetUrl(asset.id), width: asset.width, height: asset.height };
        }
        if (!fixedCover && target.kind === 'module' && !target.id.startsWith('default-')) {
          const task = await tx.imageStudioTask.findFirst({ where: { owner_id: catalog.actor.id, module_id: target.id,
            AND: [studioOutputTaskWhere], deleted_at: null, asset_id: { not: null } }, orderBy: { finished_at: 'desc' },
            select: { asset_id: true, snapshot_json: true, status: true, usage_json: true } });
          if (task?.asset_id && studioTaskHasViewableOutput(task)) {
            const asset = await tx.asset.findFirst({ where: { id: task.asset_id, owner_id: catalog.actor.id, status: 'active', type: 'image',
              AND: [await studioVisibleAssetWhere(catalog.actor, catalog.client, [task.asset_id])] }, select: { id: true } });
            if (asset) cover = { resultUrl: studioAssetUrl(asset.id), thumbnailUrl: studioAssetUrl(asset.id, true) };
          }
        }
      }
      items.push({ ...entry, fixedCover, banner, cover, originalActions: { open: true, editCover: entry.coverEditable, deletion: entry.deletion } });
    }
    return { items, navigation: entries, matches, total: matches.length, page, pageSize, catalogRevision: revision, capabilities: { independentReactions: true },
      removedDefaultGroups: await getStudioRemovedDefaultGroups(catalog.actor.id, catalog.client),
      deletedSourcePresetIds: catalog.deletedRows.filter(row => !row.reopenedModuleId).map(row => row.presetId) };
  };
  return projection ? read(projection.tx) : readSharedStudioSnapshot(read, 'gallery');
}
