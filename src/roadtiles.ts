import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Geometry } from 'geojson';
import { tierOfClass } from './tiers';
import type { RoadFeature } from './types';

/**
 * Road data from OpenFreeMap vector tiles (OpenMapTiles schema) — a free,
 * keyless, CDN-backed source with no rate limits, unlike the public Overpass
 * instances this replaced.
 */

/** Zoom of the app's clickable/loadable tile grid (standard web-mercator). */
export const APP_ZOOM = 13;
/** Zoom of the underlying data tiles; z14 has full street detail. */
const DATA_ZOOM = 14;

export type TileCoord = [number, number];

export const tileKey = ([tx, ty]: TileCoord): string => `${tx},${ty}`;

export const tileAt = (lng: number, lat: number): TileCoord => {
  const n = 2 ** APP_ZOOM;
  const rad = (lat * Math.PI) / 180;
  return [
    Math.floor(((lng + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  ];
};

const tileLat = (y: number, n: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** [south, west, north, east] */
export const tileBbox = ([tx, ty]: TileCoord): [number, number, number, number] => {
  const n = 2 ** APP_ZOOM;
  return [tileLat(ty + 1, n), (tx / n) * 360 - 180, tileLat(ty, n), ((tx + 1) / n) * 360 - 180];
};

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

function decodeRoads(buf: ArrayBuffer, x: number, y: number): RoadFeature[] {
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
      for (const line of linesOf(f.toGeoJSON(x, y, DATA_ZOOM).geometry)) {
        for (const [lng, lat] of line) names.set(coordKey(lng, lat), label);
      }
    }
  }

  const out: RoadFeature[] = [];
  for (let i = 0; i < roads.length; i++) {
    const f = roads.feature(i);
    const cls = f.properties['class'];
    if (typeof cls !== 'string' || tierOfClass(cls) === undefined) continue;
    for (const line of linesOf(f.toGeoJSON(x, y, DATA_ZOOM).geometry)) {
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

/** Fetch and decode all roads in an app tile (via its four z14 data tiles). */
export async function fetchRoadTile([tx, ty]: TileCoord): Promise<RoadFeature[]> {
  const template = await tileUrlTemplate();
  const children: TileCoord[] = [
    [2 * tx, 2 * ty],
    [2 * tx + 1, 2 * ty],
    [2 * tx, 2 * ty + 1],
    [2 * tx + 1, 2 * ty + 1],
  ];
  const parts = await Promise.all(
    children.map(async ([cx, cy]) => {
      const url = template
        .replace('{z}', String(DATA_ZOOM))
        .replace('{x}', String(cx))
        .replace('{y}', String(cy));
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (res.status === 404 || res.status === 204) return []; // no data (open water etc.)
          if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
          return decodeRoads(await res.arrayBuffer(), cx, cy);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    })
  );
  return parts.flat();
}
