export const ROLE_COLLABORATION_READ_ONLY = true;

export function isRoleCollaborationReadOnly() {
  return ROLE_COLLABORATION_READ_ONLY || process.env.CANVAS_ROLE_COLLABORATION_GUARD === '1';
}
