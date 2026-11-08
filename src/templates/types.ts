import type { GeneratedFile } from '../services/ai/types';

export type BlueprintCategory = 'Biznis' | 'Produktivita' | 'Obsah' | 'Aplikácie';
export interface Blueprint {
  id: string;
  title: string;
  description: string;
  category: BlueprintCategory;
  icon: string;
  tags: string[];
  features: readonly [string, string, string];
  followups: [string, string, string, ...string[]];
  files: GeneratedFile[];
}
export interface BlueprintBrand { name: string; color: string; }
