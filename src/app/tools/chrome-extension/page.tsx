import { redirect } from 'next/navigation';
import { Download, Monitor, Puzzle } from 'lucide-react';
import { getSession } from '@/lib/auth/session';
import { isExternalUser, externalFallbackPath } from '@/lib/access/external-role';
import { readBridgeRelease, type BridgeRelease } from '@/lib/bridge/releases';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function BridgeDownloadPage() {
  const user = await getSession();
  if (!user) redirect('/login?return_to=%2Ftools%2Fchrome-extension');
  if (user.account_type !== 'internal' || isExternalUser(user)) redirect(externalFallbackPath());
  let release: BridgeRelease | null = null;
  try { release = await readBridgeRelease(); } catch { /* Keep unverified download links unavailable. */ }
  return <main className={styles.page}>
    <header><p className={styles.eyebrow}>SD2 生产桥</p><h1>插件下载</h1><p>把浏览器里的创作工具与 SD2 任务连接起来。</p></header>
    {!release ? <p className={styles.error} role="alert">最新安装包暂时无法读取。<a href="/tools/chrome-extension">重新读取</a></p> : <>
      <div className={styles.release}><span>最新版本 {release.version}</span><p>{release.notes}</p></div>
      <section className={styles.product} aria-labelledby="desktop-title">
        <div className={styles.icon}><Monitor size={27} aria-hidden="true" /></div>
        <div><h2 id="desktop-title">桌面插件 <small>v{release.version}</small></h2><p>集中管理生产桥任务与队列，配合 Chrome 插件连接浏览器中的创作页面。</p>
          <div className={styles.downloads}>{release.desktop.map(a => <a key={`${a.platform}-${a.arch}`} href={a.url}>
            <Download size={17} aria-hidden="true" />{a.platform === 'win32' ? 'Windows 64 位' : a.arch === 'arm64' ? 'Mac · Apple 芯片' : 'Mac · Intel 芯片'}
            <small>{(a.size / 1024 / 1024).toFixed(1)} MB</small></a>)}</div>
          <details><summary>桌面版安装说明</summary><ol><li>下载对应电脑的安装包并解压。</li><li>Mac：将 SD2生产桥.app 放入“应用程序”，首次右键选择“打开”。</li><li>Windows：打开解压目录中的 SD2生产桥.exe。</li><li>保持 Chrome 插件运行，在桌面版检查浏览器连接。</li></ol></details>
        </div>
      </section>
      <section className={styles.product} aria-labelledby="chrome-title">
        <div className={styles.icon}><Puzzle size={27} aria-hidden="true" /></div>
        <div><h2 id="chrome-title">Chrome 插件 <small>v{release.version}</small></h2><p>连接已登录的创作网页，接收任务并将原任务状态和结果带回 SD2。</p>
          <div className={styles.downloads}><a href={release.extension.url}><Download size={17} aria-hidden="true" />下载 Chrome 插件<small>{(release.extension.size / 1024 / 1024).toFixed(1)} MB</small></a></div>
          <details><summary>Chrome 安装与旧版迁移说明</summary><ol><li>新用户：解压安装包，打开 Chrome 扩展程序页面（chrome://extensions），开启“开发者模式”。</li><li>点击“加载已解压的扩展程序”，选择包含 manifest.json 的文件夹。</li><li>登录 SD2，并在插件里检查连接。</li></ol><p>已有旧版：先在旧插件设置中备份资料，保留旧安装目录和插件 ID。固定 ID 新版确认模板、组合、设置及绑定已恢复后，再停用旧插件；不要先卸载旧版。</p><p>更新已是固定 ID 的插件时，覆盖原安装目录后点击“重新加载”。</p></details>
        </div>
      </section>
    </>}
  </main>;
}
