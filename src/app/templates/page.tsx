import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TemplateLibraryClient } from '@/components/templates/TemplateLibraryClient';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import styles from './template-entry.module.css';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage({ searchParams }: { searchParams?: { templateId?: string; template_id?: string } }) {
  const user = await getSession();
  if (isExternalUser(user)) redirect(externalFallbackPath());
  const templateId = searchParams?.templateId || searchParams?.template_id;
  const workbenchHref = templateId
    ? `/template-studio?type=video&templateId=${encodeURIComponent(templateId)}&templateSource=legacy`
    : '/template-studio?type=video';
  return (
    <>
      <div className={styles.entryLink}>
        <span>旧模板库继续可用。</span>
        <Link href={workbenchHref}>打开模板工作台</Link>
      </div>
      <TemplateLibraryClient />
    </>
  );
}
