import { prisma } from '@/lib/prisma';
import { billedCredits, parseImageBillingContract } from './billing-contract';
import { matchImageSupplierCharge, type ImageSupplierCharge } from './billing-provider';

type Specification = { model: string; quality?: string | null; output_size?: string | null; aspect_ratio?: string | null;
  reference_ids: string; context: string; prompt: string };
export function imageCostGroup(task: Specification) {
  let references: unknown;
  try { references = JSON.parse(task.reference_ids); } catch { return null; }
  // Reference-image input pricing needs dimensions and modality rules. Do not
  // transfer a no-reference observation to a referenced request.
  if (!Array.isArray(references) || references.length || !task.output_size || !task.quality) return null;
  const characters = task.context.length + task.prompt.length;
  const inputBand = 2 ** Math.ceil(Math.log2(Math.max(128, characters)));
  return JSON.stringify([task.model, task.quality, task.output_size, task.aspect_ratio, inputBand]);
}

export async function exactSpecificationEstimate(scope: string, current: Specification, bills: ImageSupplierCharge[], now = Date.now()) {
  const group = imageCostGroup(current);
  if (!group) return null;
  const tasks = await prisma.imageStudioTask.findMany({ where: { billing_scope: scope, model: current.model,
    status: 'succeeded', billing_status: 'confirmed', actual_amount_micros: { not: null },
    finished_at: { gte: new Date(now - 7 * 86400000) } }, orderBy: { finished_at: 'desc' }, take: 256,
    select: { id: true, model: true, quality: true, output_size: true, aspect_ratio: true,
      reference_ids: true, context: true, prompt: true, gateway_request_id: true, billing_contract_json: true, actual_amount_micros: true } });
  const amounts: number[] = [];
  for (const task of tasks) {
    if (imageCostGroup(task) !== group || !task.gateway_request_id) continue;
    const contract = parseImageBillingContract(task.billing_contract_json);
    if (!contract || contract.scope !== scope) continue;
    const match = matchImageSupplierCharge(bills, task.gateway_request_id, task.model);
    if (match.state !== 'matched' || match.charge.amountMicros !== task.actual_amount_micros) continue;
    const cash = await prisma.costLedger.findMany({ where: { image_task_id: task.id, confidence: 'confirmed',
      source_type: 'official_bill', event_type: 'official_charge', provider_account_id: scope,
      provider_task_id: task.gateway_request_id }, select: { amount_micros: true, pricing_snapshot: true }, take: 2 });
    if (cash.length !== 1 || cash[0].amount_micros !== task.actual_amount_micros) continue;
    try { if (JSON.parse(cash[0].pricing_snapshot || '{}').match !== 'scope_gateway_request_model') continue; } catch { continue; }
    // A fixed user-point contract does not invalidate the exact supplier cash.
    amounts.push(match.charge.amountMicros);
  }
  if (!amounts.length) return null;
  amounts.sort((a, b) => a - b);
  const enough = amounts.length >= 10;
  const anchor = enough ? amounts[Math.ceil(amounts.length * 0.9) - 1] : amounts[amounts.length - 1];
  const factor = enough ? 1.1 : amounts.length >= 3 ? 2 : 3;
  const micros = Math.ceil(anchor * factor);
  return { credits: Math.max(1, Math.ceil(billedCredits(micros))), amountMicros: micros,
    source: enough ? 'confirmed_p90' as const : 'exact_spec_sparse' as const,
    confidence: 'low' as const, samples: amounts.length, calibrated: false,
    assumption: `same_scope_quality_output_no_reference_input_band;cash_max_margin_${factor};not_token_bound`,
    version: 'exact-spec-cash-v1' };
}
