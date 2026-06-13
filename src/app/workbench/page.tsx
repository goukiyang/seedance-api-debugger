import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function WorkbenchPage() {
  redirect('/generate/canvas');
  return null;
}
