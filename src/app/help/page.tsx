import PageBanner from '@/components/PageBanner';
import { GuidedDemo } from '@/components/experience/demo/GuidedDemo';

export default function HelpPage() {
  return <div className="exp-detail">
    <PageBanner title="创作操作帮助" description="按需查看素材和成品的常用操作。" backHref="/generate" backLabel="返回视频生成" />
    <section className="card" aria-label="操作演示">
      <GuidedDemo kind="reference" />
      <GuidedDemo kind="compare" />
      <GuidedDemo kind="reuse" />
      <GuidedDemo kind="frames" />
      <GuidedDemo kind="request" />
    </section>
  </div>;
}
