'use strict';
function assertStartupAuthPolicy() {
  if (process.env.NODE_ENV !== 'production') return;
  if (!process.env.FEISHU_ALLOWED_TENANT_KEY?.trim()) {
    throw new Error('AUTH_CONFIGURATION_INVALID:allowed-tenant');
  }
  if (process.env.SELF_REGISTRATION_ENABLED !== 'false') {
    if (process.env.REGISTER_EMAIL_VERIFICATION !== 'true'
      || !process.env.RESEND_API_KEY?.trim()
      || !(process.env.AUTH_EMAIL_FROM || process.env.EMAIL_FROM)?.trim()) {
      throw new Error('AUTH_CONFIGURATION_INVALID:verified-registration-or-closed');
    }
  }
}
module.exports = { assertStartupAuthPolicy };
