import type { ImageBillingView } from '@/lib/image-studio/billing-contract';
import { imageBillingLabel } from '@/lib/image-studio/billing-contract';
import styles from './ImageBillingBadge.module.css';

export function ImageBillingBadge({ billing }: { billing?: ImageBillingView | null }) {
  if (!billing) return null;

  const confirmed = billing.amountMicros !== null && billing.chargedCredits !== null;
  return <span className={styles.badge} data-confirmed={confirmed || undefined}
    title={confirmed ? '图片实际费用' : '图片费用核对状态'}>
    {imageBillingLabel(billing)}
  </span>;
}
