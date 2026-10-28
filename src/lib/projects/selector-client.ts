'use client';

import { useEffect, useState } from 'react';
import { readJsonResponse } from '@/lib/http/json-response';

export const PROJECT_CATALOG_CHANGED = 'sd2:project-catalog-changed';
export type ProjectSelectorRecord = { id: string; name: string; type: string; status: string; can_manage_project?: boolean; can_generate?: boolean; can_manage_assets?: boolean };
export type ProjectCatalogChange = { ownerId: string; kind: 'created' | 'updated' | 'deleted' | 'checked'; projectId: string };
type Catalog = { projects: ProjectSelectorRecord[]; capabilities: { can_create_team_project?: boolean; create_operation_version?: number } };
const catalogs = new Map<string, { at: number; promise: Promise<Catalog> }>();
export function publishProjectCatalogChange(change: ProjectCatalogChange) {
  catalogs.delete(change.ownerId);
  window.dispatchEvent(new CustomEvent(PROJECT_CATALOG_CHANGED, { detail: change }));
}
/** Consumers rerun their own original query; this never substitutes a wider option list. */
export function useProjectCatalogRevision(ownerId?: string | null) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => {
      const value = (event as CustomEvent<ProjectCatalogChange>).detail;
      if (!ownerId || value?.ownerId === ownerId) setRevision(current => current + 1);
    };
    window.addEventListener(PROJECT_CATALOG_CHANGED, changed);
    return () => window.removeEventListener(PROJECT_CATALOG_CHANGED, changed);
  }, [ownerId]);
  return revision;
}
export function readProjectSelectorCatalog(ownerId: string) {
  const old = catalogs.get(ownerId);
  if (old && Date.now() - old.at < 30000) return old.promise;
  const promise = fetch('/api/projects?lite=true&include_all=true&include_archived=true', {
    cache: 'no-store', headers: { 'x-app-session-user': ownerId }, signal: AbortSignal.timeout(15000),
  }).then(async response => {
    const value = await readJsonResponse<Catalog>(response);
    if (!response.ok || !Array.isArray(value.projects)) throw new Error('项目管理资料暂未读到，可继续选择原列表中的项目。');
    return value;
  }).catch(cause => { catalogs.delete(ownerId); throw cause; });
  catalogs.set(ownerId, { at: Date.now(), promise });
  return promise;
}
