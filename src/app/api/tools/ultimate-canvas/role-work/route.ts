import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { listWorks } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest) { return roleRoute(request, false, user => listWorks(user, request.nextUrl.searchParams)); }
