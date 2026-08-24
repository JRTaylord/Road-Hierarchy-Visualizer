import { Deck, FlyToInterpolator, type PickingInfo } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { TIERS } from './tiers';
import type { RoadTile } from './types';
import { MAX_DATA_ZOOM } from './roadtiles';
import { geocodeZip, zipForLocation } from './geocode';
import { requestTile, getTileWait, tileKey } from './tilestore';
import { schedulePrefetch } from './prefetch';
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

// Binary-data layers pick by index, not object; the picked path's name lives
// in the names array carried on the sublayer's data, and its tier is encoded
// in the sublayer id.
function getTooltip({ layer, index }: PickingInfo) {
  if (!layer || index < 0) return null;
  const tierMatch = /-tier-(\d+)$/.exec(layer.id);
  if (!tierMatch) return null;
  const data = layer.props.data as { names?: (string | null)[] };
  const name = data.names?.[index] ?? null;
  return {
    html: `<b>${name ?? 'unnamed'}</b><br/>${TIERS[Number(tierMatch[1])].label}`,
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
 * Crossfade — but only where a fade helps. A tile fades in over FADE_MS
 * only when it was genuinely late (the view sat waiting for it) AND it
 * covers ground nothing has rendered before. Refinement swaps at zoom
 * boundaries (an ancestor or descendant already drew this area) and
 * prefetched/cached arrivals appear instantly — fading those reads as
 * flicker, not polish. Fade progress is a function of time only, so each
 * animation frame just needs the TileLayer to re-run renderSubLayers —
 * driven by bumping a counter in updateTriggers while any fade is active.
 */
const FADE_MS = 200;
/** Arrivals faster than this render instantly; only slower ones fade in. */
const LATE_ARRIVAL_MS = 80;
/** Matches the TileLayer's minZoom — no ancestors exist above it. */
const MIN_TILE_ZOOM = 4;

// Which tile areas have ever been drawn this session. `renderedExact` holds
// tiles rendered as themselves; `renderedBelow` marks every ancestor of a
// rendered tile, so a zoomed-out tile knows a descendant already covered it.
const renderedExact = new Set<string>();
const renderedBelow = new Set<string>();

function markRendered(x: number, y: number, z: number): void {
  renderedExact.add(tileKey({ x, y, z }));
  for (let pz = z - 1; pz >= MIN_TILE_ZOOM; pz--) {
    x >>= 1;
    y >>= 1;
    renderedBelow.add(tileKey({ x, y, z: pz }));
  }
}

/** True if this tile's area is already on screen in some form. */
function coveredBefore(x: number, y: number, z: number): boolean {
  const key = tileKey({ x, y, z });
  if (renderedExact.has(key) || renderedBelow.has(key)) return true;
  for (let pz = z - 1; pz >= MIN_TILE_ZOOM; pz--) {
    x >>= 1;
    y >>= 1;
    if (renderedExact.has(tileKey({ x, y, z: pz }))) return true;
  }
  return false;
}

/** Binary PathLayer data for one tier, built once per tile. */
interface TierLayerData {
  length: number;
  startIndices: Uint32Array;
  attributes: { getPath: { value: Float64Array; size: number } };
  names: (string | null)[];
}

interface FadeableTile {
  fadeStart?: number;
  /** Cached so fade frames reuse identical data objects — deck then sees
   * only the opacity change and skips all attribute re-diffing. */
  layerData?: (TierLayerData | null)[];
}

const fadingTiles = new Set<FadeableTile>();
let fadeTick = 0;
let fadeLoopRunning = false;

function ensureFadeLoop(): void {
  if (fadeLoopRunning) return;
  fadeLoopRunning = true;
  const step = (): void => {
    const now = performance.now();
    for (const tile of fadingTiles) {
      if (tile.fadeStart === undefined || now - tile.fadeStart >= FADE_MS) {
        fadingTiles.delete(tile);
      }
    }
    if (!deck) {
      fadeLoopRunning = false;
      return;
    }
    fadeTick++;
    deck.setProps({ layers: [makeRoadsLayer()] });
    if (fadingTiles.size > 0) {
      requestAnimationFrame(step);
    } else {
      // One final render already happened above with every fade at 1.
      fadeLoopRunning = false;
    }
  };
  requestAnimationFrame(step);
}

/** Ease-out fade progress; fadeStart 0 means "never fade" (already 1). */
function fadeAlpha(tile: FadeableTile): number {
  const t = Math.min(1, (performance.now() - (tile.fadeStart ?? 0)) / FADE_MS);
  return 1 - (1 - t) * (1 - t);
}

/**
 * Streams whatever tiles the viewport needs, at a zoom-appropriate level of
 * detail. deck.gl's TileLayer handles visible-tile computation, in-memory
 * caching, and cancelling requests for tiles the view has moved past; the
 * OpenMapTiles schema thins the data automatically at low zoom.
 *
 * Recreated (same id, so deck reuses all state) each fade-animation frame.
 */
function makeRoadsLayer(): TileLayer<RoadTile> {
  return new TileLayer<RoadTile>({
    id: 'roads',
    // z4 is the lowest zoom where OpenFreeMap tiles contain any roads
    // (motorways/trunks); below that the layer keeps serving z4 tiles so
    // zooming way out still shows the highway skeleton instead of nothing.
    minZoom: 4,
    maxZoom: MAX_DATA_ZOOM,
    // 256 biases tile selection one zoom level deeper than the view, so street
    // detail (minor roads appear at z12) arrives a bit ahead of zooming in.
    tileSize: 256,
    // 0 disables deck's own request throttling; the tile store schedules all
    // loads itself, prioritizing visible tiles over speculative prefetches.
    maxRequests: 0,
    getTileData: ({ index, signal }) => requestTile(index, signal),
    // Not an accessor, but a changed trigger still makes the composite layer
    // re-run renderSubLayers, which is all a fade frame needs. (Only the
    // getTileData key would cause tile reloads.)
    updateTriggers: { renderSubLayers: fadeTick },
    renderSubLayers: (props) => {
      const tiers = props.data;
      if (!tiers) return null;
      const tile = props.tile as FadeableTile & { index: { x: number; y: number; z: number } };
      if (tile.fadeStart === undefined) {
        const { x, y, z } = tile.index;
        const late = getTileWait(tileKey(tile.index)) >= LATE_ARRIVAL_MS;
        // 0 = no fade: either the tile was ready when asked for, or its
        // area is already drawn and a fade would flicker the swap.
        tile.fadeStart = late && !coveredBefore(x, y, z) ? performance.now() : 0;
        markRendered(x, y, z);
      }
      const opacity = fadeAlpha(tile);
      if (opacity < 1) {
        fadingTiles.add(tile);
        ensureFadeLoop();
      }
      // Data is pre-tessellated binary from the worker: startIndices + flat
      // positions, with _pathType set so deck skips normalization. The
      // `names` ride along for the pick-by-index tooltip.
      tile.layerData ??= tiers.map((bundle) =>
        bundle.names.length === 0
          ? null
          : {
              length: bundle.names.length,
              startIndices: bundle.startIndices,
              attributes: { getPath: { value: bundle.positions, size: 2 } },
              names: bundle.names,
            }
      );
      const layerData = tile.layerData;
      // One PathLayer per tier so higher classes draw on top with their own
      // minimum pixel widths (keeps the hierarchy readable when zoomed out).
      return TIERS.map((tier, i) => {
        const data = layerData[i];
        if (!data) return null;
        return new PathLayer({
          id: `${props.id}-tier-${i}`,
          data,
          _pathType: 'open',
          opacity,
          getColor: tier.color,
          getWidth: tier.width,
          widthUnits: 'meters',
          widthMinPixels: tier.minPixels,
          capRounded: true,
          jointRounded: true,
          pickable: true,
        });
      });
    },
  });
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
// Right-drag rotates the camera; keep the browser's context menu from
// opening over the canvas when the right button is released.
deckCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Camera floor: view zoom 3 maps to z4 data tiles, the lowest zoom with any
// road content. Ceiling caps diving past the z14 max-detail data.
const VIEW_DEFAULTS = { zoom: 11.5, pitch: 50, bearing: -15, minZoom: 3, maxZoom: 17 };

// The map is created only once the starting location is known, so the first
// view a user sees is their own area rather than a default it pans away from.
let deck: Deck | null = null;

function createDeck(longitude: number, latitude: number): Deck {
  const initialViewState = { longitude, latitude, ...VIEW_DEFAULTS };
  const instance = new Deck({
    canvas: deckCanvas,
    initialViewState,
    controller: { touchRotate: true, inertia: 300 },
    layers: [makeRoadsLayer()],
    // Every camera move (including inertia and fly-to transitions) feeds the
    // predictor, which warms tiles just outside and ahead of the view.
    onViewStateChange: ({ viewState }) => {
      schedulePrefetch(
        viewState as { longitude: number; latitude: number; zoom: number },
        deckCanvas.clientWidth,
        deckCanvas.clientHeight
      );
    },
    // Roads are thin; pick anything within a comfortable radius of the
    // pointer so hovering for names doesn't require pixel-perfect aim.
    pickingRadius: 8,
    getTooltip,
  });
  if (import.meta.env.DEV) {
    // Debug handle for console diagnostics during development.
    (window as unknown as { __deck: Deck }).__deck = instance;
  }
  // Seed the ring around the starting view; interaction hasn't happened yet,
  // so onViewStateChange alone would leave the initial neighborhood cold.
  schedulePrefetch(initialViewState, deckCanvas.clientWidth, deckCanvas.clientHeight);
  return instance;
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
  if (!deck) {
    // First location: start the map right here, no pan-over from a default.
    deck = createDeck(location.longitude, location.latitude);
  } else {
    deck.setProps({
      initialViewState: {
        longitude: location.longitude,
        latitude: location.latitude,
        ...VIEW_DEFAULTS,
        transitionDuration: 1200,
        transitionInterpolator: new FlyToInterpolator(),
      },
    });
  }
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
  if (!deck) {
    // ZIP lookup failed entirely; show the default area rather than nothing.
    deck = createDeck(-122.4443, 47.2529);
  }
})();
