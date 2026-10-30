import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { PRIVATE_IDENTITY_COOKIE } from '@/lib/security/private-prompt-identity.server';

const COOKIE_NAME = 'session';

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
  cookieStore.delete(PRIVATE_IDENTITY_COOKIE);
  return NextResponse.json({ ok: true });
}