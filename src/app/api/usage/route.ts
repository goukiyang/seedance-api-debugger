import { handleUsageRequest } from '@/lib/usage/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) { return handleUsageRequest(request); }
