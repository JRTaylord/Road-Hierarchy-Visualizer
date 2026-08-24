export interface RoadProperties {
  name: string | null;
  highway: string;
}

export interface RoadFeature {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
  properties: RoadProperties;
}

export interface RoadCollection {
  type: 'FeatureCollection';
  features: RoadFeature[];
}
