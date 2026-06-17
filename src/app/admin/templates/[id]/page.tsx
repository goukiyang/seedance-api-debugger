import { AdminTemplatesClient } from '@/components/templates/AdminTemplatesClient';

export const dynamic = 'force-dynamic';

type Props = {
  params: { id: string };
};

export default function AdminTemplateDetailPage({ params }: Props) {
  return <AdminTemplatesClient initialTemplateId={params.id} />;
}
