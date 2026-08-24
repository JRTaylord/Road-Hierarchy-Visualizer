import type { RoadFeature } from './types';

const HIGHWAY_FILTER =
  '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Tile size in degrees. Tiles are aligned to a fixed global grid so the same
 * area always maps to the same tile regardless of where loading started. */
export const TILE_SIZE = 0.05;

export type TileCoord = [number, number];

export const tileKey = ([tx, ty]: TileCoord): string => `${tx},${ty}`;

export const tileAt = (lng: number, lat: number): TileCoord => [
  Math.floor(lng / TILE_SIZE),
  Math.floor(lat / TILE_SIZE),
];

/** [south, west, north, east] */
const tileBbox = ([tx, ty]: TileCoord): [number, number, number, number] => [
  ty * TILE_SIZE,
  tx * TILE_SIZE,
  (ty + 1) * TILE_SIZE,
  (tx + 1) * TILE_SIZE,
];

interface OverpassWay {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/**
 * Fetch all visualized road classes intersecting the given tiles.
 * Returns features keyed by OSM way id so callers can dedupe against
 * ways already present from neighboring tiles.
 */
export async function fetchRoadTiles(tiles: TileCoord[]): Promise<Map<number, RoadFeature>> {
  const query = `[out:json][timeout:60];
(
${tiles.map((t) => `  way["highway"~"${HIGHWAY_FILTER}"](${tileBbox(t).join(',')});`).join('\n')}
);
out geom;`;

  let lastError: unknown;
  // Two rounds over the endpoints: public Overpass instances fail transiently
  // often enough that a single pass gives up too easily.
  for (const endpoint of [...ENDPOINTS, ...ENDPOINTS]) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const json = (await res.json()) as { elements: OverpassWay[] };
      const ways = new Map<number, RoadFeature>();
      for (const el of json.elements ?? []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2 || !el.tags?.highway) continue;
        ways.set(el.id, {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: el.geometry.map((g) => [g.lon, g.lat]),
          },
          properties: { name: el.tags.name ?? null, highway: el.tags.highway },
        });
      }
      return ways;
    } catch (err) {
      lastError = err;
      console.warn(`Overpass request to ${endpoint} failed:`, err);
    }
  }
  throw lastError;
}

export interface ZipLocation {
  latitude: number;
  longitude: number;
  label: string;
}

/** Geocode a US ZIP code to its centroid via the free Zippopotam API. */
export async function geocodeZip(zip: string): Promise<ZipLocation | null> {
  const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    places?: { latitude: string; longitude: string; 'place name': string; 'state abbreviation': string }[];
  };
  const place = data.places?.[0];
  if (!place) return null;
  return {
    latitude: parseFloat(place.latitude),
    longitude: parseFloat(place.longitude),
    label: `${place['place name']}, ${place['state abbreviation']} ${zip}`,
  };
}
