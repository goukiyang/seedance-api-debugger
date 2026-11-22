/* Original private runtime document shapes are validated by their original schemas. */
export type JsonObject = Record<string, any>;
export type UiDocument = { id: string; revision: number; ownerId: string; updatedAt: string; archived?: boolean; data: JsonObject };
export type UiReference = { assetId: string; referenceImageId?: string; role: string; label: string; hash: string };
export type UiJob = { id: string; workspaceId: string; frameId: string; runId: string; parentRunId?: string; inputHash: string;
  body: JsonObject; context: string; references: UiReference[]; state: 'prepared' | 'sending' | 'accepted' | 'unknown' | 'rejected' | 'closed'; batchId?: string; error?: string; quote?: JsonObject };
export type UiBatch = { id: string; workspaceId: string; inputHash: string; jobs: UiJob[]; total: number; confirmed: boolean; stopped: boolean; pricingRevision: string; confirmedAt?: string };
