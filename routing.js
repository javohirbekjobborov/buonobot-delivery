// Yo'l (marshrut) masofasi: OSRM — OpenStreetMap yo'llari bo'yicha avtomobil marshruti.
// OSRM javob bermasa: havo masofasi × ROUTE_FALLBACK_FACTOR (taxminiy, approx=true).
// Hujjat: https://project-osrm.org/docs/v5.24.0/api/#route-service
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const FALLBACK_FACTOR = parseFloat(process.env.ROUTE_FALLBACK_FACTOR || '1.35');
const TIMEOUT_MS = parseInt(process.env.ROUTE_TIMEOUT_MS || '4000');
// Ochiq OSRM serveri qoidasi: sekundiga 1 tadan ko'p so'rov yubormaslik
const MIN_GAP_MS = parseInt(process.env.ROUTE_MIN_GAP_MS || '1100');
const CACHE_TTL_MS = 6 * 3600 * 1000;

const cache = new Map();
let queue = Promise.resolve();
let lastCallAt = 0;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// So'rovlarni navbat bilan, kamida MIN_GAP_MS oraliqda yuboramiz
function throttle() {
  const turn = queue.then(async () => {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  queue = turn.catch(() => {});
  return turn;
}

async function osrmMeters(fromLat, fromLng, toLat, toLng) {
  await throttle();
  const url = OSRM_URL + '/route/v1/driving/' + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat +
    '?overview=false&alternatives=false&steps=false';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BuonoBotDelivery/1.0 (Node.js)' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const d = data && data.code === 'Ok' && data.routes && data.routes[0] ? data.routes[0].distance : NaN;
    if (!(d >= 0)) throw new Error('osrm ' + (data && data.code));
    return d;
  } finally {
    clearTimeout(timer);
  }
}

// Restorandan nuqtagacha yo'l masofasi: {meters, approx}
async function routeMeters(fromLat, fromLng, toLat, toLng) {
  const key = [fromLat, fromLng, toLat, toLng].map(v => Number(v).toFixed(5)).join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { meters: hit.meters, approx: false };
  try {
    const meters = await osrmMeters(fromLat, fromLng, toLat, toLng);
    cache.set(key, { meters, at: Date.now() });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return { meters, approx: false };
  } catch (e) {
    console.warn('[route] OSRM javob bermadi, taxminiy masofa:', e.name === 'AbortError' ? 'timeout' : e.message);
    return { meters: haversineMeters(fromLat, fromLng, toLat, toLng) * FALLBACK_FACTOR, approx: true };
  }
}

module.exports = { routeMeters, haversineMeters, FALLBACK_FACTOR };
