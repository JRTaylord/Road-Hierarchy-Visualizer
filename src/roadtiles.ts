import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Geometry } from 'geojson';
import { tierOfClass } from './tiers';
import type { RoadFeature } from './types';

/**
 * Road data from OpenFreeMap vector tiles (OpenMapTiles schema) — a free,
 * keyless, CDN-backed source with no rate limits, designed for exactly this
 * viewport-streaming access pattern. The schema provides natural
 * level-of-detail: low-zoom tiles only contain major road classes
 * (motorways from ~z6, primaries from ~z7, minor roads from z12).
 */

/** Maximum zoom OpenFreeMap serves; deeper views over-zoom z14 data. */
export const MAX_DATA_ZOOM = 14;

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

// The tile URL template contains a dated snapshot path, so it must be
// discovered from TileJSON at runtime rather than hardcoded.
let templatePromise: Promise<string> | null = null;

function tileUrlTemplate(): Promise<string> {
  if (!templatePromise) {
    const p = (async () => {
      const res = await fetch(TILEJSON_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
      const json = (await res.json()) as { tiles?: string[] };
      const template = json.tiles?.[0];
      if (!template) throw new Error('TileJSON has no tile URL template');
      return template;
    })();
    p.catch(() => {
      // Allow a later call to retry instead of caching the failure forever.
      if (templatePromise === p) templatePromise = null;
    });
    templatePromise = p;
  }
  return templatePromise;
}

const coordKey = (lng: number, lat: number): string => `${lng.toFixed(6)},${lat.toFixed(6)}`;

type LineCoords = [number, number][];

function linesOf(geometry: Geometry): LineCoords[] {
  if (geometry.type === 'LineString') return [geometry.coordinates as LineCoords];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as LineCoords[];
  return [];
}

function decodeRoads(buf: ArrayBuffer, x: number, y: number, z: number): RoadFeature[] {
  const tile = new VectorTile(new PbfReader(buf));
  const roads = tile.layers['transportation'];
  if (!roads) return [];

  // The transportation layer carries no names; index the vertices of the
  // transportation_name layer and let road features inherit a label from any
  // shared vertex (both layers are quantized to the same tile grid, so
  // coinciding geometry matches exactly).
  const names = new Map<string, string>();
  const nameLayer = tile.layers['transportation_name'];
  if (nameLayer) {
    for (let i = 0; i < nameLayer.length; i++) {
      const f = nameLayer.feature(i);
      const props = f.properties;
      const label =
        (typeof props['name'] === 'string' && props['name']) ||
        (typeof props['ref'] === 'string' && props['ref']) ||
        null;
      if (!label) continue;
      for (const line of linesOf(f.toGeoJSON(x, y, z).geometry)) {
        for (const [lng, lat] of line) names.set(coordKey(lng, lat), label);
      }
    }
  }

  const out: RoadFeature[] = [];
  for (let i = 0; i < roads.length; i++) {
    const f = roads.feature(i);
    const cls = f.properties['class'];
    if (typeof cls !== 'string' || tierOfClass(cls) === undefined) continue;
    for (const line of linesOf(f.toGeoJSON(x, y, z).geometry)) {
      if (line.length < 2) continue;
      let name: string | null = null;
      for (const [lng, lat] of line) {
        const hit = names.get(coordKey(lng, lat));
        if (hit) {
          name = hit;
          break;
        }
      }
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: line },
        properties: { name, class: cls },
      });
    }
  }
  return out;
}

/** Fetch and decode one OpenFreeMap tile's roads at any zoom. */
export async function fetchRoadTile(
  x: number,
  y: number,
  z: number,
  signal?: AbortSignal
): Promise<RoadFeature[]> {
  const template = await tileUrlTemplate();
  const url = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const timeout = AbortSignal.timeout(15_000);
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.status === 404 || res.status === 204) return []; // no data (open water etc.)
      if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
      return decodeRoads(await res.arrayBuffer(), x, y, z);
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err; // viewport moved on; don't retry
    }
  }
  throw lastError;
}
