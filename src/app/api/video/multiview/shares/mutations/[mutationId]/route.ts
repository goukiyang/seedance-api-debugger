import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { readMultiviewShareOperation, resumeMultiviewShareOperation } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest, { params }: { params: { mutationId: string } }) { return multiviewWorkRoute(request, false, user => readMultiviewShareOperation(user, params.mutationId)); }
export function POST(request: NextRequest, { params }: { params: { mutationId: string } }) { return multiviewWorkRoute(request, true, user => resumeMultiviewShareOperation(user, params.mutationId)); }
