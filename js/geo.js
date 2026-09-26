// Position, reverse geocoding (OpenStreetMap Nominatim) and road distance (OSRM).
// A web app can only read GPS while it is open, so positions are captured at
// start, at each change of transport, and at the end of a trip.

export function getPosition({ timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: 'Geolocation not supported' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (err) => resolve({ error: err.message || 'Position unavailable' }),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

function shortAddress(a) {
  if (!a) return '';
  const street = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(' ');
  const poi = a.aeroway || a.railway || a.amenity || a.tourism || a.building;
  const city = a.city || a.town || a.village || a.municipality || a.suburb;
  return [poi, street, city].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
}

export async function reverseGeocode(lat, lon) {
  if (!navigator.onLine) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    return shortAddress(json.address) || json.display_name || null;
  } catch {
    return null;
  }
}

// Driving distance between two points in km, or null if offline / not found.
export async function roadDistanceKm(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const m = json.routes?.[0]?.distance;
    return Number.isFinite(m) ? Math.round(m / 100) / 10 : null;
  } catch {
    return null;
  }
}

// Place name → { lat, lon, name } via OpenStreetMap Nominatim, or null.
export async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const [hit] = await res.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), name: hit.display_name?.split(',').slice(0, 2).join(',') || query } : null;
}

// Driving route with its shape: { coords: [[lon, lat], ...], km }.
export async function drivingRoute(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error('No route found');
  return { coords: route.geometry.coordinates, km: route.distance / 1000 };
}

// OpenStreetMap Overpass query → elements. Tries a second public server if the first is busy.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export async function overpass(query) {
  let lastError;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return (await res.json()).elements || [];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function mapUrl(p) {
  return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=16/${p.lat}/${p.lon}`;
}
