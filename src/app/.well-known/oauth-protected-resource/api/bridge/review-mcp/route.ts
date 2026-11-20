import { resourceMetadata } from '@/lib/bridge/review-oauth';
export const GET=()=>Response.json(resourceMetadata);
