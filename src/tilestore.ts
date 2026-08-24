import { fetchRoadTile } from './roadtiles';
import { getCachedTile, putCachedTile } from './tilecache';
import type { RoadFeature } from './types';

/**
 * Single load path for road tiles, shared by the TileLayer and the
 * predictive prefetcher. Every tile goes through one priority queue:
 * tiles the viewport needs right now always load before speculative
 * ones, and a speculative load that turns out to be needed is promoted
 * rather than fetched twice. Completed tiles stay resolved in memory,
 * so a prefetched tile is served instantly when the layer asks for it.
 *
 * Loads are never aborted once started — tiles are small and a tile the
 * view has moved past is exactly the tile most likely to be needed again,
 * so finishing the download and caching it beats cancelling it.
 */

export interface TileIndex {
  x: number;
  y: number;
  z: number;
}

/** Matches the OpenFreeMap CDN's comfortable per-client concurrency. */
const MAX_CONCURRENT = 16;
/** Resolved tiles kept in memory before the oldest are dropped. */
const MAX_RESOLVED = 512;

const VISIBLE = 0;
const SPECULATIVE = 1;

interface Job {
  key: string;
  index: TileIndex;
  priority: number;
  state: 'queued' | 'running' | 'done';
  promise: Promise<RoadFeature[]>;
  resolve: (features: RoadFeature[]) => void;
  reject: (err: unknown) => void;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

export const tileKey = ({ x, y, z }: TileIndex): string => `${z}/${x}/${y}`;

function enqueue(index: TileIndex, key: string, priority: number): Job {
  let resolve!: (features: RoadFeature[]) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<RoadFeature[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Speculative loads may end up with no consumer (superseded, or failed
  // before anyone needed them); keep their rejections from going unhandled.
  if (priority === SPECULATIVE) promise.catch(() => {});
  const job: Job = { key, index, priority, state: 'queued', promise, resolve, reject };
  jobs.set(key, job);
  queue.push(job);
  pump();
  return job;
}

function pump(): void {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  // Stable sort: visible tiles first, FIFO within a priority.
  queue.sort((a, b) => a.priority - b.priority);
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    job.state = 'running';
    running++;
    void runJob(job);
  }
}

async function runJob(job: Job): Promise<void> {
  try {
    const cached = await getCachedTile(job.key);
    if (cached) {
      job.resolve(cached);
    } else {
      const { x, y, z } = job.index;
      const features = await fetchRoadTile(x, y, z);
      putCachedTile(job.key, features);
      job.resolve(features);
    }
    job.state = 'done';
    trimResolved();
  } catch (err) {
    // Drop the failed job so a later request retries instead of caching the error.
    jobs.delete(job.key);
    job.reject(err);
  } finally {
    running--;
    pump();
  }
}

function trimResolved(): void {
  if (jobs.size <= MAX_RESOLVED) return;
  for (const [key, job] of jobs) {
    if (jobs.size <= MAX_RESOLVED) return;
    if (job.state === 'done') jobs.delete(key);
  }
}

/** Load a tile the viewport needs now. Promotes a queued speculative load. */
export function requestTile(index: TileIndex): Promise<RoadFeature[]> {
  const key = tileKey(index);
  const job = jobs.get(key);
  if (job) {
    if (job.state === 'queued') job.priority = VISIBLE;
    if (job.state === 'done') {
      // Refresh insertion order so trimResolved evicts least-recently-used.
      jobs.delete(key);
      jobs.set(key, job);
    }
    return job.promise;
  }
  return enqueue(index, key, VISIBLE).promise;
}

/**
 * Replace the speculative wishlist. Tiles already loaded, loading, or queued
 * are kept; queued speculative tiles the new prediction no longer wants are
 * dropped so stale guesses never compete with fresh ones for bandwidth.
 */
export function prefetchTiles(indices: TileIndex[]): void {
  const wanted = new Set(indices.map(tileKey));
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (job.priority === SPECULATIVE && !wanted.has(job.key)) {
      queue.splice(i, 1);
      jobs.delete(job.key);
      job.reject(new Error('prefetch superseded'));
    }
  }
  for (const index of indices) {
    const key = tileKey(index);
    if (!jobs.has(key)) enqueue(index, key, SPECULATIVE);
  }
}
