import ReferenceAlbumDetailClient from './ReferenceAlbumDetailClient';

export default function CollectionDetailPage({ params }: { params: { id: string } }) {
  return <ReferenceAlbumDetailClient albumId={params.id} />;
}
