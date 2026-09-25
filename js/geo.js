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

export function mapUrl(p) {
  return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=16/${p.lat}/${p.lon}`;
}
