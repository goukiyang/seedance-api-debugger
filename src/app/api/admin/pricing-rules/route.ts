import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value: unknown) {
  return ['active', 'disabled'].includes(String(value)) ? String(value) : 'active';
}

function parseNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function buildFinalCost(baseCostPerSecond: number, internalMultiplier: number) {
  return Math.round(baseCostPerSecond * internalMultiplier * 10000) / 10000;
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const rules = await prisma.pricingRule.findMany({
    orderBy: [
      { status: 'asc' },
      { effective_at: 'desc' },
      { created_at: 'desc' },
    ],
  });

  return NextResponse.json({ rules });
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const name = normalizeText(body.name);
    const model = normalizeText(body.model);
    const resolution = normalizeText(body.resolution);
    const isFast = Boolean(body.is_fast ?? body.isFast);
    const baseCostPerSecond = parseNumber(body.base_cost_per_second ?? body.baseCostPerSecond);
    const internalMultiplier = parseNumber(body.internal_multiplier ?? body.internalMultiplier ?? 1);
    const status = normalizeStatus(body.status);
    const effectiveAtRaw = normalizeText(body.effective_at || body.effectiveAt);
    const effectiveAt = effectiveAtRaw ? new Date(effectiveAtRaw) : new Date();

    if (!name || !model || !resolution) {
      return errorJson('name、model、resolution 为必填项', 400);
    }
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
    const ruleKey = randomUUID();

    const rule = await prisma.$transaction(async (tx) => {
      const created = await tx.pricingRule.create({
        data: {
          rule_key: ruleKey,
          name,
          model,
          resolution,
          is_fast: isFast,
          base_cost_per_second: baseCostPerSecond,
          internal_multiplier: internalMultiplier,
          final_cost_per_second: finalCostPerSecond,
          version: 1,
          status,
          effective_at: effectiveAt,
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
          action: 'create_pricing_rule',
          target_type: 'PricingRule',
          target_id: created.id,
          detail: JSON.stringify({
            name,
            model,
            resolution,
            is_fast: isFast,
            version: 1,
            status,
          }),
        },
      });

      return created;
    });

    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    console.error('[Admin/PricingRules POST]', err);
    return errorJson('服务器错误', 500);
  }
}
