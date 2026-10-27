export function sessionCookieName() {
  return process.env.NODE_ENV === 'production' ? '__Host-sd2_session' : 'sd2_session';
}
