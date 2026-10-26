'use client';
import { ResourceLibraryPicker, type ResourceLibraryPickerProps } from '@/components/ResourceLibraryPicker';
import type { AssetType } from '@/types';
export type UploadedAssetSelection = { id: string; type: AssetType; originalUrl?: string; thumbnailUrl?: string | null; fileName?: string; width?: number | null; height?: number | null };
export type UploadedImagePickerConfirmResult = boolean | void | { success: boolean; message?: string };
export function UploadedImagePicker(props: ResourceLibraryPickerProps & { selectionOnly?: boolean }) { return <ResourceLibraryPicker {...props} />; }
