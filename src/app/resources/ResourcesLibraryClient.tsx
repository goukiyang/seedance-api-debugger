'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/lib/hooks/useWorkspace';
import {
  DEFAULT_GENERATION_DRAFT,
  GENERATION_DRAFT_STORAGE_KEY,
  sanitizeGenerationDraft,
  WORKSPACE_TAB_ID_STORAGE_KEY,
  type GenerationDraft,
  type GenerationDraftPatch,
} from '@/lib/generation-draft';
import type { ResourceDescriptor } from '@/lib/resources';

interface LoadResponse {
  resource: ResourceDescriptor;
  draftPatch: {
    prompt: string | null;
    parameters: GenerationDraftPatch | null;
  };
  notes: string[];
}

function categoryLabel(category: ResourceDescriptor['category']) {
  switch (category) {
    case 'image_collection':
      return 'Image';
    case 'brand_asset':
      return 'Brand';
    case 'prompt_template':
      return 'Prompt';
    case 'example_case':
      return 'Example';
    default:
      return 'Other';
  }
}

function readStoredDraft(): GenerationDraft {
  if (typeof window === 'undefined') return { ...DEFAULT_GENERATION_DRAFT };

  try {
    const raw = sessionStorage.getItem(GENERATION_DRAFT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GENERATION_DRAFT };
    return sanitizeGenerationDraft(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GENERATION_DRAFT };
  }
}

function writeStoredDraft(draft: GenerationDraft) {
  sessionStorage.setItem(GENERATION_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

function getWorkspaceTabId(): string {
  const existing = sessionStorage.getItem(WORKSPACE_TAB_ID_STORAGE_KEY);
  if (existing) return existing;
  const created = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sessionStorage.setItem(WORKSPACE_TAB_ID_STORAGE_KEY, created);
  return created;
}

function applyDraftPatch(current: GenerationDraft, patch: LoadResponse['draftPatch'], mode: 'append' | 'replace'): GenerationDraft {
  let next = { ...current };

  if (mode === 'replace' && patch.parameters) {
    next = sanitizeGenerationDraft({ ...next, ...patch.parameters });
  }

  if (patch.prompt) {
    next.prompt = mode === 'append' && next.prompt.trim()
      ? `${next.prompt.trim()}\n\n${patch.prompt.trim()}`
      : patch.prompt;
  }

  return next;
}

export default function ResourcesLibraryClient({
  initialResources,
  currentUserName,
}: {
  initialResources: ResourceDescriptor[];
  currentUserName: string;
}) {
  const router = useRouter();
  const workspace = useWorkspace();
  const [resources, setResources] = useState<ResourceDescriptor[]>(initialResources);
  const [selectedId, setSelectedId] = useState<string>(initialResources[0]?.id ?? '');
  const [selectedResource, setSelectedResource] = useState<ResourceDescriptor | null>(initialResources[0] ?? null);
  const [typeFilter, setTypeFilter] = useState<'all' | ResourceDescriptor['category']>('all');
  const [query, setQuery] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingResourceId, setLoadingResourceId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GenerationDraft>(DEFAULT_GENERATION_DRAFT);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pendingChoice, setPendingChoice] = useState<ResourceDescriptor | null>(null);

  useEffect(() => {
    setDraft(readStoredDraft());
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const existing = resources.find((resource) => resource.id === selectedId);
    if (existing) setSelectedResource(existing);

    setLoadingDetail(true);
    fetch(`/api/resources/${selectedId}`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load resource');
        setSelectedResource(data.resource);
      })
      .catch((fetchError) => {
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load resource');
      })
      .finally(() => {
        setLoadingDetail(false);
      });
  }, [resources, selectedId]);

  const filteredResources = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return resources.filter((resource) => {
      if (typeFilter !== 'all' && resource.category !== typeFilter) return false;
      if (!keyword) return true;

      const haystack = [
        resource.name,
        resource.summary,
        resource.resourceType,
        resource.promptText || '',
      ].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }, [query, resources, typeFilter]);

  const hasWorkspaceContent = workspace.assets.length > 0 || draft.prompt.trim().length > 0;

  const refreshResources = async () => {
    const response = await fetch('/api/resources', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to load resources');
    }
    setResources(data.resources || []);
  };

  const performLoad = async (resource: ResourceDescriptor, mode: 'append' | 'replace') => {
    setLoadingResourceId(resource.id);
    setError('');
    setMessage('');

    try {
      const response = await fetch(`/api/resources/${resource.id}/load`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': getWorkspaceTabId(),
        },
        body: JSON.stringify({ mode }),
      });
      const data: LoadResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load resource');

      const currentDraft = readStoredDraft();
      const nextDraft = applyDraftPatch(currentDraft, data.draftPatch, mode);
      writeStoredDraft(nextDraft);
      setDraft(nextDraft);
      await workspace.refresh();
      setMessage(`${resource.name} is ready in the generation workspace.`);
      if (data.notes.length > 0) {
        setMessage(`${resource.name} is ready in the generation workspace. ${data.notes[0]}`);
      }
      router.push('/generate');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load resource');
      await refreshResources().catch(() => {});
    } finally {
      setLoadingResourceId(null);
      setPendingChoice(null);
    }
  };

  const handlePrimaryAction = (resource: ResourceDescriptor) => {
    if (hasWorkspaceContent) {
      setPendingChoice(resource);
      return;
    }
    void performLoad(resource, 'replace');
  };

  const typeFilters: Array<{ value: 'all' | ResourceDescriptor['category']; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'image_collection', label: 'Image' },
    { value: 'brand_asset', label: 'Brand' },
    { value: 'prompt_template', label: 'Prompt' },
    { value: 'example_case', label: 'Example' },
  ];

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', color: '#fff', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>Resource Library</div>
          <h1 style={{ margin: '6px 0 10px', fontSize: 30 }}>Generation resources</h1>
          <div style={{ color: 'rgba(255,255,255,0.66)', maxWidth: 760, lineHeight: 1.55 }}>
            Browse shared references, brand kits, prompt templates, and example cases, then load what you need straight into the generation workspace.
          </div>
        </div>
        <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
          <div>{currentUserName}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Link href="/generate" style={navButtonStyle}>Generate</Link>
            <Link href="/tasks" style={secondaryButtonStyle}>Tasks</Link>
          </div>
        </div>
      </header>

      {(message || error) && (
        <div style={{
          marginBottom: 16,
          padding: '12px 14px',
          borderRadius: 8,
          border: error ? '1px solid rgba(248,113,113,0.35)' : '1px solid rgba(74,222,128,0.35)',
          background: error ? 'rgba(127,29,29,0.35)' : 'rgba(20,83,45,0.28)',
          color: error ? '#fecaca' : '#bbf7d0',
        }}>
          {error || message}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(340px, 0.9fr)', gap: 18, alignItems: 'start' }}>
        <div style={panelStyle}>
          <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {typeFilters.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setTypeFilter(filter.value)}
                  style={{
                    ...chipButtonStyle,
                    background: typeFilter === filter.value ? '#4f46e5' : 'rgba(255,255,255,0.06)',
                    borderColor: typeFilter === filter.value ? '#6366f1' : 'rgba(255,255,255,0.1)',
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search resources"
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'grid', gap: 12, padding: 16 }}>
            {filteredResources.map((resource) => (
              <article
                key={resource.id}
                onClick={() => setSelectedId(resource.id)}
                style={{
                  border: selectedId === resource.id ? '1px solid rgba(99,102,241,0.7)' : '1px solid rgba(255,255,255,0.08)',
                  background: selectedId === resource.id ? 'rgba(79,70,229,0.16)' : 'rgba(255,255,255,0.03)',
                  borderRadius: 8,
                  padding: 14,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{
                    width: 88,
                    aspectRatio: '1 / 1',
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: 'rgba(255,255,255,0.06)',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,0.45)',
                  }}>
                    {resource.previewUrl ? (
                      <img src={resource.previewUrl} alt={resource.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span>{categoryLabel(resource.category)}</span>
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: 17, fontWeight: 700 }}>{resource.name}</div>
                        <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, marginTop: 4 }}>{resource.resourceType}</div>
                      </div>
                      <span style={badgeStyle}>{categoryLabel(resource.category)}</span>
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 1.5, marginTop: 10 }}>
                      {resource.summary}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                      {resource.loadSummary.map((item) => (
                        <span key={item} style={summaryPillStyle}>{item}</span>
                      ))}
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handlePrimaryAction(resource);
                        }}
                        disabled={loadingResourceId === resource.id}
                        style={{ ...navButtonStyle, opacity: loadingResourceId === resource.id ? 0.65 : 1 }}
                      >
                        {loadingResourceId === resource.id ? 'Adding...' : 'Add to Workspace'}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}

            {filteredResources.length === 0 && (
              <div style={{ padding: 24, borderRadius: 8, border: '1px dashed rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.55)' }}>
                No matching resources.
              </div>
            )}
          </div>
        </div>

        <aside style={panelStyle}>
          <div style={{ padding: 18, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>Resource detail</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
              {selectedResource?.name || 'Select a resource'}
            </div>
          </div>

          <div style={{ padding: 18 }}>
            {loadingDetail && <div style={{ color: 'rgba(255,255,255,0.55)' }}>Loading detail...</div>}

            {!loadingDetail && selectedResource && (
              <>
                {selectedResource.previewUrl && (
                  <div style={{
                    width: '100%',
                    aspectRatio: '16 / 10',
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: 'rgba(255,255,255,0.04)',
                    marginBottom: 16,
                  }}>
                    <img src={selectedResource.previewUrl} alt={selectedResource.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  <span style={badgeStyle}>{categoryLabel(selectedResource.category)}</span>
                  {selectedResource.loadSummary.map((item) => (
                    <span key={item} style={summaryPillStyle}>{item}</span>
                  ))}
                </div>

                <div style={detailSectionStyle}>
                  <div style={detailTitleStyle}>Summary</div>
                  <div style={detailBodyStyle}>{selectedResource.summary}</div>
                </div>

                <div style={detailSectionStyle}>
                  <div style={detailTitleStyle}>Workspace impact</div>
                  <ul style={detailListStyle}>
                    {selectedResource.references.length > 0 && <li>{selectedResource.references.length} reference image(s) will be added.</li>}
                    {selectedResource.promptText && <li>Prompt text will be {hasWorkspaceContent ? 'merged or replaced based on your choice' : 'loaded into the composer'}.</li>}
                    {selectedResource.parameters && Object.keys(selectedResource.parameters).length > 0 && <li>Stored generation settings are available on replace.</li>}
                    {!selectedResource.promptText && selectedResource.references.length === 0 && <li>No directly loadable prompt or image payload is stored yet.</li>}
                  </ul>
                </div>

                {selectedResource.promptText && (
                  <div style={detailSectionStyle}>
                    <div style={detailTitleStyle}>Prompt preview</div>
                    <pre style={promptPreviewStyle}>{selectedResource.promptText}</pre>
                  </div>
                )}

                {selectedResource.parameters && Object.keys(selectedResource.parameters).length > 0 && (
                  <div style={detailSectionStyle}>
                    <div style={detailTitleStyle}>Stored settings</div>
                    <pre style={promptPreviewStyle}>{JSON.stringify(selectedResource.parameters, null, 2)}</pre>
                  </div>
                )}

                {selectedResource.references.length > 0 && (
                  <div style={detailSectionStyle}>
                    <div style={detailTitleStyle}>References</div>
                    <div style={{ display: 'grid', gap: 10 }}>
                      {selectedResource.references.map((reference, index) => (
                        <div key={`${reference.url}-${index}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <div style={{
                            width: 56,
                            height: 56,
                            borderRadius: 8,
                            overflow: 'hidden',
                            background: 'rgba(255,255,255,0.06)',
                            flexShrink: 0,
                          }}>
                            <img src={reference.thumbnailUrl || reference.url} alt={reference.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{reference.name}</div>
                            <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>{reference.url}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedResource.honestyNote && (
                  <div style={{
                    marginTop: 14,
                    borderRadius: 8,
                    padding: '12px 13px',
                    background: 'rgba(245,158,11,0.12)',
                    border: '1px solid rgba(245,158,11,0.26)',
                    color: '#fcd34d',
                    lineHeight: 1.5,
                    fontSize: 13,
                  }}>
                    {selectedResource.honestyNote}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
                  <button
                    type="button"
                    onClick={() => handlePrimaryAction(selectedResource)}
                    disabled={loadingResourceId === selectedResource.id}
                    style={{ ...navButtonStyle, opacity: loadingResourceId === selectedResource.id ? 0.65 : 1 }}
                  >
                    {loadingResourceId === selectedResource.id ? 'Adding...' : 'Add to Workspace'}
                  </button>
                  <Link href="/generate" style={secondaryButtonStyle}>Open Generate</Link>
                </div>
              </>
            )}
          </div>
        </aside>
      </section>

      {pendingChoice && (
        <div style={modalBackdropStyle}>
          <div style={modalPanelStyle}>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Current workspace already has content</div>
            <div style={{ color: 'rgba(255,255,255,0.72)', lineHeight: 1.55, marginBottom: 18 }}>
              Choose how <strong>{pendingChoice.name}</strong> should enter the generation workspace.
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <button type="button" style={choiceButtonStyle} onClick={() => void performLoad(pendingChoice, 'append')}>
                Append to current content
              </button>
              <button type="button" style={choiceButtonStyle} onClick={() => void performLoad(pendingChoice, 'replace')}>
                Replace current content
              </button>
              <button type="button" style={cancelButtonStyle} onClick={() => setPendingChoice(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const panelStyle: CSSProperties = {
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.02)',
  overflow: 'hidden',
};

const navButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 40,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid #6366f1',
  background: '#4f46e5',
  color: '#fff',
  textDecoration: 'none',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  ...navButtonStyle,
  background: 'rgba(255,255,255,0.04)',
  borderColor: 'rgba(255,255,255,0.1)',
};

const chipButtonStyle: CSSProperties = {
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.1)',
  minHeight: 34,
  padding: '0 12px',
  color: '#fff',
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 42,
  padding: '0 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.05)',
  color: '#fff',
};

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 24,
  padding: '0 8px',
  borderRadius: 999,
  background: 'rgba(99,102,241,0.18)',
  color: '#c7d2fe',
  fontSize: 12,
  fontWeight: 700,
};

const summaryPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 24,
  padding: '0 8px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.7)',
  fontSize: 12,
};

const detailSectionStyle: CSSProperties = {
  marginTop: 18,
};

const detailTitleStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(255,255,255,0.46)',
  marginBottom: 8,
};

const detailBodyStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.82)',
  lineHeight: 1.6,
};

const detailListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: 'rgba(255,255,255,0.82)',
  lineHeight: 1.65,
};

const promptPreviewStyle: CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  padding: 12,
  borderRadius: 8,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: 'rgba(255,255,255,0.82)',
  fontSize: 13,
  lineHeight: 1.55,
};

const modalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,17,23,0.78)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const modalPanelStyle: CSSProperties = {
  width: 'min(440px, 100%)',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.1)',
  background: '#131722',
  padding: 20,
  boxShadow: '0 28px 80px rgba(0,0,0,0.45)',
};

const choiceButtonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.05)',
  color: '#fff',
  fontWeight: 600,
  cursor: 'pointer',
};

const cancelButtonStyle: CSSProperties = {
  ...choiceButtonStyle,
  background: 'transparent',
  color: 'rgba(255,255,255,0.72)',
};
