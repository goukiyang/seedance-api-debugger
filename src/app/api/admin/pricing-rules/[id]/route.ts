import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

type RouteContext = {
  params: {
    id: string;
  };
};

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value: unknown) {
  return ['active', 'disabled'].includes(String(value)) ? String(value) : undefined;
}

function parseNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function buildFinalCost(baseCostPerSecond: number, internalMultiplier: number) {
  return Math.round(baseCostPerSecond * internalMultiplier * 10000) / 10000;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const rule = await prisma.pricingRule.findUnique({ where: { id: context.params.id } });
  if (!rule) return errorJson('计费规则不存在', 404);
  return NextResponse.json({ rule });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const current = await prisma.pricingRule.findUnique({ where: { id: context.params.id } });
    if (!current) return errorJson('计费规则不存在', 404);

    const body = await request.json();
    const name = normalizeText(body.name) || current.name;
    const model = normalizeText(body.model) || current.model;
    const resolution = normalizeText(body.resolution) || current.resolution;
    const isFast = typeof body.is_fast === 'boolean' || typeof body.isFast === 'boolean'
      ? Boolean(body.is_fast ?? body.isFast)
      : current.is_fast;
    const baseCostPerSecond = body.base_cost_per_second !== undefined || body.baseCostPerSecond !== undefined
      ? parseNumber(body.base_cost_per_second ?? body.baseCostPerSecond)
      : current.base_cost_per_second;
    const internalMultiplier = body.internal_multiplier !== undefined || body.internalMultiplier !== undefined
      ? parseNumber(body.internal_multiplier ?? body.internalMultiplier)
      : current.internal_multiplier;
    const status = normalizeStatus(body.status) || 'active';
    const effectiveAtRaw = normalizeText(body.effective_at || body.effectiveAt);
    const effectiveAt = effectiveAtRaw ? new Date(effectiveAtRaw) : new Date();

    if (!Number.isFinite(baseCostPerSecond) || baseCostPerSecond < 0) {
      return errorJson('base_cost_per_second 必须为非负数', 400);
    }
    if (!Number.isFinite(internalMultiplier) || internalMultiplier < 0) {
      return errorJson('internal_multiplier 必须为非负数', 400);
    }
    if (Number.isNaN(effectiveAt.getTime())) {
      return errorJson('effective_at 无效', 400);
    }

    const finalCostPerSecond = buildFinalCost(baseCostPerSecond, internalMultiplier);

    const rule = await prisma.$transaction(async (tx) => {
      const created = await tx.pricingRule.create({
        data: {
          rule_key: current.rule_key,
          name,
          model,
          resolution,
          is_fast: isFast,
          base_cost_per_second: baseCostPerSecond,
          internal_multiplier: internalMultiplier,
          final_cost_per_second: finalCostPerSecond,
          version: current.version + 1,
          status,
          effective_at: effectiveAt,
          supersedes_rule_id: current.id,
        },
      });

      if (status === 'active') {
        await tx.pricingRule.updateMany({
          where: {
            id: { not: created.id },
            model,
            resolution,
            is_fast: isFast,
            status: 'active',
          },
          data: { status: 'disabled' },
        });
      }

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'version_pricing_rule',
          target_type: 'PricingRule',
          target_id: created.id,
          detail: JSON.stringify({
            source_rule_id: current.id,
            version: created.version,
            model,
            resolution,
            is_fast: isFast,
            status,
          }),
        },
      });

      return created;
    });

    return NextResponse.json({ rule });
  } catch (err) {
    console.error('[Admin/PricingRules PATCH]', err);
    return errorJson('服务器错误', 500);
  }
}
