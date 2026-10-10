import type { ImageBillingView } from '@/lib/image-studio/billing-contract';
import { imageBillingLabel } from '@/lib/image-studio/billing-contract';
import styles from './ImageBillingBadge.module.css';

export function ImageBillingBadge({ billing }: { billing?: ImageBillingView | null }) {
  if (!billing || billing.status !== 'confirmed' || !Number.isSafeInteger(billing.amountMicros)
    || billing.amountMicros === null || billing.amountMicros < 0 || billing.chargedCredits === null
    || !Number.isFinite(billing.chargedCredits) || billing.chargedCredits < 0) return null;

  return <span className={styles.badge} data-confirmed title={imageBillingLabel(billing)}>
    已对账
  </span>;
}
