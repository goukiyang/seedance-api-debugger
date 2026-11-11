import type { FusionSettings } from './engine';
export type FusionRecipe = { id: string; name: string; settings: FusionSettings; revision: string; updatedAt: string };
export const recipeUsesDynamicCatalogue = (settings: FusionSettings) => settings.catalogue?.dynamic !== undefined;
