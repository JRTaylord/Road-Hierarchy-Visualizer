export interface ZipLocation {
  latitude: number;
  longitude: number;
  label: string;
}

/** Geocode a US ZIP code to its centroid via the free Zippopotam API. */
export async function geocodeZip(zip: string): Promise<ZipLocation | null> {
  const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    places?: { latitude: string; longitude: string; 'place name': string; 'state abbreviation': string }[];
  };
  const place = data.places?.[0];
  if (!place) return null;
  return {
    latitude: parseFloat(place.latitude),
    longitude: parseFloat(place.longitude),
    label: `${place['place name']}, ${place['state abbreviation']} ${zip}`,
  };
}
