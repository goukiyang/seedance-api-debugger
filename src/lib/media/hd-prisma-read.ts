import { readonlyDatabase as db } from '../database/client';
import { assertDatabaseWriterMode } from '../database/process-mode';
import { studioOutputTaskWhere } from '../image-studio/dimension-mismatch';
import { hdReadLimit, hdReadUrls, hdReadWindow, type HdReadRepository } from './hd-read-repository';
const assetSelect = { id: true, owner_id: true, original_url: true, metadata_json: true, status: true, type: true } as const;
const datedAssetSelect = { ...assetSelect, created_at: true } as const;
const referenceSelect = { id: true, owner_user_id: true, url: true, status: true, asset_id: true, album: { select: { status: true } } } as const;
export function sharedPrismaHdRepository(): HdReadRepository {
  assertDatabaseWriterMode();
  return {
    assetById: id => db.asset.findUnique({ where: { id }, select: assetSelect }),
    referenceById: id => db.referenceImage.findUnique({ where: { id }, select: referenceSelect }),
    assetsAtUrls: urls => db.asset.findMany({ where: { original_url: { in: hdReadUrls(urls) } }, take: 2, select: assetSelect }),
    referencesAtUrls: urls => db.referenceImage.findMany({ where: { url: { in: hdReadUrls(urls) } }, take: 2, select: referenceSelect }),
    nextAssets: (cursor, captured, take) => {
      hdReadWindow(cursor, captured);
      return db.asset.findMany({ where: { status: 'active', type: 'image', created_at: { lte: captured },
        OR: [{ created_at: { gt: new Date(cursor.at) } }, { created_at: new Date(cursor.at), id: { gt: cursor.id } }] },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: hdReadLimit(take), select: datedAssetSelect });
    },
    nextTasks: (cursor, captured, take) => {
      hdReadWindow(cursor, captured);
      return db.imageStudioTask.findMany({ where: { AND: [studioOutputTaskWhere,
        { deleted_at: null, asset_id: { not: null }, finished_at: { lte: captured },
          OR: [{ finished_at: { gt: new Date(cursor.at) } }, { finished_at: new Date(cursor.at), id: { gt: cursor.id } }] }] },
      orderBy: [{ finished_at: 'asc' }, { id: 'asc' }], take: hdReadLimit(take),
      select: { id: true, owner_id: true, status: true, usage_json: true, finished_at: true, asset_id: true } });
    },
    taskAsset: (id, ownerId) => db.asset.findFirst({ where: { id, owner_id: ownerId, status: 'active', type: 'image' }, select: assetSelect }),
    countActiveImageAssets: () => db.asset.count({ where: { status: 'active', type: 'image' } }),
    inventoryAssets: async () => {
      const owners = await db.user.findMany({ where: { status: 'active' }, select: { id: true } });
      return db.asset.findMany({ where: { status: 'active', type: 'image', owner_id: { in: owners.map(owner => owner.id) } },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }], select: datedAssetSelect });
    },
    inventoryReferences: () => db.referenceImage.findMany({ where: { status: 'active', asset_id: null, owner: { status: 'active' }, album: { status: 'active' } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }], select: referenceSelect }),
    close: () => db.$disconnect(),
  };
}
