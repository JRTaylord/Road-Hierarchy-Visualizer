import { fetchRoadTile } from './roadtiles';
import { getCachedTile, putCachedTile } from './tilecache';
import type { RoadTile } from './types';

/**
 * Web Worker owning the entire tile load path: IndexedDB cache read, network
 * fetch, MVT decode (the expensive part — per-vertex name indexing), and
 * cache write. Results are binary tier bundles whose buffers are transferred
 * — not cloned — to the main thread, so delivery cost there is near zero.
 */

export interface TileWorkRequest {
  id: number;
  key: string;
  x: number;
  y: number;
  z: number;
}

export type TileWorkResponse =
  | { id: number; tile: RoadTile }
  | { id: number; error: string };

// The project compiles against DOM types; a minimal local view of the worker
// global avoids pulling the conflicting webworker lib into the whole program.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<TileWorkRequest>) => void) | null;
  postMessage(msg: TileWorkResponse, transfer?: Transferable[]): void;
};

/** Every distinct buffer in the payload, for zero-copy transfer. */
function buffersOf(tile: RoadTile): Transferable[] {
  const out: Transferable[] = [];
  for (const bundle of tile) {
    out.push(bundle.startIndices.buffer, bundle.positions.buffer);
  }
  return out;
}

scope.onmessage = async (e) => {
  const { id, key, x, y, z } = e.data;
  try {
    const cached = await getCachedTile(key);
    if (cached) {
      scope.postMessage({ id, tile: cached }, buffersOf(cached));
      return;
    }
    const tile = await fetchRoadTile(x, y, z);
    // IndexedDB put() clones synchronously, so transferring the buffers
    // away immediately afterwards is safe.
    putCachedTile(key, tile);
    scope.postMessage({ id, tile }, buffersOf(tile));
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
