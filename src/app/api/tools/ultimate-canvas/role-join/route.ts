import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { joinRole } from '@/lib/canvas-roles/join';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest) { return roleRoute(request, true, joinRole); }
