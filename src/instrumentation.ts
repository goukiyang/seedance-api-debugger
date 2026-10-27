export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NODE_ENV === 'production') {
      require('./lib/security/secrets.cjs').assertStartupSecrets();
    }
    require('./lib/media/image-decoder-policy.cjs');
  }
}
