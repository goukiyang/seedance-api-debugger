import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { readWork, actOnWork } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, { params }: { params: { workId: string } }) { return roleRoute(request, false, user => readWork(user, params.workId, request.nextUrl.searchParams)); }
export function POST(request: NextRequest, { params }: { params: { workId: string } }) { return roleRoute(request, true, (user, body) => actOnWork(user, params.workId, body)); }
