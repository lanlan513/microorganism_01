import microbesData from '../data/microbesData.json' with { type: 'json' };
import { RunStore } from './petriStore.js';
import { join } from 'node:path';
import type { CatalogEntry } from '../../../shared/sim/engine.js';
import type { SimCategory } from '../../../shared/sim/types.js';
import type { Microbe } from '../../../shared/types.js';

const microbes = microbesData as Microbe[];

const catalog = new Map<number, CatalogEntry>();
for (const m of microbes) {
  catalog.set(m.id, {
    name: m.name,
    scientificName: m.scientificName,
    category: m.category as SimCategory,
  });
}

export const dataDir = join(process.cwd(), 'data', 'petri');
export const petriStore = new RunStore(dataDir);
export const petriCatalog = catalog;
