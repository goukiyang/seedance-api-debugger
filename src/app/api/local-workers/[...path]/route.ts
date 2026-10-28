import { localImageHandler } from '@/lib/local-images/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, { params }: { params: { path: string[] } }) { return localImageHandler(request, params.path, 'worker'); }
export function PUT(request: Request, { params }: { params: { path: string[] } }) { return localImageHandler(request, params.path, 'worker'); }
