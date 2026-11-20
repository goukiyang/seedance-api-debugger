import { issuerMetadata } from '@/lib/bridge/review-oauth';
export const GET=()=>Response.json(issuerMetadata);
