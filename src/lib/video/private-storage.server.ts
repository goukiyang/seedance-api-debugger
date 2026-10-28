import 'server-only';
import { privateOrigin } from '@/lib/security/private-prompts.server';
import { readPrivateFields, writePrivateFields } from '@/lib/security/private-prompt-fields.server';
import { MULTIVIEW_ROTATION_PRESET } from './multiview-generation-contract';

export function privateMultiviewOrigins() {
  const origin = privateOrigin('multiview-preset', MULTIVIEW_ROTATION_PRESET.id);
  return origin ? [origin] : [];
}

export function privateMultiviewActionOrigins() {
  const origin = privateOrigin('multiview-action-sync', 'multiview_action_sync_v1');
  return origin ? [origin] : [];
}

export function transformPrivateVideoText<T extends { id: string }>(kind: 'video-task' | 'video-generation-snapshot',
  row: T, fields: string[], write: boolean, multiview: boolean | 'multiview-action'): T {
  const origins = multiview === 'multiview-action' ? privateMultiviewActionOrigins() : multiview ? privateMultiviewOrigins() : [];
  const operation = write ? writePrivateFields : readPrivateFields;
  return operation(row, kind, row.id, fields.filter(field => typeof (row as Record<string, unknown>)[field] === 'string')
    .map(field => ({ field, origins })));
}
