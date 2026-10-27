import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createRole, listRoles } from '@/lib/canvas-roles/repository';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, function GET(request: NextRequest) { return roleRoute(request, false, user => listRoles(user, request.nextUrl.searchParams)); });
export const POST = declaredRoute({ access: 'internal', rateLimit: false }, function POST(request: NextRequest) { return roleRoute(request, true, createRole); });
