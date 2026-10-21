import ReferenceAlbumDetailClient from './ReferenceAlbumDetailClient';

export default function CollectionDetailPage({ params, searchParams }: {
  params: { id: string };
  searchParams?: { return_to?: string | string[] };
}) {
  const returnTo = typeof searchParams?.return_to === 'string' ? searchParams.return_to : null;
  return <ReferenceAlbumDetailClient key={params.id} albumId={params.id} returnTo={returnTo} />;
}
