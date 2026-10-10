import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createRole, listRoles } from '@/lib/canvas-roles/repository';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest) { return roleRoute(request, false, user => listRoles(user, request.nextUrl.searchParams)); }
export function POST(request: NextRequest) { return roleRoute(request, true, createRole); }
