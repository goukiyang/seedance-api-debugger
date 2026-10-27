import type { SessionUser } from '@/lib/auth/session';
import type { LocalAssetRecord } from '@/lib/provider/seedance-assets-types';
import { mediaProjection } from './outlet';

export async function seedanceMediaDTO(user: SessionUser, record: LocalAssetRecord) {
  const known = record.ownershipStatus === 'owned' && Boolean(record.ownerId);
  const media = known ? await mediaProjection(user, { type: 'seedance', id: record.localId }) : null;
  return { localId: record.localId, provider: record.provider, providerAssetId: record.providerAssetId,
    assetType: record.assetType, name: record.name, status: record.status, providerStatus: record.providerStatus,
    originalUrl: media?.originalUrl || '', providerPreviewUrl: media?.previewUrl || '',
    ownerId: record.ownerId || null, ownershipStatus: known ? 'owned' : 'quarantined',
    canMutate: known && (record.ownerId === user.id || user.role === 'admin' && user.account_type === 'internal'),
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}
