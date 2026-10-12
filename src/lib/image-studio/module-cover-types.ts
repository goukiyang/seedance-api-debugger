// Browser-safe contract. Percent crops refer to the EXIF-oriented original image.
export const MODULE_COVER_OUTPUT = { width: 1280, height: 960, thumbnailWidth: 640, thumbnailHeight: 480 } as const;
export type ModuleCoverLayout = 'single' | 'horizontal' | 'vertical';
export type ModuleCoverTarget = { kind: 'module' | 'preset'; id: string };
export type ModuleCoverCrop = { x: number; y: number; width: number; height: number };
export type ModuleCoverSource = { assetId: string; version: string; crop: ModuleCoverCrop };
export type ModuleCoverRecipe = { version: 1; layout: ModuleCoverLayout; sources: ModuleCoverSource[];
  output: { width: 1280; height: 960 } };
export type ModuleCoverDTO = { revision: number; target: ModuleCoverTarget; available: boolean;
  thumbnailUrl: string | null; imageUrl: string | null; width: 1280; height: 960; updatedAt: string;
  unavailableReason?: string };
export type ModuleCoverSourceDTO = { assetId: string; version: string; previewUrl: string; width: number; height: number };
export type ModuleCoverEditorState = { target: ModuleCoverTarget; revision: number; canManage: boolean;
  fixedCover: ModuleCoverDTO | null; recipe: ModuleCoverRecipe | null; sources: ModuleCoverSourceDTO[];
  sourceError?: string };
export type ModuleCoverSaveInput = { requestId: string; expectedRevision: number; target: ModuleCoverTarget; recipe: ModuleCoverRecipe };
export type ModuleCoverSaveResult = { status: 'saved'; requestId: string; revision: number; fixedCover: ModuleCoverDTO; superseded?: boolean };
export type ModuleCoverRequestResult = ModuleCoverSaveResult | { status: 'pending' | 'failed' | 'not-found'; requestId: string; error?: string };
