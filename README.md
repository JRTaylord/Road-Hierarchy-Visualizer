# Street Hierarchy Explorer

An interactive visualization of any US city's street network, starting from a ZIP code.
All roads render on a single ground plane; hierarchy is shown by color, line width, and
draw order — each higher functional class (collectors, minor arterials, principal
arterials, highways) draws brighter, wider, and on top of the classes below it. The
camera can tilt and rotate for oblique views.

Built with [deck.gl](https://deck.gl) (no framework) + Vite + TypeScript. Street data
comes from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema,
sourced from OpenStreetMap) — free, keyless, CDN-backed, no rate limits. ZIP codes are
geocoded with the free [Zippopotam](https://api.zippopotam.us) API.

**Live:** https://jrtaylord.github.io/Road-Hierarchy-Visualizer/ — deployed to GitHub
Pages by `.github/workflows/deploy.yml` on every push to master. Visitor counts are
tracked with [GoatCounter](https://road-hierarchy-visualizer.goatcounter.com)
(privacy-friendly,
no cookies; localhost visits aren't counted).

## Running

```sh
npm install
npm run dev
```

Opens at http://localhost:5173. On startup the app asks for browser geolocation; if
granted, your coordinates are reverse-geocoded to a starting ZIP (via BigDataCloud's
free client API — your coordinates are sent only there, only for this lookup). If
permission is denied, times out, or you're outside the US, it falls back to downtown
Tacoma (98402).

**Controls:**

- Enter a 5-digit ZIP code and hit Go to fly anywhere in the US.
- Roads stream in automatically as you pan and zoom.
- Drag to pan · right-drag (or Ctrl+drag) to tilt/rotate · scroll to zoom.
- Hover a road for its name and class.

## How loading works

deck.gl's `TileLayer` streams whatever tiles the viewport needs, at a zoom-appropriate
level of detail: it computes visible tiles, caches them in memory, and cancels requests
the view has moved past. Tiles are OpenFreeMap protobufs decoded in the browser with
`@mapbox/vector-tile` (`src/roadtiles.ts`); the tile URL template is discovered from
TileJSON at runtime because it contains a dated snapshot path. Level of detail comes
free from the OpenMapTiles schema — low-zoom tiles only contain major road classes
(motorways from ~z6, primaries from ~z7, minor roads from z12), so zoomed-out views are
lightweight and street detail appears as you zoom in. Every fetched tile also persists
in IndexedDB for 30 days (`src/tilecache.ts`), so revisited areas load with no network
at all.

Road classes map to tiers in `src/tiers.ts` (OpenMapTiles `transportation` classes:
minor → local streets, tertiary → collectors, secondary → minor arterials, primary →
principal arterials, motorway/trunk → highways; service roads and paths are excluded).
Street names live in the separate `transportation_name` layer; road features inherit a
name from any shared vertex with that layer, falling back to the route ref (e.g.
"WA 16").

## Note on canvas sizing

`index.html` supplies a pre-sized `<canvas>` to Deck rather than letting it create one.
Deck-created canvases are seeded before layout with the browser's 300×150 default, and
a luma.gl v9 init race (ResizeObserver delivery vs. async GPU device attach) can leave
the drawing buffer stuck at that size — blurry rendering and broken hover picking. A
canvas that is already laid out and buffer-sized starts correct regardless of how that
race resolves.

## Tuning

All tier definitions — class mapping, color, line width — live in one constant array in
`src/tiers.ts`. The legend and rendering both derive from it, so edits there stay
consistent everywhere. The app tile zoom and data tile zoom live in `src/roadtiles.ts`.
