import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { readMultiviewShare } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest, { params }: { params: { shareId: string } }) { return multiviewWorkRoute(request, false, async user => ({ share: await readMultiviewShare(user, params.shareId) })); }
