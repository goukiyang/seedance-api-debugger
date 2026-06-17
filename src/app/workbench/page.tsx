import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function WorkbenchPage() {
  redirect('/tools/ultimate-canvas');
  return null;
}
