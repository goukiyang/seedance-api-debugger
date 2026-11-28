/** The compatible rollback build sets this false and keeps all readers. */
export const CHARACTER_FUSION_WRITES_ENABLED: boolean = false;
export function assertCharacterFusionWritesEnabled() {
  if (!CHARACTER_FUSION_WRITES_ENABLED) throw Object.assign(new Error('角色融合正在维护，请保留草稿，稍后再试。'), { status: 503, code: 'FUSION_WRITES_DISABLED' });
}
