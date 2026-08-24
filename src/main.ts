import { Deck, FlyToInterpolator, type PickingInfo } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { TIERS, tierOf } from './tiers';
import type { RoadFeature } from './types';
import { fetchRoadTiles, geocodeZip, tileAt, tileKey, type TileCoord } from './overpass';
import './style.css';

const DEFAULT_ZIP = '98402'; // downtown Tacoma

const loadedTiles = new Set<string>();
const pendingTiles = new Set<string>();
const seenWays = new Set<number>();
let byTier: RoadFeature[][] = TIERS.map(() => []);
// Bumped when the user jumps to a new ZIP so stale in-flight loads get discarded.
let generation = 0;

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
  const tierLabel = tierIndex !== undefined ? TIERS[tierIndex].label : object.properties.highway;
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

function makeLayers() {
  return TIERS.map(
    (tier, i) =>
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
  );
}

const deck = new Deck({
  parent: document.getElementById('app') as HTMLDivElement,
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
  onClick: (info) => {
    if (info.coordinate) {
      const [lng, lat] = info.coordinate;
      void loadTiles([tileAt(lng, lat)]);
    }
  },
});

async function loadTiles(tiles: TileCoord[]): Promise<void> {
  const fresh = tiles.filter((t) => {
    const key = tileKey(t);
    return !loadedTiles.has(key) && !pendingTiles.has(key);
  });
  if (fresh.length === 0) return;

  const gen = generation;
  fresh.forEach((t) => pendingTiles.add(tileKey(t)));
  setStatus('Loading roads…');
  try {
    const ways = await fetchRoadTiles(fresh);
    if (gen !== generation) return; // user jumped to a new ZIP mid-flight

    const added: RoadFeature[][] = TIERS.map(() => []);
    for (const [id, feature] of ways) {
      if (seenWays.has(id)) continue;
      seenWays.add(id);
      const tier = tierOf(feature);
      if (tier !== undefined) added[tier].push(feature);
    }
    byTier = byTier.map((arr, i) => (added[i].length > 0 ? arr.concat(added[i]) : arr));
    deck.setProps({ layers: makeLayers() });
    fresh.forEach((t) => loadedTiles.add(tileKey(t)));
    setStatus(null);
  } catch (err) {
    console.error(err);
    if (gen === generation) setStatus('Failed to load roads — click again to retry');
  } finally {
    fresh.forEach((t) => pendingTiles.delete(tileKey(t)));
  }
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
  loadedTiles.clear();
  pendingTiles.clear();
  seenWays.clear();
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
