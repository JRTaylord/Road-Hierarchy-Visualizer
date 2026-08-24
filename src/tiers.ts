import type { RoadFeature } from './types';

export interface Tier {
  label: string;
  highways: string[];
  color: [number, number, number];
  width: number;
  minPixels: number;
}

// Ordered lowest tier first so lower layers draw beneath higher ones.
export const TIERS: Tier[] = [
  {
    label: 'Local streets',
    highways: ['residential', 'unclassified'],
    color: [59, 71, 99],
    width: 4,
    minPixels: 1,
  },
  {
    label: 'Collectors',
    highways: ['tertiary', 'tertiary_link'],
    color: [44, 127, 184],
    width: 8,
    minPixels: 1.5,
  },
  {
    label: 'Minor arterials',
    highways: ['secondary', 'secondary_link'],
    color: [65, 182, 166],
    width: 12,
    minPixels: 2,
  },
  {
    label: 'Principal arterials',
    highways: ['primary', 'primary_link'],
    color: [253, 174, 97],
    width: 16,
    minPixels: 2.5,
  },
  {
    label: 'Highways',
    highways: ['motorway', 'motorway_link', 'trunk', 'trunk_link'],
    color: [244, 91, 78],
    width: 22,
    minPixels: 3,
  },
];

const highwayToTier = new Map<string, number>();
TIERS.forEach((tier, i) => tier.highways.forEach((h) => highwayToTier.set(h, i)));

/** Tier index for a road feature, or undefined if its class isn't visualized. */
export function tierOf(feature: RoadFeature): number | undefined {
  return highwayToTier.get(feature.properties.highway);
}
