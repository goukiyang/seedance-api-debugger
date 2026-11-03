import type { WorkCard } from './types';

export type WorkContextGroupId = 'same-submission' | 'source' | 'derived' | 'same-template';
export type WorkMethodTemplate = {
  module: 'image-preset' | 'image-module' | 'video-studio' | 'video-legacy';
  id: string; version: string; label: string;
};
export type WorkMethodSetting = { key: string; label: string; value: string | number | boolean };
export type WorkMethod = {
  kind: 'image-template' | 'video-template' | 'settings'; label: string;
  template?: WorkMethodTemplate; settings: WorkMethodSetting[];
  action: { kind: 'template' | 'reference' | 'unavailable'; label: string; reason?: string };
};
export type WorkContextGroup = { id: WorkContextGroupId; label: string; items: WorkCard[]; nextCursor: string | null };
export type WorkContext = { viewerId: string; workId: string; mediaVersion: string; method: WorkMethod | null; groups: WorkContextGroup[]; indexing: boolean;
  delivery?: { selected: true; locked: boolean; label: '已选交付' | '已锁定交付' } };
