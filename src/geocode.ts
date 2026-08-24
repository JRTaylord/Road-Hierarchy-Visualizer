export interface ZipLocation {
  latitude: number;
  longitude: number;
  label: string;
}

/**
 * Reverse-geocode coordinates to a US ZIP via BigDataCloud's free client-side
 * API (keyless, made for exactly this). Returns null outside the US or when
 * no 5-digit ZIP can be derived.
 */
export async function zipForLocation(latitude: number, longitude: number): Promise<string | null> {
  const url =
    'https://api.bigdatacloud.net/data/reverse-geocode-client' +
    `?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { postcode?: string; countryCode?: string };
  if (data.countryCode !== 'US') return null;
  const zip = data.postcode?.slice(0, 5);
  return zip && /^\d{5}$/.test(zip) ? zip : null;
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
