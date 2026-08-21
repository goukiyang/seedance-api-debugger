import { AuthError, type SessionUser } from '@/lib/auth/session';
import { isExternalUser, type AccountScopedUser } from '@/lib/access/external-role';

export type FeatureKey =
  | 'standard_generate'
  | 'ip_generate'
  | 'template_view'
  | 'template_generate'
  | 'ultimate_canvas'
  | 'legacy_seedance_assets'
  | 'asset_library'
  | 'reference_album'
  | 'task_view'
  | 'team_project_manage'
  | 'asset_image_generate'
  | 'video_enhance'
  | 'task_retry'
  | 'public_signed_callback';

const EXTERNAL_ALLOWED_FEATURES = new Set<FeatureKey>([
  'ip_generate',
  'asset_library',
  'reference_album',
  'task_view',
]);

export function isFeatureAllowed(user: AccountScopedUser | null | undefined, feature: FeatureKey) {
  if (!isExternalUser(user)) return true;
  return EXTERNAL_ALLOWED_FEATURES.has(feature);
}

export function assertFeatureAllowed(
  user: SessionUser,
  feature: FeatureKey,
  message = '外部账号无权使用此功能',
) {
  if (!isFeatureAllowed(user, feature)) {
    throw new AuthError(message, 403);
  }
}

export function assertInternalOnly(user: SessionUser, message = '外部账号无权使用此功能') {
  if (isExternalUser(user)) {
    throw new AuthError(message, 403);
  }
}
