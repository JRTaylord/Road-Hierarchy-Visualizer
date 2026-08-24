import type { RoadFeature } from './types';

/**
 * Persistent per-tile road cache in IndexedDB. A tile fetched once is served
 * locally forever after (up to MAX_AGE), making revisits instant.
 */

const DB_NAME = 'street-hierarchy-explorer';
const DB_VERSION = 2; // v2: OpenFreeMap features replace Overpass way maps
const STORE = 'tiles';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface TileRecord {
  key: string;
  features: RoadFeature[];
  fetchedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Record shape changed between versions; discard any old data.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    // Cache is an optimization; run without it if IndexedDB is unavailable.
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export async function getCachedTile(key: string): Promise<RoadFeature[] | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => {
      const record = req.result as TileRecord | undefined;
      if (!record || Date.now() - record.fetchedAt > MAX_AGE_MS) {
        resolve(null);
      } else {
        resolve(record.features);
      }
    };
    req.onerror = () => resolve(null);
  });
}

export function putCachedTile(key: string, features: RoadFeature[]): void {
  void openDb().then((db) => {
    if (!db) return;
    const record: TileRecord = { key, features, fetchedAt: Date.now() };
    // Fire-and-forget; a failed write just means a refetch next visit.
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
  });
}
