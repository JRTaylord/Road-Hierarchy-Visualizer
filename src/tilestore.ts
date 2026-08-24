import type { RoadTile } from './types';
import type { TileWorkRequest, TileWorkResponse } from './tileworker';

/**
 * Single load path for road tiles, shared by the TileLayer and the
 * predictive prefetcher. Every tile goes through one priority queue:
 * tiles the viewport needs right now always load before speculative
 * ones, and a speculative load that turns out to be needed is promoted
 * rather than fetched twice.
 *
 * The heavy lifting (cache read, fetch, decode) happens in a Web Worker,
 * and finished tiles are handed to deck.gl at a metered pace — a couple
 * per animation frame — so crossing a tile-zoom boundary (where the whole
 * viewport needs a new tile set at once) fills in progressively instead
 * of freezing the frame while every tile tessellates in one go.
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
/**
 * Per-frame delivery time budget. The measurable cost of a delivery is the
 * promise-reaction work that runs in the microtask flush right after the
 * resolves (TileLayer content assignment and update bookkeeping); deck's
 * actual GPU upload happens later in its own render pass and can't be
 * observed from here, so the batch size adapts to what we *can* measure and
 * the budget is kept conservative to leave frame headroom for the rest.
 */
const FRAME_BUDGET_MS = 4;
const MIN_BATCH = 1;
const MAX_BATCH = 16;
/** Tiles delivered per drain; adapts to the measured cost of recent drains. */
let deliverBatch = 4;

const VISIBLE = 0;
const SPECULATIVE = 1;

interface Job {
  id: number;
  key: string;
  index: TileIndex;
  priority: number;
  state: 'queued' | 'loading' | 'ready' | 'done';
  tile: RoadTile | null;
  promise: Promise<RoadTile>;
  resolve: (tile: RoadTile) => void;
  reject: (err: unknown) => void;
}

/** One pending hand-off to a consumer awaiting a tile's features. */
interface Delivery {
  job: Job;
  resolve: (tile: RoadTile) => void;
}

const jobs = new Map<string, Job>();
const jobsById = new Map<number, Job>();
const queue: Job[] = [];
const ready: Delivery[] = [];
let loading = 0;
let nextId = 1;
let drainScheduled = false;

export const tileKey = ({ x, y, z }: TileIndex): string => `${z}/${x}/${y}`;

if (import.meta.env.DEV) {
  // Debug handle for console diagnostics during development.
  (window as unknown as { __tilestore: unknown }).__tilestore = {
    stats: () => ({
      jobs: jobs.size,
      queued: queue.length,
      ready: ready.length,
      loading,
      drainScheduled,
      deliverBatch,
      byState: [...jobs.values()].reduce<Record<string, number>>((acc, j) => {
        acc[j.state] = (acc[j.state] ?? 0) + 1;
        return acc;
      }, {}),
    }),
  };
}

const worker = new Worker(new URL('./tileworker.ts', import.meta.url), { type: 'module' });

worker.onmessage = (e: MessageEvent<TileWorkResponse>) => {
  const job = jobsById.get(e.data.id);
  if (!job) return;
  jobsById.delete(job.id);
  loading--;
  if ('error' in e.data) {
    // Drop the failed job so a later request retries instead of caching the error.
    jobs.delete(job.key);
    job.reject(new Error(e.data.error));
  } else {
    job.state = 'ready';
    job.tile = e.data.tile;
    ready.push({ job, resolve: job.resolve });
    scheduleDrain();
  }
  pump();
};

worker.onerror = (e: ErrorEvent) => {
  // A dead worker would strand every in-flight tile as a silent hang;
  // fail them loudly so the layer's error path reports something useful.
  console.error('tile worker error:', e.message);
  for (const job of jobsById.values()) {
    jobs.delete(job.key);
    job.reject(new Error(`tile worker failed: ${e.message}`));
  }
  jobsById.clear();
  loading = 0;
};

function enqueue(index: TileIndex, key: string, priority: number): Job {
  let resolve!: (tile: RoadTile) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<RoadTile>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Speculative loads may end up with no consumer (superseded, or failed
  // before anyone needed them); keep their rejections from going unhandled.
  if (priority === SPECULATIVE) promise.catch(() => {});
  const job: Job = {
    id: nextId++,
    key,
    index,
    priority,
    state: 'queued',
    tile: null,
    promise,
    resolve,
    reject,
  };
  jobs.set(key, job);
  queue.push(job);
  pump();
  return job;
}

function pump(): void {
  if (loading >= MAX_CONCURRENT || queue.length === 0) return;
  // Stable sort: visible tiles first, FIFO within a priority.
  queue.sort((a, b) => a.priority - b.priority);
  while (loading < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    job.state = 'loading';
    loading++;
    jobsById.set(job.id, job);
    const request: TileWorkRequest = { id: job.id, key: job.key, ...job.index };
    worker.postMessage(request);
  }
}

/**
 * Hand finished tiles to their consumers a few per frame. Resolving a tile
 * the TileLayer awaits triggers synchronous PathLayer tessellation, so
 * delivering a whole zoom level's worth in one frame is what caused the
 * hitch this metering exists to prevent.
 */
let drainRaf = 0;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDrain(): void {
  if (drainScheduled || ready.length === 0) return;
  drainScheduled = true;
  // rAF paces delivery to the render loop, but Chrome suspends rAF entirely
  // in hidden or occluded windows — a timer races it so delivery always
  // makes progress; whichever fires first cancels the other.
  drainRaf = requestAnimationFrame(runDrain);
  drainTimer = setTimeout(runDrain, 50);
}

function runDrain(): void {
  cancelAnimationFrame(drainRaf);
  if (drainTimer !== null) clearTimeout(drainTimer);
  drainTimer = null;
  drain();
}

function drain(): void {
  drainScheduled = false;
  // Visible tiles first: a promoted tile un-blanks the map; a speculative
  // one just warms the cache.
  ready.sort((a, b) => a.job.priority - b.job.priority);
  const batch = ready.splice(0, deliverBatch);
  const start = performance.now();
  for (const { job, resolve } of batch) {
    job.state = 'done';
    resolve(job.tile!);
  }
  // The resolves' promise reactions run before this microtask, so `cost`
  // includes them. Halve the batch when over budget, creep up when well
  // under — an AIMD controller that converges near the frame budget.
  queueMicrotask(() => {
    const cost = performance.now() - start;
    if (cost > FRAME_BUDGET_MS) {
      deliverBatch = Math.max(MIN_BATCH, Math.floor(deliverBatch / 2));
    } else if (cost < FRAME_BUDGET_MS / 2 && deliverBatch < MAX_BATCH) {
      deliverBatch += 1;
    }
  });
  trimResolved();
  scheduleDrain();
}

function trimResolved(): void {
  if (jobs.size <= MAX_RESOLVED) return;
  for (const [key, job] of jobs) {
    if (jobs.size <= MAX_RESOLVED) return;
    if (job.state === 'done') jobs.delete(key);
  }
}

/** Load a tile the viewport needs now. Promotes a queued speculative load. */
export function requestTile(index: TileIndex, signal?: AbortSignal | null): Promise<RoadTile> {
  const key = tileKey(index);
  let job = jobs.get(key);
  let promise: Promise<RoadTile>;
  if (job) {
    // Promotion matters both in the load queue and the delivery queue.
    if (job.state !== 'done') {
      job.priority = VISIBLE;
      promise = job.promise;
    } else {
      // Refresh insertion order so trimResolved evicts least-recently-used.
      jobs.delete(key);
      jobs.set(key, job);
      // Warm hits are metered like fresh loads: handing deck.gl a whole
      // cached zoom level in one already-resolved microtask flush would
      // tessellate it all in a single frame — the hitch, back again.
      job.priority = VISIBLE;
      const fixed = job;
      promise = new Promise((resolve) => {
        ready.push({ job: fixed, resolve });
        scheduleDrain();
      });
    }
  } else {
    job = enqueue(index, key, VISIBLE);
    promise = job.promise;
  }
  if (signal) {
    const aborted = job;
    signal.addEventListener(
      'abort',
      () => {
        // The view moved past this tile mid-flight. Let it finish for the
        // cache, but demote it so it stops delaying tiles the view needs —
        // without this, sprinting through several zoom levels queues every
        // intermediate level's tiles ahead of the level you stop at.
        if (aborted.state !== 'done') aborted.priority = SPECULATIVE;
        // Its consumer is gone; a later failure would otherwise be unhandled.
        aborted.promise.catch(() => {});
      },
      { once: true }
    );
  }
  return promise;
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
