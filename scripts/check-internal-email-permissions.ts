import assert from 'node:assert/strict';
import { isExternalUser, hasInternalEmailAuthorization } from '../src/lib/access/external-role';
import { isFeatureAllowed } from '../src/lib/access/feature-guard';
import { canUseCompanyTemplates, canManageStudioPreset, canViewStudioPreset } from '../src/lib/image-studio/access';
import { isNavItemVisible, topbarQuickItems, userNavItems, adminNavItems } from '../src/lib/navigation';
import { INTERNAL_EMAIL_FEATURE_PROFILE_ID, normalizeFeatureProfileId, getDefaultFeatureProfileId } from '../src/lib/users/profiles';
import { sessionAccountPayload, sessionAccountPayloadMatches } from '../src/lib/auth/session-account-binding';

const internal = { id: 'authorized-normal', role: 'user', account_type: 'internal', feature_profile_id: INTERNAL_EMAIL_FEATURE_PROFILE_ID };
const external = { ...internal, account_type: 'external' };
const legacy = { ...internal, feature_profile_id: 'standard_internal' };
const feishu = { ...legacy, feishu: { user_id: 'company-member', tenant_key: process.env.FEISHU_ALLOWED_TENANT_KEY || 'company' } };
const preset = { owner_id: 'another-user', scope: 'admin', is_shared: true };
assert.equal(hasInternalEmailAuthorization(internal), true);
assert.equal(isExternalUser(internal), false);
assert.equal(isExternalUser(external), true, 'external classification wins over the marker');
assert.equal(isExternalUser(legacy), true, 'legacy internal labels do not silently gain access');
assert.equal(isExternalUser(feishu), false);
assert.equal(isExternalUser({ ...legacy, role: 'admin' }), false);
assert.equal(normalizeFeatureProfileId(INTERNAL_EMAIL_FEATURE_PROFILE_ID), INTERNAL_EMAIL_FEATURE_PROFILE_ID);
assert.equal(getDefaultFeatureProfileId('external', 'other'), 'external_limited');
assert.equal(getDefaultFeatureProfileId('internal', 'other'), 'standard_internal', 'no automatic internal email grant');
assert.equal(isNavItemVisible({ label: 'protected', href: '/generate', externalHidden: true }, null), false);
for (const key of ['standard_generate', 'ip_generate', 'template_view', 'template_generate', 'ultimate_canvas', 'asset_library', 'task_view', 'reference_album'] as const) {
  assert.equal(isFeatureAllowed(internal, key), isFeatureAllowed(feishu, key), key);
}
assert.equal(isFeatureAllowed(external, 'standard_generate'), false);
assert.equal(isFeatureAllowed(external, 'ip_generate'), true);
assert.equal(canUseCompanyTemplates(internal), true);
assert.equal(canUseCompanyTemplates(external), false);
assert.equal(canUseCompanyTemplates(legacy), false);
assert.equal(canViewStudioPreset(internal, preset), true);
assert.equal(canViewStudioPreset(internal, { ...preset, is_shared: false }), false);
assert.equal(canManageStudioPreset(internal, { ...preset, owner_id: internal.id }), false, 'no template administration');
for (const item of [...topbarQuickItems, ...userNavItems]) {
  assert.equal(isNavItemVisible(item, internal), isNavItemVisible(item, feishu), item.href);
}
for (const item of adminNavItems) assert.equal(isNavItemVisible({ ...item, adminOnly: true }, internal), false);
const sessionUser = { ...internal, password_hash: 'test-hash-not-a-credential' };
assert.equal(sessionAccountPayloadMatches(internal.id, sessionUser), false, 'deleted-account legacy sessions stay invalid');
assert.equal(sessionAccountPayloadMatches(sessionAccountPayload(sessionUser), sessionUser), true);
assert.equal(sessionAccountPayloadMatches(sessionAccountPayload(sessionUser), { ...sessionUser, password_hash: 'changed-test-hash' }), false, 'password reset revokes this account sessions');
assert.equal(sessionAccountPayload({ ...legacy, password_hash: 'test-hash' }), legacy.id, 'other users retain existing sessions');
assert.equal(sessionAccountPayload({ ...feishu, password_hash: 'test-hash' }), feishu.id);
console.log(JSON.stringify({ explicitInternalEmail: true, ordinaryRoleRetained: true, externalAndLegacyDenied: true, navigationMatchesNormalFeishu: true, privateTemplatesProtected: true, oldTargetSessionsRevoked: true, otherSessionsUnchanged: true, noNetworkOrDatabase: true }));
