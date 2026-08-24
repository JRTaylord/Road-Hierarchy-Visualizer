import { fetchRoadTile } from './roadtiles';
import { getCachedTile, putCachedTile } from './tilecache';
import type { RoadFeature } from './types';

/**
 * Web Worker owning the entire tile load path: IndexedDB cache read, network
 * fetch, MVT decode (the expensive part — per-vertex name indexing), and
 * cache write. The main thread only ever sees ready-to-render feature
 * arrays, so a burst of heavy tiles can no longer freeze interaction.
 */

export interface TileWorkRequest {
  id: number;
  key: string;
  x: number;
  y: number;
  z: number;
}

export type TileWorkResponse =
  | { id: number; features: RoadFeature[] }
  | { id: number; error: string };

// The project compiles against DOM types; a minimal local view of the worker
// global avoids pulling the conflicting webworker lib into the whole program.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<TileWorkRequest>) => void) | null;
  postMessage(msg: TileWorkResponse): void;
};

scope.onmessage = async (e) => {
  const { id, key, x, y, z } = e.data;
  try {
    const cached = await getCachedTile(key);
    if (cached) {
      scope.postMessage({ id, features: cached });
      return;
    }
    const features = await fetchRoadTile(x, y, z);
    putCachedTile(key, features);
    scope.postMessage({ id, features });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
