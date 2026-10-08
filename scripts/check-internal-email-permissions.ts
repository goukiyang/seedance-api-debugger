import assert from 'node:assert/strict';
import { isExternalUser, hasInternalEmailAuthorization } from '../src/lib/access/external-role';
import { isFeatureAllowed } from '../src/lib/access/feature-guard';
import { canUseCompanyTemplates, canManageStudioPreset, canViewStudioPreset } from '../src/lib/image-studio/access';
import { isNavItemVisible, topbarQuickItems, userNavItems, adminNavItems } from '../src/lib/navigation';
import { INTERNAL_EMAIL_FEATURE_PROFILE_ID, normalizeFeatureProfileId, getDefaultFeatureProfileId } from '../src/lib/users/profiles';
import { maintainAccountSessionBinding, sessionAccountPayload, sessionAccountPayloadMatches, type SessionAccount } from '../src/lib/auth/session-account-binding';
import { hashPassword, verifyPassword, hasSessionPasswordBinding } from '../src/lib/auth/password';

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

const secret = 'offline-fixture-only';
const password = 'offline-generated-fixture-only';
const before: SessionAccount = { ...legacy, status: 'active', user_profile: 'other', expires_at: null, password_hash: hashPassword(password) };
const granted = { ...before, ...internal };
granted.password_hash = maintainAccountSessionBinding(before, granted);
assert.ok(hasSessionPasswordBinding(granted.password_hash));
assert.ok(verifyPassword(password, granted.password_hash), 'grant without plaintext retains the password');
const grantedCookie = sessionAccountPayload(granted, secret);
assert.equal(sessionAccountPayloadMatches(before.id, granted, secret), false);
assert.equal(sessionAccountPayloadMatches(grantedCookie, granted, secret), true);
const reset = { ...granted, password_hash: maintainAccountSessionBinding(granted, granted, hashPassword(password + '-changed')) };
assert.equal(sessionAccountPayloadMatches(grantedCookie, reset, secret), false);
assert.ok(verifyPassword(password + '-changed', reset.password_hash));
for (const change of [
  { account_type: 'external', feature_profile_id: 'external_limited' },
  { feature_profile_id: null },
  { feature_profile_id: 'standard_internal', user_profile: 'viewer' },
  { status: 'deleted' },
  { status: 'disabled' },
]) {
  const withdrawn = { ...reset, ...change };
  withdrawn.password_hash = maintainAccountSessionBinding(reset, withdrawn);
  assert.ok(hasSessionPasswordBinding(withdrawn.password_hash));
  assert.equal(sessionAccountPayloadMatches(before.id, withdrawn, secret), false, 'never reaccept pre-grant cookie');
  assert.equal(sessionAccountPayloadMatches(sessionAccountPayload(reset, secret), withdrawn, secret), false);
  const restored = { ...withdrawn, ...internal, status: 'active', user_profile: 'other' };
  restored.password_hash = maintainAccountSessionBinding(withdrawn, restored);
  assert.equal(sessionAccountPayloadMatches(grantedCookie, restored, secret), false);
  assert.equal(sessionAccountPayloadMatches(sessionAccountPayload(reset, secret), restored, secret), false);
  assert.equal(sessionAccountPayloadMatches(sessionAccountPayload(restored, secret), restored, secret), true);
}
assert.equal(maintainAccountSessionBinding(granted, granted), granted.password_hash, 'no-op does not revoke');
assert.equal(sessionAccountPayload({ ...before, ...feishu }, secret), before.id);
assert.equal(maintainAccountSessionBinding(before, { ...before, account_type: 'external' }), before.password_hash);
assert.equal(sessionAccountPayloadMatches(before.id, before, secret), true);
assert.equal(verifyPassword(password, granted.password_hash + ':unknown'), false);
console.log(JSON.stringify({ ordinaryInternalEmail: true, defaultExternalAndLegacyDenied: true, navigationAndPrivateTemplates: true,
  lifecycle: 'grant/password/type/profile/delete/disable/restore', legacyCookieNeverRevived: true, otherSessionsUnchanged: true,
  noNetworkOrDatabase: true }));
