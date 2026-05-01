/**
 * POST /api/workspace/validate
 * 验证 prompt 中引用的图号是否存在
 *
 * body: { prompt, workspaceId? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences } from '@/lib/assets/collection';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt } = body;

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt required' }, { status: 400 });
    }

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId);

    const result = await validatePromptReferences(prompt, workspaceId);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[ValidatePrompt] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    );
  }
}
