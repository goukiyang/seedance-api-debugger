'use client';

import { RelativeTime } from '@/components/RelativeTime';
import type { PricingAdminBaseInput, PricingAdminExchangeInput, PricingAdminRow, PricingAdminRowChange, PricingAdminSourceInput } from '@/lib/pricing/admin-contract';
import styles from './pricing.module.css';

const emptySource: PricingAdminSourceInput = { type: 'admin_defined', reference: '', note: '' };
const sourceNames: Record<PricingAdminSourceInput['type'], string> = {
  admin_defined: '管理员制定', document: '参考文档', supplier_statement: '供应商账单', existing_contract: '已有合同',
};

export default function PricingSourceEditor({ row, change, onChange }: {
  row: PricingAdminRow; change?: PricingAdminRowChange; onChange(patch: Omit<PricingAdminRowChange, 'id'>): void;
}) {
  const base: PricingAdminBaseInput = change?.base || { amount: row.baseCny || '', currency: 'CNY', unit: row.identity.unit,
    source: row.source ? { type: row.source.type, reference: row.source.reference, note: row.source.note } : emptySource };
  const exchange: PricingAdminExchangeInput = change?.exchangeRate || (row.exchangeRate ? {
    sourceCurrency: row.exchangeRate.sourceCurrency, targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: row.exchangeRate.rate,
    effectiveFrom: row.exchangeRate.effectiveFrom, source: { type: row.exchangeRate.source.type, reference: row.exchangeRate.source.reference, note: row.exchangeRate.source.note },
  } : { sourceCurrency: 'USD', targetCurrency: 'CNY', direction: 'CNY_per_source_unit', rate: '', effectiveFrom: '', source: emptySource });
  const sourceFields = (source: PricingAdminSourceInput, set: (source: PricingAdminSourceInput) => void, prefix: string) => <>
    <label>来源类型<select value={source.type} onChange={event => set({ ...source, type: event.target.value as PricingAdminSourceInput['type'] })}>
      {Object.entries(sourceNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>来源名称或引用<input aria-label={`${prefix}来源名称或引用`} maxLength={2048} value={source.reference} onChange={event => set({ ...source, reference: event.target.value })} /></label>
    <label className={styles.full}>备注<textarea aria-label={`${prefix}来源备注`} rows={2} maxLength={4000} value={source.note} onChange={event => set({ ...source, note: event.target.value })} /></label>
  </>;
  return <div className={styles.source}>
    <dl className={styles.facts}>
      <div><dt>适用规格</dt><dd>{Object.entries(row.identity.specifications).map(([key, value]) => `${key}: ${value}`).join(' · ') || '通用规格'}</dd></div>
      <div><dt>适用入口</dt><dd>{row.appliesTo.join('、') || '未登记'}</dd></div>
      <div><dt>计价依据</dt><dd>{row.basisKind === 'site_base_cny' ? '站内人民币基价' : '供应商实际成本'}</dd></div>
      <div><dt>来源</dt><dd>{row.source ? `${sourceNames[row.source.type]} · ${row.source.reference || '未填写引用'} · ${row.source.confirmedBy.displayName}` : '尚未确认'} {row.source && <RelativeTime value={row.source.confirmedAt} />}</dd></div>
      {row.source?.note && <div><dt>备注</dt><dd>{row.source.note}</dd></div>}
      {row.legacyRounding && <div><dt>原计费规则</dt><dd>{row.legacyRounding === 'ceil_task' ? '原任务点数向上取整' : row.legacyRounding === 'fixed_unit' ? '原固定单价' : '原合同保留两位小数'}{row.legacyPointsPerUsd ? `，1 USD = ${row.legacyPointsPerUsd} 点` : ''}</dd></div>}
      {row.unavailableReason && <div><dt>当前状态</dt><dd>{row.unavailableReason}</dd></div>}
    </dl>
    {row.identity.billingMode === 'fixed' ? <details><summary>{row.baseCny === null ? '补充基价' : '编辑基价与来源'}</summary>
      <div className={styles.sourceForm}>
        <label>人民币基价（元/{row.identity.unit === 'image' ? '张' : '秒'}）<input type="text" inputMode="decimal" maxLength={32} value={base.amount} onChange={event => onChange({ base: { ...base, amount: event.target.value } })} /></label>
        <div>计价依据：站内人民币基价 · 每{row.identity.unit === 'image' ? '张' : '秒'}</div>
        {sourceFields(base.source, source => onChange({ base: { ...base, source } }), '基价')}
      </div>
      <p className={styles.muted}>来源随本次保存确认。只影响新任务，不改供应商账单。</p>
    </details> : <details><summary>汇率与费用依据</summary>
      <p>{row.exchangeRate ? `1 ${row.exchangeRate.sourceCurrency} = ${row.exchangeRate.rate} CNY，来源：${sourceNames[row.exchangeRate.source.type]} · ${row.exchangeRate.source.reference}` : '尚未确认汇率，不以固定每张价格代替实际成本。'}</p>
      {row.exchangeRate && <p className={styles.muted}>生效时间 <RelativeTime value={row.exchangeRate.effectiveFrom} /> · 确认于 <RelativeTime value={row.exchangeRate.confirmedAt} /> · {row.exchangeRate.confirmedBy.displayName}</p>}
      <div className={styles.sourceForm}>
        <div>账单币种：{exchange.sourceCurrency === 'CNY' ? '人民币 CNY（沿原合同）' : '美元 USD'}</div>
        <label>1 {exchange.sourceCurrency} 折合人民币（元）<input type="text" inputMode="decimal" maxLength={32} value={exchange.rate} readOnly={exchange.sourceCurrency === 'CNY'} onChange={event => onChange({ exchangeRate: { ...exchange, rate: event.target.value } })} /></label>
        <label className={styles.full}>生效时间（含时区的准确时间）<input type="text" placeholder="2026-10-18T12:00:00-07:00" maxLength={100} value={exchange.effectiveFrom} onChange={event => onChange({ exchangeRate: { ...exchange, effectiveFrom: event.target.value } })} /></label>
        {sourceFields(exchange.source, source => onChange({ exchangeRate: { ...exchange, source } }), '汇率')}
      </div>
      <p className={styles.muted}>实际成本 × 本次冻结汇率 × 点/元。旧合同与晚到账单沿各自原修订。</p>
    </details>}
  </div>;
}
