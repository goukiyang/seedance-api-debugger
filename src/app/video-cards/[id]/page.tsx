import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';

export default async function LegacyVideoCardRedirectPage({
  params,
}: {
  params: { id: string };
}) {
  const videoCard = await prisma.videoCard.findUnique({
    where: { id: params.id },
    select: { id: true, project_id: true },
  });

  if (!videoCard) notFound();

  redirect(`/projects/${encodeURIComponent(videoCard.project_id)}/video-cards/${encodeURIComponent(videoCard.id)}`);
}
