import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseWorksPreview } from '@/lib/works/rollout.server';

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ user: null });
  return NextResponse.json({ user: { ...user, works_preview: canUseWorksPreview(user) } });
}
