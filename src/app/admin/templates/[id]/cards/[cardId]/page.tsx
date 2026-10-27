import { AdminTemplatesClient } from '@/components/templates/AdminTemplatesClient';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ id: string; cardId: string }>;
};

export default async function AdminTemplateCardEditPage(props: Props) {
  const params = await props.params;
  return <AdminTemplatesClient initialTemplateId={params.id} initialCardId={params.cardId} />;
}
