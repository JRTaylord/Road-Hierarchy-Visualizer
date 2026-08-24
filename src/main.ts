import { Deck, FlyToInterpolator, type PickingInfo } from '@deck.gl/core';
import { PathLayer, PolygonLayer } from '@deck.gl/layers';
import { TIERS, tierOf } from './tiers';
import type { RoadFeature } from './types';
import { fetchRoadTile, tileAt, tileBbox, tileKey, type TileCoord } from './roadtiles';
import { geocodeZip } from './geocode';
import { getCachedTile, putCachedTile } from './tilecache';
import './style.css';

const DEFAULT_ZIP = '98402'; // downtown Tacoma

interface CachedTile {
  coord: TileCoord;
  features: RoadFeature[];
}

// Tiles whose roads are visible on the map.
const renderedTiles = new Set<string>();
// Tiles with a fetch in flight (explicit or preload).
const pendingTiles = new Map<string, TileCoord>();
// Preloaded tiles: data fetched and held in memory, hidden until clicked.
const cachedTiles = new Map<string, CachedTile>();
let byTier: RoadFeature[][] = TIERS.map(() => []);
// Bumped when the user jumps to a new ZIP so stale in-flight loads get discarded.
let generation = 0;
// Unrendered tile currently under the cursor, shown as a click-to-load preview.
let hoverTile: TileCoord | null = null;
let hoverKey: string | null = null;

const statusEl = document.getElementById('status')!;
const placeEl = document.getElementById('place')!;

function setStatus(text: string | null): void {
  statusEl.hidden = text === null;
  statusEl.textContent = text ?? '';
}

function buildLegend(): void {
  const rows = document.getElementById('legend-rows')!;
  for (const tier of [...TIERS].reverse()) {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `rgb(${tier.color.join(',')})`;
    const label = document.createElement('span');
    label.textContent = tier.label;
    li.append(swatch, label);
    rows.appendChild(li);
  }
}

function getTooltip({ object }: PickingInfo<RoadFeature>) {
  if (!object) return null;
  const tierIndex = tierOf(object);
  const tierLabel = tierIndex !== undefined ? TIERS[tierIndex].label : object.properties.class;
  return {
    html: `<b>${object.properties.name ?? 'unnamed'}</b><br/>${tierLabel}`,
    style: {
      background: '#1a1f2e',
      color: '#e8eaf0',
      fontSize: '12px',
      borderRadius: '6px',
      padding: '6px 10px',
    },
  };
}

const tilePolygon = (t: TileCoord): [number, number][] => {
  const [s, w, n, e] = tileBbox(t);
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
};

function makeLayers() {
  const layers: (PathLayer<RoadFeature> | PolygonLayer<TileCoord>)[] = [
    new PolygonLayer<TileCoord>({
      id: 'tiles-pending',
      data: [...pendingTiles.values()],
      getPolygon: tilePolygon,
      filled: true,
      stroked: true,
      getFillColor: [44, 127, 184, 25],
      getLineColor: [44, 127, 184, 140],
      lineWidthMinPixels: 1,
      pickable: false,
    }),
    new PolygonLayer<TileCoord>({
      id: 'tiles-ready',
      data: [...cachedTiles.values()].map((c) => c.coord),
      getPolygon: tilePolygon,
      filled: false,
      stroked: true,
      getLineColor: [255, 255, 255, 25],
      lineWidthMinPixels: 1,
      pickable: false,
    }),
    new PolygonLayer<TileCoord>({
      id: 'tile-hover',
      data: hoverTile ? [hoverTile] : [],
      getPolygon: tilePolygon,
      filled: true,
      stroked: true,
      getFillColor: [255, 255, 255, 12],
      getLineColor: [255, 255, 255, 70],
      lineWidthMinPixels: 1,
      pickable: false,
    }),
  ];
  TIERS.forEach((tier, i) =>
    layers.push(
      new PathLayer<RoadFeature>({
        id: `roads-tier-${i}`,
        data: byTier[i],
        getPath: (f) => f.geometry.coordinates,
        getColor: tier.color,
        getWidth: tier.width,
        widthUnits: 'meters',
        widthMinPixels: tier.minPixels,
        capRounded: true,
        jointRounded: true,
        pickable: true,
      })
    )
  );
  return layers;
}

function rebuild(): void {
  deck.setProps({ layers: makeLayers() });
}

/** Add features to the rendered road layers. */
function renderFeatures(features: RoadFeature[]): void {
  const added: RoadFeature[][] = TIERS.map(() => []);
  for (const feature of features) {
    const tier = tierOf(feature);
    if (tier !== undefined) added[tier].push(feature);
  }
  byTier = byTier.map((arr, i) => (added[i].length > 0 ? arr.concat(added[i]) : arr));
}

/** Reveal a preloaded tile instantly and prefetch its neighbors. */
function revealCached(t: TileCoord): void {
  const key = tileKey(t);
  const cached = cachedTiles.get(key);
  if (!cached) return;
  cachedTiles.delete(key);
  renderFeatures(cached.features);
  renderedTiles.add(key);
  if (hoverKey === key) {
    hoverKey = null;
    hoverTile = null;
  }
  rebuild();
  void preloadTiles(neighborsOf([t]));
}

// Supply a pre-sized canvas instead of letting deck create one. Deck creates
// its canvas before layout, seeding luma's CanvasContext with the 300×150
// default; if the ResizeObserver's catch-up delivery then races the async GPU
// device attach, the context stays stuck at that size (blurry rendering,
// broken picking). A canvas that is already laid out and buffer-sized starts
// correct no matter how that race resolves.
const deckCanvas = document.getElementById('deck-canvas') as HTMLCanvasElement;
deckCanvas.width = Math.max(1, Math.round(deckCanvas.clientWidth * window.devicePixelRatio));
deckCanvas.height = Math.max(1, Math.round(deckCanvas.clientHeight * window.devicePixelRatio));

const deck = new Deck({
  canvas: deckCanvas,
  initialViewState: {
    longitude: -122.4443,
    latitude: 47.2529,
    zoom: 11.5,
    pitch: 50,
    bearing: -15,
  },
  controller: { touchRotate: true, inertia: 300 },
  layers: [],
  getTooltip,
  getCursor: ({ isDragging }) => (isDragging ? 'grabbing' : hoverKey ? 'pointer' : 'grab'),
  onHover: (info) => {
    let next: TileCoord | null = null;
    if (info.coordinate) {
      const t = tileAt(info.coordinate[0], info.coordinate[1]);
      const k = tileKey(t);
      if (!renderedTiles.has(k) && !pendingTiles.has(k)) next = t;
    }
    const nextKey = next ? tileKey(next) : null;
    if (nextKey !== hoverKey) {
      hoverKey = nextKey;
      hoverTile = next;
      rebuild();
    }
  },
  onClick: (info) => {
    if (!info.coordinate) return;
    const t = tileAt(info.coordinate[0], info.coordinate[1]);
    if (cachedTiles.has(tileKey(t))) {
      revealCached(t);
    } else {
      void loadTiles([t]);
    }
  },
});

const isKnown = (key: string): boolean =>
  renderedTiles.has(key) || pendingTiles.has(key) || cachedTiles.has(key);

/** Unknown tiles adjacent to (or part of) the given set. */
function neighborsOf(tiles: TileCoord[]): TileCoord[] {
  const out = new Map<string, TileCoord>();
  for (const [tx, ty] of tiles) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t: TileCoord = [tx + dx, ty + dy];
        const k = tileKey(t);
        if (!isKnown(k)) out.set(k, t);
      }
    }
  }
  return [...out.values()];
}

/** Partition tiles into local-cache hits (handled via `onHit`) and misses. */
async function splitByCache(
  tiles: TileCoord[],
  gen: number,
  onHit: (t: TileCoord, features: RoadFeature[]) => void
): Promise<TileCoord[] | null> {
  const lookups = await Promise.all(
    tiles.map(async (t) => ({ t, hit: await getCachedTile(tileKey(t)) }))
  );
  if (gen !== generation) return null;
  const misses: TileCoord[] = [];
  let anyHit = false;
  for (const { t, hit } of lookups) {
    if (isKnown(tileKey(t))) continue; // state may have moved during the await
    if (hit) {
      onHit(t, hit);
      anyHit = true;
    } else {
      misses.push(t);
    }
  }
  if (anyHit) rebuild();
  return misses;
}

async function loadTiles(tiles: TileCoord[]): Promise<void> {
  const fresh = tiles.filter((t) => !isKnown(tileKey(t)));
  if (fresh.length === 0) return;
  const gen = generation;

  const misses = await splitByCache(fresh, gen, (t, features) => {
    renderFeatures(features);
    renderedTiles.add(tileKey(t));
  });
  if (misses === null) return; // user jumped to a new ZIP mid-flight
  if (misses.length === 0) {
    setStatus(null); // everything came from the local cache
    void preloadTiles(neighborsOf(fresh));
    return;
  }

  misses.forEach((t) => pendingTiles.set(tileKey(t), t));
  if (hoverKey && pendingTiles.has(hoverKey)) {
    hoverKey = null;
    hoverTile = null;
  }
  setStatus('Loading roads…');
  rebuild(); // show the pending-tile overlay immediately
  let failures = 0;
  await Promise.all(
    misses.map(async (t) => {
      try {
        const features = await fetchRoadTile(t);
        if (gen !== generation) return;
        putCachedTile(tileKey(t), features);
        renderFeatures(features);
        renderedTiles.add(tileKey(t));
      } catch (err) {
        console.error(err);
        failures++;
      } finally {
        if (gen === generation) {
          pendingTiles.delete(tileKey(t));
          rebuild();
        }
      }
    })
  );
  if (gen !== generation) return;
  setStatus(failures > 0 ? 'Some areas failed to load — click them to retry' : null);
  // Prefetch the surrounding ring (hidden until clicked) so the next click is
  // instant. Preloads don't cascade: only explicit loads and reveals trigger this.
  void preloadTiles(neighborsOf(fresh));
}

async function preloadTiles(tiles: TileCoord[]): Promise<void> {
  const fresh = tiles.filter((t) => !isKnown(tileKey(t)));
  if (fresh.length === 0) return;
  const gen = generation;

  const misses = await splitByCache(fresh, gen, (t, features) => {
    cachedTiles.set(tileKey(t), { coord: t, features });
  });
  if (misses === null || misses.length === 0) return;

  misses.forEach((t) => pendingTiles.set(tileKey(t), t));
  if (hoverKey && pendingTiles.has(hoverKey)) {
    hoverKey = null;
    hoverTile = null;
  }
  rebuild();
  await Promise.all(
    misses.map(async (t) => {
      try {
        const features = await fetchRoadTile(t);
        if (gen !== generation) return;
        // Hold the data hidden until clicked, and persist it locally.
        putCachedTile(tileKey(t), features);
        cachedTiles.set(tileKey(t), { coord: t, features });
      } catch (err) {
        console.warn('Preload failed:', err);
      } finally {
        if (gen === generation) {
          pendingTiles.delete(tileKey(t));
          rebuild();
        }
      }
    })
  );
}

function tilesAround(lng: number, lat: number): TileCoord[] {
  const [cx, cy] = tileAt(lng, lat);
  const tiles: TileCoord[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) tiles.push([cx + dx, cy + dy]);
  }
  return tiles;
}

async function goToZip(zip: string): Promise<void> {
  setStatus(`Looking up ${zip}…`);
  let location;
  try {
    location = await geocodeZip(zip);
  } catch (err) {
    console.error(err);
    setStatus('ZIP lookup failed — check your connection');
    return;
  }
  if (!location) {
    setStatus(`ZIP ${zip} not found`);
    return;
  }

  placeEl.textContent = location.label;
  generation++;
  renderedTiles.clear();
  pendingTiles.clear();
  cachedTiles.clear();
  byTier = TIERS.map(() => []);
  deck.setProps({
    layers: makeLayers(),
    initialViewState: {
      longitude: location.longitude,
      latitude: location.latitude,
      zoom: 11.5,
      pitch: 50,
      bearing: -15,
      transitionDuration: 1200,
      transitionInterpolator: new FlyToInterpolator(),
    },
  });
  await loadTiles(tilesAround(location.longitude, location.latitude));
}

buildLegend();

const form = document.getElementById('zip-form') as HTMLFormElement;
const input = document.getElementById('zip-input') as HTMLInputElement;
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const zip = input.value.trim();
  if (/^\d{5}$/.test(zip)) {
    void goToZip(zip);
  } else {
    setStatus('Enter a 5-digit ZIP code');
  }
});

void goToZip(DEFAULT_ZIP);
