# Street Hierarchy Explorer

An interactive visualization of any US city's street network, starting from a ZIP code.
All roads render on a single ground plane; hierarchy is shown by color, line width, and
draw order — each higher functional class (collectors, minor arterials, principal
arterials, highways) draws brighter, wider, and on top of the classes below it. The
camera can tilt and rotate for oblique views.

Built with [deck.gl](https://deck.gl) (no framework) + Vite + TypeScript. Street data is
fetched at runtime from OpenStreetMap via the Overpass API; ZIP codes are geocoded with
the free [Zippopotam](https://api.zippopotam.us) API. No API keys required.

## Running

```sh
npm install
npm run dev
```

Opens at http://localhost:5173, centered on downtown Tacoma (98402) by default.

**Controls:**

- Enter a 5-digit ZIP code and hit Go to fly anywhere in the US.
- Click beyond the loaded roads (the dark void at the map's edges) to load that area.
- Drag to pan · right-drag (or Ctrl+drag) to tilt/rotate · scroll to zoom.
- Hover a road for its name and class.

## How loading works

The map is divided into a fixed global grid of 0.05°-degree tiles (`src/overpass.ts`).
Entering a ZIP geocodes it to a centroid and loads the 3×3 tiles around it in one
Overpass request. Clicking an unloaded area loads the tile under the click. Roads are
deduplicated across tiles by OSM way id, and jumping to a new ZIP clears the map and
discards any in-flight loads.

## Tuning

All tier definitions — OSM class mapping, color, line width — live in one constant
array in `src/tiers.ts`. The legend and rendering both derive from it, so edits there
stay consistent everywhere. Tile size lives in `src/overpass.ts` (`TILE_SIZE`).
