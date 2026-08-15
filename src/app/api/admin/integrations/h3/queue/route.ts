import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { H3_API_SETTING_KEY, getH3ApiSettings } from '@/lib/integrations/h3';
import { H3ConfigurationError, H3RequestError, getH3QueueState, postH3AdminAction } from '@/lib/provider/h3';

export const dynamic = 'force-dynamic';

type H3QueueAction = 'pause' | 'resume' | 'cancel' | 'stop' | 'move';

const MOVE_DIRECTIONS = new Set(['top', 'up', 'down', 'bottom']);

function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function h3AdminOptions(settings: Awaited<ReturnType<typeof getH3ApiSettings>>) {
  return {
    baseUrl: settings.base_url,
    adminToken: settings.admin_token || undefined,
  };
}

function queueActionPath(action: H3QueueAction, jobId: string) {
  const encodedJobId = encodeURIComponent(jobId);
  if (action === 'pause') return '/api/h3/queue/pause';
  if (action === 'resume') return '/api/h3/queue/resume';
  if (action === 'cancel') return `/api/h3/jobs/${encodedJobId}/cancel`;
  if (action === 'stop') return `/api/h3/jobs/${encodedJobId}/stop`;
  return `/api/h3/jobs/${encodedJobId}/move`;
}

function actionBody(action: H3QueueAction, input: { reason: string; direction: string }) {
  if (action === 'pause' || action === 'resume') return input.reason ? { reason: input.reason } : {};
  if (action === 'stop') return input.reason ? { confirm: true, reason: input.reason } : { confirm: true };
  if (action === 'move') return { direction: input.direction };
  return input.reason ? { reason: input.reason } : {};
}

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof H3ConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  if (error instanceof H3RequestError) {
    return NextResponse.json({
      error: error.message,
      retry_after_seconds: error.retryAfterSeconds,
    }, { status: error.statusCode || 502 });
  }
  console.error('[Admin/H3Queue] failed:', error);
  return NextResponse.json({
    error: error instanceof Error ? error.message : fallback,
  }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const settings = await getH3ApiSettings();
    const queue = await getH3QueueState(h3AdminOptions(settings));
    return NextResponse.json({
      ok: true,
      setting_key: H3_API_SETTING_KEY,
      queue,
    });
  } catch (error) {
    return errorResponse(error, '读取 H3 队列失败');
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const action = cleanString(body.action) as H3QueueAction;
    const jobId = cleanString(body.job_id);
    const reason = cleanString(body.reason).slice(0, 240);
    const direction = cleanString(body.direction);

    if (!['pause', 'resume', 'cancel', 'stop', 'move'].includes(action)) {
      return NextResponse.json({ error: 'H3 队列动作无效' }, { status: 400 });
    }
    if ((action === 'cancel' || action === 'stop' || action === 'move') && !jobId) {
      return NextResponse.json({ error: '该 H3 队列动作必须指定 job_id' }, { status: 400 });
    }
    if (action === 'move' && !MOVE_DIRECTIONS.has(direction)) {
      return NextResponse.json({ error: 'H3 队列移动方向只允许 top、up、down、bottom' }, { status: 400 });
    }

    const settings = await getH3ApiSettings();
    const result = await postH3AdminAction(
      queueActionPath(action, jobId),
      actionBody(action, { reason, direction }),
      h3AdminOptions(settings),
    );

    await prisma.operationLog.create({
      data: {
        operator_id: admin.id,
        action: `h3_queue_${action}`,
        target_type: 'H3Queue',
        target_id: jobId || H3_API_SETTING_KEY,
        detail: JSON.stringify({
          action,
          job_id: jobId || null,
          direction: action === 'move' ? direction : null,
          reason: reason || null,
          base_url: settings.base_url,
          result_type: result && typeof result === 'object' ? 'object' : typeof result,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      action,
      result,
    });
  } catch (error) {
    return errorResponse(error, 'H3 队列操作失败');
  }
}
