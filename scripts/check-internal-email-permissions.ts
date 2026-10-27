import assert from 'node:assert/strict';
import { isExternalUser, hasInternalEmailAuthorization } from '../src/lib/access/external-role';
import { isFeatureAllowed } from '../src/lib/access/feature-guard';
import { canUseCompanyTemplates, canManageStudioPreset, canViewStudioPreset } from '../src/lib/image-studio/access';
import { isNavItemVisible, topbarQuickItems, userNavItems, adminNavItems } from '../src/lib/navigation';
import { INTERNAL_EMAIL_FEATURE_PROFILE_ID, normalizeFeatureProfileId, getDefaultFeatureProfileId } from '../src/lib/users/profiles';
import { hashPassword, verifyPassword } from '../src/lib/auth/password';

const internal = { id: 'authorized-normal', role: 'user', account_type: 'internal', feature_profile_id: INTERNAL_EMAIL_FEATURE_PROFILE_ID };
const external = { ...internal, account_type: 'external' };
const legacy = { ...internal, feature_profile_id: 'standard_internal' };
const feishu = { ...legacy, feishu: { user_id: 'company-member', tenant_key: process.env.FEISHU_ALLOWED_TENANT_KEY || 'company' } };
const preset = { owner_id: 'another-user', scope: 'admin', is_shared: true };
assert.equal(hasInternalEmailAuthorization(internal), true);
assert.equal(isExternalUser(internal), false);
assert.equal(isExternalUser(external), true);
assert.equal(isExternalUser(legacy), true);
assert.equal(isExternalUser(feishu), false);
assert.equal(isExternalUser({ ...legacy, role: 'admin' }), false);
assert.equal(normalizeFeatureProfileId(INTERNAL_EMAIL_FEATURE_PROFILE_ID), INTERNAL_EMAIL_FEATURE_PROFILE_ID);
assert.equal(getDefaultFeatureProfileId('external', 'other'), 'external_limited');
assert.equal(getDefaultFeatureProfileId('internal', 'other'), 'standard_internal');
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
assert.equal(canManageStudioPreset(internal, { ...preset, owner_id: internal.id }), false);
for (const item of [...topbarQuickItems, ...userNavItems]) assert.equal(isNavItemVisible(item, internal), isNavItemVisible(item, feishu), item.href);
for (const item of adminNavItems) assert.equal(isNavItemVisible({ ...item, adminOnly: true }, internal), false);

const password = 'offline-generated-fixture-only';
// Session revocation now lives in the real SQLite contracts in test-audit-auth.ts.
async function checkPassword() {
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password + '-wrong', hash), false);
  assert.equal(await verifyPassword(password, hash + ':legacy-binding'), true, 'old password envelope remains readable');
  assert.equal(await verifyPassword(password, hash + ':legacy-binding:invalid'), false);
  console.log(JSON.stringify({ ordinaryInternalEmail: true, defaultExternalAndLegacyDenied: true,
    navigationAndPrivateTemplates: true, asynchronousPasswordVerification: true, noNetworkOrDatabase: true }));
}
void checkPassword().catch(error => { console.error(error); process.exitCode = 1; });
