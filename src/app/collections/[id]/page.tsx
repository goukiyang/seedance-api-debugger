import ReferenceAlbumDetailClient from './ReferenceAlbumDetailClient';

export default async function CollectionDetailPage(
  props: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<{ return_to?: string | string[] }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const returnTo = typeof searchParams?.return_to === 'string' ? searchParams.return_to : null;
  return <ReferenceAlbumDetailClient key={params.id} albumId={params.id} returnTo={returnTo} />;
}
