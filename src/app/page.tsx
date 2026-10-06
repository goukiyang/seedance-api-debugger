import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import Link from 'next/link';
import { ArrowUpRight, Clapperboard, LayoutTemplate, Network, Scissors, UserRound } from 'lucide-react';
import { isNavItemVisible } from '@/lib/navigation';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import styles from './home.module.css';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getSession();
  if (!user) redirect('/register');
  const internal = isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user);
  const images = canUseCompanyTemplates(user);
  const entries = [
    { name: '视频生成', icon: Clapperboard, tone: 'video', visible: internal, links: [{ name: '普通视频', href: '/generate' }, { name: 'IP视频', href: '/generate/ip' }] },
    { name: '画布', icon: Network, tone: 'canvas', visible: internal, links: [{ name: '打开画布', href: '/tools/ultimate-canvas' }] },
    { name: '模板', icon: LayoutTemplate, tone: 'templates', visible: internal || images, links: [...(images ? [{ name: '图片生成', href: '/template-studio?type=image' }] : []), ...(internal ? [{ name: '现有视频模板', href: '/template-studio?type=video' }] : [])] },
    { name: '随机真人', icon: UserRound, tone: 'avatar', visible: images, links: [{ name: '人物生成', href: '/tools/avatar-studio' }] },
    { name: '抠图工具', icon: Scissors, tone: 'cutout', visible: user.role === 'admin', links: [{ name: 'AI 抠图', href: '/cutout' }] },
  ];
  return <main className={styles.page}>
    <header className={styles.header}><h1>创作</h1><nav aria-label="创作记录"><Link href="/tasks">我的任务</Link><Link href="/assets">资产</Link></nav></header>
    <div className={styles.entries}>{entries.filter(entry => entry.visible).map(entry => <section key={entry.tone} className={styles.entry} data-kind={entry.tone}>
      <Link className={styles.visual} href={entry.links[0].href} aria-label={entry.name}><img src={`/home/${entry.tone}.png`} width={640} height={360} alt={`${entry.name}用途示意（自绘虚拟内容）`} /></Link>
      <div className={styles.content}><h2>{entry.name}</h2><div className={styles.links}>{entry.links.map(link => <Link key={link.href} href={link.href}>{link.name}<ArrowUpRight size={15} aria-hidden="true" /></Link>)}</div>
        {entry.tone === 'templates' && <small>脚本模板入口待确认</small>}
      </div>
    </section>)}</div>
  </main>;
}
