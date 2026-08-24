import type { RoadFeature } from './types';

export interface Tier {
  label: string;
  /** OpenMapTiles transportation classes belonging to this tier. */
  classes: string[];
  color: [number, number, number];
  width: number;
  minPixels: number;
}

// Ordered lowest tier first so lower layers draw beneath higher ones.
// Service roads, alleys, paths, and tracks are deliberately excluded.
export const TIERS: Tier[] = [
  {
    label: 'Local streets',
    classes: ['minor'],
    color: [59, 71, 99],
    width: 4,
    minPixels: 1,
  },
  {
    label: 'Collectors',
    classes: ['tertiary'],
    color: [44, 127, 184],
    width: 8,
    minPixels: 1.5,
  },
  {
    label: 'Minor arterials',
    classes: ['secondary'],
    color: [65, 182, 166],
    width: 12,
    minPixels: 2,
  },
  {
    label: 'Principal arterials',
    classes: ['primary'],
    color: [253, 174, 97],
    width: 16,
    minPixels: 2.5,
  },
  {
    label: 'Highways',
    classes: ['motorway', 'trunk'],
    color: [244, 91, 78],
    width: 22,
    minPixels: 3,
  },
];

const classToTier = new Map<string, number>();
TIERS.forEach((tier, i) => tier.classes.forEach((c) => classToTier.set(c, i)));

/** Tier index for a transportation class, or undefined if not visualized. */
export function tierOfClass(cls: string): number | undefined {
  return classToTier.get(cls);
}

/** Tier index for a road feature, or undefined if its class isn't visualized. */
export function tierOf(feature: RoadFeature): number | undefined {
  return classToTier.get(feature.properties.class);
}
