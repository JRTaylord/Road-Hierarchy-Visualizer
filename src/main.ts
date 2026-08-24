import { Deck, FlyToInterpolator, type PickingInfo } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { TIERS, tierOf } from './tiers';
import type { RoadFeature } from './types';
import { fetchRoadTile, MAX_DATA_ZOOM } from './roadtiles';
import { geocodeZip, zipForLocation } from './geocode';
import { getCachedTile, putCachedTile } from './tilecache';
import './style.css';

const DEFAULT_ZIP = '98402'; // downtown Tacoma

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

/**
 * Streams whatever tiles the viewport needs, at a zoom-appropriate level of
 * detail. deck.gl's TileLayer handles visible-tile computation, in-memory
 * caching, and cancelling requests for tiles the view has moved past; the
 * OpenMapTiles schema thins the data automatically at low zoom.
 */
const roadsLayer = new TileLayer<RoadFeature[]>({
  id: 'roads',
  minZoom: 0,
  maxZoom: MAX_DATA_ZOOM,
  // 256 biases tile selection one zoom level deeper than the view, so street
  // detail (minor roads appear at z12) arrives a bit ahead of zooming in.
  tileSize: 256,
  maxRequests: 8,
  getTileData: async ({ index, signal }) => {
    const key = `${index.z}/${index.x}/${index.y}`;
    const cached = await getCachedTile(key);
    if (cached) return cached;
    const features = await fetchRoadTile(index.x, index.y, index.z, signal ?? undefined);
    if (!signal?.aborted) putCachedTile(key, features);
    return features;
  },
  renderSubLayers: (props) => {
    const features = props.data ?? [];
    const byTier: RoadFeature[][] = TIERS.map(() => []);
    for (const f of features) {
      const tier = tierOf(f);
      if (tier !== undefined) byTier[tier].push(f);
    }
    // One PathLayer per tier so higher classes draw on top with their own
    // minimum pixel widths (keeps the hierarchy readable when zoomed out).
    return TIERS.map(
      (tier, i) =>
        new PathLayer<RoadFeature>({
          id: `${props.id}-tier-${i}`,
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
  },
});

// Supply a pre-sized canvas instead of letting deck create one. Deck creates
// its canvas before layout, seeding luma's CanvasContext with the 300×150
// default; if the ResizeObserver's catch-up delivery then races the async GPU
// device attach, the context stays stuck at that size (blurry rendering,
// broken picking). A canvas that is already laid out and buffer-sized starts
// correct no matter how that race resolves.
const deckCanvas = document.getElementById('deck-canvas') as HTMLCanvasElement;
deckCanvas.width = Math.max(1, Math.round(deckCanvas.clientWidth * window.devicePixelRatio));
deckCanvas.height = Math.max(1, Math.round(deckCanvas.clientHeight * window.devicePixelRatio));
// Right-drag rotates the camera; keep the browser's context menu from
// opening over the canvas when the right button is released.
deckCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

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
  layers: [roadsLayer],
  // Roads are thin; pick anything within a comfortable radius of the pointer
  // so hovering for names doesn't require pixel-perfect aim.
  pickingRadius: 8,
  getTooltip,
});

// Debug handle for console diagnostics during development.
if (import.meta.env.DEV) {
  (window as unknown as { __deck: Deck }).__deck = deck;
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
  setStatus(null);
  deck.setProps({
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

/** Browser position, or null if unsupported, denied, or slow to answer. */
function currentPosition(): Promise<GeolocationCoordinates | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      () => resolve(null),
      { timeout: 8_000, maximumAge: 600_000 }
    );
  });
}

/** Starting ZIP from the browser's location when permitted, else the default. */
async function startingZip(): Promise<string> {
  setStatus('Locating you…');
  const coords = await currentPosition();
  if (!coords) return DEFAULT_ZIP;
  try {
    const zip = await zipForLocation(coords.latitude, coords.longitude);
    if (zip) return zip;
  } catch (err) {
    console.warn('Reverse geocoding failed:', err);
  }
  return DEFAULT_ZIP;
}

void (async () => {
  const zip = await startingZip();
  input.value = zip;
  await goToZip(zip);
})();
