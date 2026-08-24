import type { RoadFeature } from './types';

/**
 * Persistent per-tile road cache in IndexedDB. A tile fetched from Overpass
 * once is served locally forever after (up to MAX_AGE), making revisits
 * instant and keeping load off the public Overpass instances.
 */

const DB_NAME = 'street-hierarchy-explorer';
const STORE = 'tiles';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface TileRecord {
  key: string;
  ways: [number, RoadFeature][];
  fetchedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    // Cache is an optimization; run without it if IndexedDB is unavailable.
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function getCachedTile(key: string): Promise<Map<number, RoadFeature> | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => {
      const record = req.result as TileRecord | undefined;
      if (!record || Date.now() - record.fetchedAt > MAX_AGE_MS) {
        resolve(null);
      } else {
        resolve(new Map(record.ways));
      }
    };
    req.onerror = () => resolve(null);
  });
}

export function putCachedTile(key: string, ways: Map<number, RoadFeature>): void {
  void openDb().then((db) => {
    if (!db) return;
    const record: TileRecord = { key, ways: [...ways], fetchedAt: Date.now() };
    // Fire-and-forget; a failed write just means a refetch next visit.
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
  });
}
