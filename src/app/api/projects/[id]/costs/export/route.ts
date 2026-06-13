import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewProject } from '@/lib/projects/permissions';
import { amountMicrosToCnyEstimate, amountMinorToCnyEstimate, usdToCnyRateText } from '@/lib/costs/currency';
import { displayUserName } from '@/lib/users/display';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanViewProject(user, params.id);

    const tasks = await prisma.videoTask.findMany({
      where: { project_id: params.id },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        prompt: true,
        local_status: true,
        model: true,
        resolution: true,
        duration: true,
        estimated_cost: true,
        actual_cost: true,
        refund_amount: true,
        provider_task_id: true,
        provider_cost_status: true,
        provider_official_amount_minor: true,
        provider_final_amount_minor: true,
        provider_official_amount_micros: true,
        provider_final_amount_micros: true,
        provider_cost_currency: true,
        created_at: true,
        completed_at: true,
        owner: { select: { name: true, username: true } },
        user: { select: { name: true, username: true } },
        project: { select: { name: true } },
      },
    });

    const headers = [
      'task_id',
      'project',
      'creator',
      'status',
      'model',
      'resolution',
      'duration',
      'estimated_credits',
      'charged_credits',
      'refunded_credits',
      'official_cost_minor',
      'official_cost_micros',
      'official_cost_cny_estimate',
      'final_cost_minor',
      'final_cost_micros',
      'final_cost_cny_estimate',
      'cost_currency',
      'cny_estimate_rate',
      'cost_status',
      'provider_task_id',
      'created_at',
      'completed_at',
      'prompt',
    ];

    const rows = tasks.map((task) => [
      task.id,
      task.project?.name || '',
      displayUserName(task.owner || task.user),
      task.local_status,
      task.model,
      task.resolution || '',
      task.duration || '',
      task.estimated_cost ?? '',
      task.actual_cost ?? '',
      task.refund_amount ?? '',
      task.provider_official_amount_minor ?? '',
      task.provider_official_amount_micros ?? '',
      task.provider_official_amount_micros !== null && task.provider_official_amount_micros !== undefined
        ? amountMicrosToCnyEstimate(task.provider_official_amount_micros, task.provider_cost_currency)
        : amountMinorToCnyEstimate(task.provider_official_amount_minor, task.provider_cost_currency),
      task.provider_final_amount_minor ?? '',
      task.provider_final_amount_micros ?? '',
      task.provider_final_amount_micros !== null && task.provider_final_amount_micros !== undefined
        ? amountMicrosToCnyEstimate(task.provider_final_amount_micros, task.provider_cost_currency)
        : amountMinorToCnyEstimate(task.provider_final_amount_minor, task.provider_cost_currency),
      task.provider_cost_currency || '',
      task.provider_cost_currency === 'USD' ? usdToCnyRateText() : '',
      task.provider_cost_status,
      task.provider_task_id || '',
      task.created_at.toISOString(),
      task.completed_at ? task.completed_at.toISOString() : '',
      task.prompt,
    ]);

    const csv = [
      headers.map(csvCell).join(','),
      ...rows.map((row) => row.map(csvCell).join(',')),
    ].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="project-${params.id}-usage.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProjectCostExport] Failed:', error);
    return NextResponse.json({ error: '导出失败' }, { status: 500 });
  }
}
