import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { roleReceipt } from '@/lib/canvas-roles/repository';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, { params }: { params: { mutationId: string } }) { return roleRoute(request, false, user => roleReceipt(user, params.mutationId)); }
