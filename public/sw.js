// Service Worker: App-Hülle für Start im Funkloch, Kartenkacheln für die Offline-Karte.
// Spieldaten (/api/…) laufen nie über den Speicher – die müssen immer aktuell sein.

const SHELL = 'mh-shell-v2'; // v2: alte Speicher mit /r/<Schlüssel>-Einträgen werden beim Update gelöscht
const TILES = 'mh-tiles-v1';
const MAX_TILES = 3000;
const SHELL_FILES = [
  '/', '/play', '/datenschutz', '/style.css', '/common.js', '/i18n.js', '/play.js', '/index.js', '/join.js',
  '/datenschutz.js', '/icon.svg', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => { /* Vorabspeichern ist nur ein Bonus */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== TILES) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(url.pathname.startsWith('/tiles/') ? tile(req) : networkFirst(req));
});

// Seiten und Skripte: zuerst aus dem Netz (Updates kommen sofort an), bei Funkloch aus dem Speicher
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    // /r/<Schlüssel> und /j/<Code> werden als /play bzw. gar nicht gespeichert – der Schlüssel gehört nicht in den Speicher
    const p = new URL(req.url).pathname;
    const key = p.startsWith('/r/') ? '/play' : p.startsWith('/j/') ? null : req;
    if (key && res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // z. B. /r/<token> oder /j/<code> ohne Netz: die Spielseite aus dem Speicher
    if (req.mode === 'navigate') return (await cache.match('/play')) || Response.error();
    return Response.error();
  }
}

// Kacheln: zuerst aus dem Speicher (Offline-Karte), sonst laden und merken
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return Response.error();
  }
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}
