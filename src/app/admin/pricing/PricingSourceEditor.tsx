'use client';

import { RelativeTime } from '@/components/RelativeTime';
import type { PricingAdminBaseInput, PricingAdminExchangeInput, PricingAdminRow, PricingAdminRowChange, PricingAdminSimulation, PricingAdminSourceInput } from '@/lib/pricing/admin-contract';
import { compareDecimal } from '@/lib/pricing/math';
import { pricingAdminScenarioDifference } from '@/lib/pricing/admin-client-state';
import styles from './pricing.module.css';

const emptySource: PricingAdminSourceInput = { type: 'admin_defined', reference: '', note: '' };
const sourceNames: Record<PricingAdminSourceInput['type'], string> = {
  admin_defined: '管理员制定', document: '参考文档', supplier_statement: '供应商账单', existing_contract: '已有合同',
};
const roundingNames: Record<string, string> = { half_up_tenth: '任务扣点四舍五入至1位小数', ceil_task: '沿原合同，任务点数向上取整', fixed_unit: '沿原固定单位点价', half_up_cent: '沿原合同，保留2位小数', legacy: '沿原合同取整' };

export default function PricingSourceEditor({ row, rows, change, onChange, onAdoptGpt, exampleAmount, onExampleAmount, scenario }: {
  row: PricingAdminRow; rows: PricingAdminRow[]; change?: PricingAdminRowChange; onChange(patch: Omit<PricingAdminRowChange, 'id'>): void;
  onAdoptGpt(specifications: Record<string, string>): void; exampleAmount: string; onExampleAmount(value: string): void; scenario?: PricingAdminSimulation;
}) {
  const specifications = change?.specifications || row.identity.specifications;
  const relation = change?.baseRelation !== undefined ? change.baseRelation : change?.base || change?.specifications ? null : row.authoringEntry?.baseRelation;
  const evidence = change?.evidence || row.authoringEntry?.evidence;
  const sourceKind = (() => {
    if (relation) return 'derived';
    if (!change?.base && !change?.specifications && !change?.evidence) return row.authoringEntry?.sourceKind;
    try {
      return evidence && evidence.currency === 'CNY' && evidence.unit === row.identity.unit && compareDecimal(evidence.amount, change?.base?.amount ?? row.baseCny ?? '') === 0
        && Object.keys(evidence.specifications).length === Object.keys(specifications).length && Object.entries(specifications).every(([key, value]) => evidence.specifications[key] === value) ? evidence.kind : 'admin_defined';
    } catch { return 'admin_defined'; }
  })();
  const parents = rows.filter(parent => parent.identity.channelId === row.identity.channelId && parent.identity.modelId === 'dreamina-seedance-2-0-260128'
    && parent.identity.billingMode === 'fixed' && parent.enabled && parent.availability === 'ready' && parent.baseCny !== null
    && Object.keys(parent.identity.specifications).length === Object.keys(specifications).length
    && Object.entries(specifications).every(([key, value]) => parent.identity.specifications[key] === value));
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
      <div><dt>适用规格</dt><dd>{Object.entries(scenario?.specifications || specifications).map(([key, value]) => `${({ quality: '画质', resolution: '分辨率', ratio: '比例', referenceVideo: '参考视频', pricingPurpose: '用途', toolVersion: '增强档位', fpsTier: '帧率' } as Record<string, string>)[key] || '规格'}：${({ none: '无', present: '有', unknown: '待确认', standard: '普通', draft: '草稿', draft_upgrade: '草稿升级', professional: '专业', lte30: '30帧及以下', gt30: '高于30帧' } as Record<string, string>)[value] || value}`).join(' · ') || '通用规格'}</dd></div>
      <div><dt>适用入口</dt><dd>{row.appliesTo.join('、') || '未登记'}</dd></div>
      <div><dt>计价依据</dt><dd>{row.identity.billingMode === 'actual' ? '按实际成本结算' : sourceKind === 'historical_statement' || sourceKind === 'user_provided' || sourceKind === 'derived' ? '成本参考定价' : '站内自主定价'}</dd></div>
      <div><dt>采用基价</dt><dd>{change?.base?.amount || row.baseCny ? `¥${change?.base?.amount || row.baseCny}/${row.identity.unit === 'image' ? '张' : '秒'}` : row.identity.billingMode === 'actual' ? '无固定基价' : '待补依据'}</dd></div>
      <div><dt>来源性质</dt><dd>{({ user_provided: '你提供', historical_statement: '历史账单参考', derived: '推算', admin_defined: '管理员定价', unconfirmed: '待补依据' })[sourceKind || 'unconfirmed']}</dd></div>
      <div><dt>记录来源</dt><dd>{row.source ? `${sourceNames[row.source.type]} · ${row.source.reference || '未填写引用'} · ${row.source.confirmedBy.displayName}` : '尚未登记'} {row.source && <RelativeTime value={row.source.confirmedAt} />}</dd></div>
      {evidence && <div><dt>原始参考</dt><dd>{evidence.amount} {evidence.currency}/{evidence.unit === 'image' ? '张' : '秒'} · {evidence.reference}{evidence.exchangeAssumption ? ` · ${evidence.exchangeAssumption}` : ''}{evidence.sampledAt && <> · <RelativeTime value={evidence.sampledAt} /></>}<small>参考范围：{Object.values(evidence.specifications).join(' / ') || '未登记'} · 资料版本 {evidence.version}</small></dd></div>}
      {relation && <div><dt>基价推算</dt><dd>{rows.find(parent => parent.id === relation.parentId)?.label || '原父项'} × {relation.factor}{'exactProduct' in relation && <small>精确乘积 {String(relation.exactProduct)}，采用基价保留8位小数</small>}</dd></div>}
      {row.source?.note && <div><dt>备注</dt><dd>{row.source.note}</dd></div>}
      {row.legacyRounding && <div><dt>原计费规则</dt><dd>{row.legacyRounding === 'ceil_task' ? '原任务点数向上取整' : row.legacyRounding === 'fixed_unit' ? '原固定单价' : '原合同保留两位小数'}{row.legacyPointsPerUsd ? `，1 USD = ${row.legacyPointsPerUsd} 点` : ''}</dd></div>}
      {scenario?.rounding && roundingNames[scenario.rounding] && <div><dt>{scenario.isExample ? '示例取整' : '取整方式'}</dt><dd>{roundingNames[scenario.rounding]}{scenario.exactCredits !== null && <small>未取整{scenario.isExample ? '示例' : '计算'}值：{scenario.exactCredits} 点</small>}</dd></div>}
      {row.unavailableReason && <div><dt>当前状态</dt><dd>{row.unavailableReason}</dd></div>}
    </dl>
    {row.identity.billingMode === 'fixed' ? <details><summary>{row.baseCny === null ? '补充基价' : '编辑基价与来源'}</summary>
      <div className={styles.sourceForm}>
        <label>采用人民币基价（元/{row.identity.unit === 'image' ? '张' : '秒'}）<input type="text" inputMode="decimal" maxLength={32} value={base.amount} onChange={event => onChange({ base: { ...base, amount: event.target.value }, baseRelation: null })} /></label>
        <div>计价依据：站内人民币基价 · 每{row.identity.unit === 'image' ? '张' : '秒'}</div>
        {sourceFields(base.source, source => onChange({ base: { ...base, source } }), '基价')}
      </div>
      <p className={styles.muted}>手改金额或范围记为管理员定价，原参考保留。</p>
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
      <label className={styles.example}>每个独立任务假设账单金额（{exchange.sourceCurrency}）<input type="text" inputMode="decimal" maxLength={32} value={exampleAmount} onChange={event => onExampleAmount(event.target.value)} /></label>
      {exampleAmount && <p>示例：{scenario?.currentCredits ?? '待试算'} → {scenario?.adjustedCredits ?? '待试算'} 点{scenario && pricingAdminScenarioDifference(scenario) ? ` · ${pricingAdminScenarioDifference(scenario)}` : ''}；仅演算，不是最终扣点或预留上限。</p>}
    </details>}
    {row.identity.modelId === 'dreamina-seedance-2-5-260628' && specifications.referenceVideo === 'none' && specifications.pricingPurpose === 'standard' && <details><summary>基价跟随</summary>
      <label className={styles.example}>2.0 同档基价 ×1.5<select aria-label={`${row.label} 基价跟随`} value={relation?.parentId || ''} onChange={event => onChange({ baseRelation: event.target.value ? { parentId: event.target.value, factor: '1.5' } : null })}><option value="">单独基价</option>{parents.map(parent => <option key={parent.id} value={parent.id}>{parent.label} · {parent.baseCny} 元/秒</option>)}</select></label>
      <p className={styles.muted}>这里只调整基价关系，点/元跟随保持不变。</p>
    </details>}
    {row.identity.kind === 'image' && <details><summary>限定计价规格{row.identity.modelId === 'gpt-image-2' && row.identity.billingMode === 'fixed' ? '与0.10元建议' : ''}</summary>
      <div className={styles.sourceForm}>{(['quality', 'resolution', 'ratio'] as const).map(key => <label key={key}>{({ quality: '画质', resolution: '分辨率', ratio: '比例' })[key]}<input aria-label={`${row.label} 计价${key}`} maxLength={64} value={specifications[key] || ''} onChange={event => { const next = { ...specifications }; if (event.target.value) next[key] = event.target.value; else delete next[key]; onChange({ specifications: next }); }} /></label>)}</div>
      {Object.keys(row.identity.specifications).length === 0 && <p className={styles.muted}>保存为限定规格的新价格，原通用价保留。</p>}
      {row.identity.modelId === 'gpt-image-2' && row.identity.billingMode === 'fixed' && <><p>{row.providerLabel} · GPT Image 2 · {Object.values(specifications).join(' / ') || '先填写实际适用规格'}</p><button type="button" className={styles.link} disabled={!row.enabled || row.availability !== 'ready' || !Object.keys(specifications).length} onClick={() => onAdoptGpt(specifications)}>此范围采用 0.10 元建议</button></>}
    </details>}
  </div>;
}
