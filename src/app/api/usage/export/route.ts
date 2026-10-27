import { route as declaredRoute } from '@/lib/http/route';
import { handleUsageRequest } from '@/lib/usage/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: Request) { return handleUsageRequest(request, undefined, true); });
