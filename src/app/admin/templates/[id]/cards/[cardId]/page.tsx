import { AdminTemplatesClient } from '@/components/templates/AdminTemplatesClient';

export const dynamic = 'force-dynamic';

type Props = {
  params: { id: string; cardId: string };
};

export default function AdminTemplateCardEditPage({ params }: Props) {
  return <AdminTemplatesClient initialTemplateId={params.id} initialCardId={params.cardId} />;
}
