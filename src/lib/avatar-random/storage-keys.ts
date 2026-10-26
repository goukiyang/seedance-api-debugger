import { isAvatarSheet } from './layout';
import type { AvatarPlan, AvatarRecord } from './types';

export const avatarKey = (owner: string, kind: string, id: string) => `avatar:v1:${owner}:${kind}:${id}`;
// Sheet IDs remain in the isolated partition even when a saved config is edited.
export function avatarPlanKey(owner: string, plan: Pick<AvatarPlan, 'id' | 'layout'>) { return avatarKey(owner, isAvatarSheet(plan)||plan.id.startsWith('sheet-')?'sheet-plan':'plan',plan.id); }
export function avatarRecordKey(owner: string, record: Pick<AvatarRecord, 'id' | 'layout' | 'rules'>) { return avatarKey(owner,record.id.startsWith('sheet-')||isAvatarSheet(record)||isAvatarSheet(record.rules || {})?'sheet-record':'record',record.id); }
export function avatarReadKeys(owner: string, kind: string, id: string) {
  return kind==='plan'||kind==='record' ? [avatarKey(owner,`sheet-${kind}`,id),avatarKey(owner,kind,id)] : [avatarKey(owner,kind,id)];
}
