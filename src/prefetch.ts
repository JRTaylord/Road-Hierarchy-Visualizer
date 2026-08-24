import { WebMercatorViewport } from '@deck.gl/core';
import { MAX_DATA_ZOOM } from './roadtiles';
import { prefetchTiles, type TileIndex } from './tilestore';

/**
 * Predictive tile prefetching. Watches viewport movement, extrapolates where
 * the camera will be a moment from now, and warms the tile store with the
 * tiles that view will need — plus a one-tile ring around the current view so
 * even an unpredicted pan direction has its first row of tiles ready. By the
 * time deck.gl's TileLayer asks for a tile, it is ideally already resolved.
 */

interface PrefetchViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

/** Lowest zoom with any road content (matches the TileLayer's minZoom). */
const MIN_DATA_ZOOM = 4;
/** How far ahead of current motion to predict, in ms. */
const LOOKAHEAD_MS = 450;
/** Extra tiles fetched around the visible set in every direction. */
const RING = 1;
/** Cap on speculative tiles per prediction, nearest-first. */
const MAX_TILES = 48;
/** Minimum time between predictions; camera moves faster than tiles load. */
const MIN_INTERVAL_MS = 120;
/** Widest tile span considered per axis (high pitch makes bounds enormous). */
const MAX_SPAN = 16;
/** Web-mercator latitude limit. */
const MAX_LAT = 85.051129;

interface Snapshot {
  longitude: number;
  latitude: number;
  zoom: number;
  time: number;
}

interface Candidate extends TileIndex {
  d: number;
}

let last: Snapshot | null = null;
let lastRun = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Same tile zoom the TileLayer picks: round(viewZoom + log2(512/256)). */
const dataZoomFor = (viewZoom: number): number =>
  clamp(Math.round(viewZoom + 1), MIN_DATA_ZOOM, MAX_DATA_ZOOM);

const lngToTileX = (lng: number, z: number): number => ((lng + 180) / 360) * 2 ** z;

function latToTileY(lat: number, z: number): number {
  const r = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/**
 * Tiles covering `bounds` at zoom `z`, expanded by `ring`, capped to MAX_SPAN
 * per axis around the focus point, scored by tile distance from the focus.
 */
function cover(
  bounds: [number, number, number, number],
  z: number,
  ring: number,
  focusLng: number,
  focusLat: number
): Candidate[] {
  const [west, south, east, north] = bounds;
  const n = 2 ** z;
  const fx = lngToTileX(focusLng, z);
  const fy = latToTileY(focusLat, z);
  const halfSpan = MAX_SPAN / 2;
  const xMin = Math.max(0, Math.floor(Math.max(lngToTileX(west, z) - ring, fx - halfSpan)));
  const xMax = Math.min(n - 1, Math.floor(Math.min(lngToTileX(east, z) + ring, fx + halfSpan)));
  const yMin = Math.max(0, Math.floor(Math.max(latToTileY(north, z) - ring, fy - halfSpan)));
  const yMax = Math.min(n - 1, Math.floor(Math.min(latToTileY(south, z) + ring, fy + halfSpan)));
  const out: Candidate[] = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const dx = x + 0.5 - fx;
      const dy = y + 0.5 - fy;
      out.push({ x, y, z, d: dx * dx + dy * dy });
    }
  }
  return out;
}

function boundsFor(view: PrefetchViewState, width: number, height: number, lng: number, lat: number, zoom: number): [number, number, number, number] {
  return new WebMercatorViewport({
    width,
    height,
    longitude: lng,
    latitude: clamp(lat, -MAX_LAT, MAX_LAT),
    zoom,
    pitch: view.pitch ?? 0,
    bearing: view.bearing ?? 0,
  }).getBounds();
}

function runPrediction(view: PrefetchViewState, width: number, height: number): void {
  const now = performance.now();
  lastRun = now;

  // Extrapolate current motion LOOKAHEAD_MS into the future. A stale snapshot
  // (pause in interaction) means no meaningful velocity — predict in place.
  let predLng = view.longitude;
  let predLat = view.latitude;
  let predZoom = view.zoom;
  if (last) {
    const dt = now - last.time;
    if (dt > 0 && dt < 500) {
      const k = LOOKAHEAD_MS / dt;
      predLng = view.longitude + (view.longitude - last.longitude) * k;
      predLat = clamp(view.latitude + (view.latitude - last.latitude) * k, -MAX_LAT, MAX_LAT);
      predZoom = clamp(view.zoom + (view.zoom - last.zoom) * k, MIN_DATA_ZOOM - 1, MAX_DATA_ZOOM + 3);
    }
  }
  last = { longitude: view.longitude, latitude: view.latitude, zoom: view.zoom, time: now };

  const zNow = dataZoomFor(view.zoom);
  const zPred = dataZoomFor(predZoom);

  // Ring around the current view at the current detail level, plus the
  // predicted view's tiles (which may be at a different detail level when
  // zooming). Duplicates collapse to the nearer score.
  const candidates = new Map<string, Candidate>();
  const add = (c: Candidate): void => {
    const key = `${c.z}/${c.x}/${c.y}`;
    const prior = candidates.get(key);
    if (!prior || c.d < prior.d) candidates.set(key, c);
  };
  cover(boundsFor(view, width, height, view.longitude, view.latitude, view.zoom), zNow, RING, view.longitude, view.latitude).forEach(add);
  cover(boundsFor(view, width, height, predLng, predLat, predZoom), zPred, RING, predLng, predLat).forEach(add);

  const wishlist = [...candidates.values()].sort((a, b) => a.d - b.d).slice(0, MAX_TILES);
  prefetchTiles(wishlist);
}

/**
 * Feed a view state change into the predictor. Throttled: runs at most every
 * MIN_INTERVAL_MS, with a trailing run so the final resting view of a pan or
 * zoom always gets its ring prefetched.
 */
export function schedulePrefetch(view: PrefetchViewState, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  const elapsed = performance.now() - lastRun;
  if (trailing !== null) clearTimeout(trailing);
  if (elapsed >= MIN_INTERVAL_MS) {
    runPrediction(view, width, height);
  } else {
    trailing = setTimeout(() => {
      trailing = null;
      runPrediction(view, width, height);
    }, MIN_INTERVAL_MS - elapsed);
  }
}
