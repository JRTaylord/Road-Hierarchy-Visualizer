export interface RoadProperties {
  name: string | null;
  /** OpenMapTiles transportation class (motorway, trunk, primary, …, minor). */
  class: string;
}

export interface RoadFeature {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
  properties: RoadProperties;
}
