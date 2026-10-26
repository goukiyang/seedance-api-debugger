import { Suspense } from 'react';
import ReferenceAlbumsClient from './ReferenceAlbumsClient';

export default function CollectionsPage() {
  return <Suspense fallback={<div role="status">正在读取图集位置...</div>}><ReferenceAlbumsClient /></Suspense>;
}
