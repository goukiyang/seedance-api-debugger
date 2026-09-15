import { NextResponse } from 'next/server';
import { release } from '@/lib/release';
export const dynamic = 'force-dynamic';
export function GET() { return NextResponse.json(release, { headers: { 'Cache-Control': 'no-store' } }); }
