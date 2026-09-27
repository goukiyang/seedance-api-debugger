import { NextRequest } from 'next/server';
import { withAnimationAuth } from '@/lib/animation/http';
import { handleAnimationImportRequest } from '@/lib/animation/request-handlers';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function POST(request: NextRequest) {
  return withAnimationAuth(request, true, (user) => handleAnimationImportRequest(request, user));
}
