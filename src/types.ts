/**
 * A tile's roads for one tier, in deck.gl's binary PathLayer layout.
 * `positions` is a flat [lng, lat, lng, lat, …] array and `startIndices[i]`
 * is the vertex index where path i begins. Typed arrays make the payload
 * transferable across the worker boundary (zero-copy) and let PathLayer
 * skip per-path normalization entirely.
 */
export interface TierBundle {
  startIndices: Uint32Array;
  /** Float64 keeps lng/lat precision; deck splits into fp64 halves on upload. */
  positions: Float64Array;
  /** Per-path road name for the hover tooltip, aligned with startIndices. */
  names: (string | null)[];
}

/** One decoded road tile: a TierBundle per entry in TIERS, same order. */
export type RoadTile = TierBundle[];
