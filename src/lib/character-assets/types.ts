/** Browser-safe directory and ordered image input contracts. */
export type ReferenceImageInput =
  | { kind: 'site_image'; referenceImageId: string }
  | { kind: 'ark_asset'; characterAssetId: string; revision: number };

export type CharacterAssetDTO = {
  id: string;
  name: string;
  assetId: string;
  revision: number;
  enabled: boolean;
  deletedAt: string | null;
  groupId: string | null;
  projectName: string | null;
  notes: string | null;
  thumbnailReferenceImageId: string | null;
  thumbnailUrl: string | null;
  upstreamStatus: 'unknown';
};
