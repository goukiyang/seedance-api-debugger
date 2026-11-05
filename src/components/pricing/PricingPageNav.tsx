import Link from 'next/link';
import styles from './PricingPageNav.module.css';

export default function PricingPageNav({ active, isAdmin }: { active: 'guide' | 'settings'; isAdmin: boolean }) {
  if (!isAdmin) return null;
  return <nav className={styles.nav} aria-label="费率页面">
    <Link href="/pricing" aria-current={active === 'guide' ? 'page' : undefined}>费率说明</Link>
    <Link href="/admin/pricing" aria-current={active === 'settings' ? 'page' : undefined}>费率设置</Link>
  </nav>;
}
