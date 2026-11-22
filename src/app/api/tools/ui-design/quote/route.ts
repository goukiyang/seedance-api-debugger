import { NextRequest } from 'next/server';
import { uiUser, uiJson, uiFailure } from '@/lib/ui-design/access';
import { quoteUiBatch, requoteUiBatch } from '@/lib/ui-design/generation';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try { const user = await uiUser(request), input = await request.json(); return uiJson(input.action === 'requote' ? await requoteUiBatch(user, input.runId) : await quoteUiBatch(user, input)); } catch (error) { return uiFailure(error); }
}
