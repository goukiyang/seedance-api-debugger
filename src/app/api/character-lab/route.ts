import { NextRequest, NextResponse } from 'next/server';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { StudioError } from '@/lib/image-studio/tasks';
import { requireLabUser, labFailure, labPrivateHeaders } from '@/lib/character-lab/http';
import { createLabWorkspace, labConfigVersions, labId, saveLabConfig, updateLabWorkspace } from '@/lib/character-lab/store';
import { labBootstrapFor, labPlanState, labWorkspaceState, prepareLab, quoteLab, saveLabResult, submitLab } from '@/lib/character-lab/service';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const user = await requireLabUser();
    const workspace = request.nextUrl.searchParams.get('workspace'), plan = request.nextUrl.searchParams.get('plan');
    const result = plan ? await labPlanState(user, labId(plan)) : workspace ? await labWorkspaceState(user, labId(workspace)) : await labBootstrapFor(user);
    return NextResponse.json(result, { headers: labPrivateHeaders });
  } catch (error) { return labFailure(error); }
}
export async function POST(request: NextRequest) {
  let action: unknown, planId: unknown;
  try {
    const user = await requireLabUser();
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).host !== (request.headers.get('host') || request.nextUrl.host)) throw new StudioError('请在本站操作', 403);
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StudioError('请求内容无效');
    const body = input as Record<string, unknown>; action = body.action; planId = body.planId;
    let result: unknown;
    if (action === 'create-workspace') result = { workspace: await createLabWorkspace(user.id, body.id, body.name, (await getImageStudioSettings()).model) };
    else if (action === 'save-workspace') result = { workspace: await updateLabWorkspace(user.id, body.id, body.revision, body.name, body.draft) };
    else if (action === 'prepare') result = { plan: await prepareLab(user, body) };
    else if (action === 'quote') result = await quoteLab(user, labId(body.planId));
    else if (action === 'submit') result = await submitLab(user, body);
    else if (action === 'save-result') result = { workspace: await saveLabResult(user, body) };
    else if (action === 'save-config') {
      const config = await saveLabConfig(user, body.revision, body.fields);
      result = { config, configVersions: await labConfigVersions() };
    } else throw new StudioError('不支持的角色工作台操作');
    return NextResponse.json(result, { headers: labPrivateHeaders });
  } catch (error) {
    let submitted = action === 'submit' ? (error as { submitted?: boolean | null } | null)?.submitted : false;
    if (action === 'submit' && submitted === undefined) {
      submitted = null;
      // Only a durable preparation/rejection proves that no send is outstanding.
      if (typeof planId === 'string') {
        const user = await requireLabUser().catch(() => null);
        if (user) {
          const state = await labPlanState(user, planId).catch(() => null);
          if (state?.task) submitted = true;
          else if (state && ['prepared', 'rejected'].includes(state.submissionState)) submitted = false;
        }
      }
    }
    return labFailure(error, submitted);
  }
}
