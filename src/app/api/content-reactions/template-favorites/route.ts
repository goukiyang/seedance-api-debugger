import { reactionError, reactionJson, reactionUser } from '@/lib/content-reactions/http';
import { changeTemplateFavorites, getTemplateFavoriteOrganization } from '@/lib/content-reactions/template-favorites';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { return reactionJson({ organization: await getTemplateFavoriteOrganization(await reactionUser()) }); }
  catch (error) { return reactionError(error); }
}

export async function PUT(request: Request) {
  try { return reactionJson(await changeTemplateFavorites(await reactionUser(request), await request.json())); }
  catch (error) { return reactionError(error); }
}
