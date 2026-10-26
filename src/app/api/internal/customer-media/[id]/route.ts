import { apiError } from '@/lib/customer-api/auth';
import { resolveProviderMedia } from '@/lib/customer-api/input-assets';
import { privateFileResponse } from '@/lib/customer-api/file-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function serve(request: Request, { params }: { params: { id: string } }) {
  try { const media = await resolveProviderMedia(request, params.id); return await privateFileResponse(request, media.file, media.bytes, media.mime); }
  catch (error) { return apiError(error); }
}
export const GET = serve;
export const HEAD = serve;
