import type { RoadFeature } from './types';

const HIGHWAY_FILTER =
  '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Index of the endpoint that most recently succeeded. Trying it first means
// one congested instance only costs us a single timeout before all later
// requests (including parallel prefetch chunks) start from the healthy one.
let preferredEndpoint = 0;

// Circuit breaker: when a request exhausts every endpoint, pause all Overpass
// traffic for a cool-down. Retrying into an outage aggravates it — sustained
// rapid retries are exactly what earns an IP-level block.
const COOLDOWN_MS = 2 * 60 * 1000;
let pausedUntil = 0;

/** Milliseconds until Overpass requests are allowed again (0 = not paused). */
export function overpassPausedMs(): number {
  return Math.max(0, pausedUntil - Date.now());
}

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
export const tileBbox = ([tx, ty]: TileCoord): [number, number, number, number] => [
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
 *
 * `endpointOffset` rotates which endpoint is tried first, letting
 * concurrent fetches spread across the available instances.
 */
export async function fetchRoadTiles(
  tiles: TileCoord[],
  endpointOffset = 0
): Promise<Map<number, RoadFeature>> {
  // `qt` (quadtile-sorted) output is faster for Overpass to produce than the
  // default id-sorted output; order doesn't matter to us.
  const query = `[out:json][timeout:30];
(
${tiles.map((t) => `  way["highway"~"${HIGHWAY_FILTER}"](${tileBbox(t).join(',')});`).join('\n')}
);
out geom qt;`;

  const pauseLeft = overpassPausedMs();
  if (pauseLeft > 0) {
    throw new Error(`Overpass requests paused for ${Math.ceil(pauseLeft / 1000)}s after repeated failures`);
  }

  const start = (preferredEndpoint + endpointOffset) % ENDPOINTS.length;
  const rotated = [...ENDPOINTS.slice(start), ...ENDPOINTS.slice(0, start)];
  let lastError: unknown;
  // Two rounds over the endpoints: public Overpass instances fail transiently
  // often enough that a single pass gives up too easily.
  for (const endpoint of [...rotated, ...rotated]) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        // A congested instance can hold a request in its queue far longer
        // than the query itself would take; give up and try the next
        // endpoint instead of waiting it out.
        signal: AbortSignal.timeout(20_000),
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
      preferredEndpoint = ENDPOINTS.indexOf(endpoint);
      pausedUntil = 0;
      return ways;
    } catch (err) {
      lastError = err;
      console.warn(`Overpass request to ${endpoint} failed:`, err);
      // A congested instance answers 503 instantly; pausing briefly keeps the
      // retry rounds from burning through every endpoint in a few seconds.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  pausedUntil = Date.now() + COOLDOWN_MS;
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
