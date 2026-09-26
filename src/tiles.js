'use strict';

// Kartenkacheln: Zwischenspeicher auf diesem Server
// Jede Kachel wird nur einmal vom Kartenanbieter geholt (max. 2 gleichzeitig, mit eigener Kennung),
// 7 Tage gespeichert und an alle Handys ausgeliefert. Die Handys sprechen dadurch nur mit diesem Server.
// Damit niemand den Server als allgemeinen Kachel-Proxy missbraucht (und OpenStreetMap ihn sperrt),
// gibt es Grenzen: Gebiet, Zoomstufe, Warteschlange, Abrufe pro Stunde und Größe des Speichers.

const fs = require('node:fs');
const path = require('node:path');
const { TILE_DIR, TILE_URL, TILE_CACHE_DAYS, MAP_CENTER, PUBLIC_URL } = require('./config');
const { HttpError, distanceM } = require('./util');
const { state } = require('./store');
const { rateLimit, sessionRole } = require('./http');

const MAX_ZOOM = 18;                  // darüber vergrößert die Karte selbst (maxNativeZoom)
const CENTER_RADIUS_M = 30000;        // Stadtgebiet um die Kartenmitte
const ZONE_MARGIN_M = 5000;           // Rand um jedes Spielfeld
const MAX_QUEUE = 100;                // wartende Abrufe beim Kartenanbieter
const FETCHES_PER_HOUR = 5000;        // Abrufe beim Kartenanbieter pro Stunde (alle Handys zusammen)
const MAX_CACHE_BYTES = (Number(process.env.TILE_CACHE_MAX_MB) || 1000) * 1048576;

const TILE_UA = `manhunt-web/1.0 (selbst gehostetes Schulspiel${PUBLIC_URL ? `; ${PUBLIC_URL}` : ''})`;
const tileInflight = new Map();
const tileQueue = [];
let tileActive = 0;
let budget = { n: 0, reset: 0 };
let cacheBytes = 0;
let fullWarned = false;

const tileSlot = () => new Promise((resolve) => {
  if (tileActive < 2) { tileActive++; resolve(); } else tileQueue.push(resolve);
});
function tileRelease() {
  const next = tileQueue.shift();
  if (next) next(); else tileActive--;
}

const tile2lng = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

// Übersichtskarten (bis Zoom 8) überall; Stadtebene (bis Zoom 16) rund um die Kartenmitte;
// Details im Spielfeld jedes Raums. Die angemeldete Spielleitung darf rund um die Kartenmitte alles (Spielfeld wählen).
function tileAllowed(z, x, y, staff) {
  if (z > MAX_ZOOM) return false;
  if (z <= 8) return true;
  const c = { lat: tile2lat(y + 0.5, z), lng: tile2lng(x + 0.5, z) };
  if ((z <= 16 || staff) && distanceM({ lat: MAP_CENTER[0], lng: MAP_CENTER[1] }, c) < CENTER_RADIUS_M) return true;
  return Object.values(state.rooms).some((r) => {
    const zone = r.settings.zone;
    return zone && distanceM(zone, c) < zone.radius + ZONE_MARGIN_M;
  });
}

function checkBudget() {
  const t = Date.now();
  if (budget.reset < t) budget = { n: 0, reset: t + 3600e3 };
  if (tileQueue.length >= MAX_QUEUE || budget.n >= FETCHES_PER_HOUR) throw new HttpError(503, 'Karte gerade ausgelastet – gleich nochmal versuchen');
  if (cacheBytes >= MAX_CACHE_BYTES) {
    if (!fullWarned) console.warn(`Kartenspeicher voll (${Math.round(cacheBytes / 1048576)} MB) – neue Kacheln werden nicht mehr geholt. TILE_CACHE_MAX_MB erhöhen oder data/tiles leeren.`);
    fullWarned = true;
    throw new HttpError(503, 'Kartenspeicher voll');
  }
  budget.n++;
}

async function fetchTile(z, x, y, file) {
  await tileSlot();
  try {
    const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
    const res = await fetch(url, { headers: { 'User-Agent': TILE_UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Kachel-Server antwortet ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, buf);
    await fs.promises.rename(`${file}.tmp`, file);
    cacheBytes += buf.length;
    return buf;
  } finally {
    tileRelease();
  }
}

async function serveTile(req, res, z, x, y) {
  rateLimit(req, 'tiles', 1500, 60e3);
  if (!(z >= 0 && z <= 19 && x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z)) throw new HttpError(404, 'Keine Kachel');
  const file = path.join(TILE_DIR, String(z), String(x), `${y}.png`);
  let stat = null;
  try { stat = await fs.promises.stat(file); } catch { /* noch nicht im Speicher */ }
  let buf;
  if (stat && Date.now() - stat.mtimeMs < TILE_CACHE_DAYS * 86400e3) {
    buf = await fs.promises.readFile(file);
  } else {
    if (!stat && !tileAllowed(z, x, y, !!sessionRole(req))) throw new HttpError(404, 'Kachel außerhalb des Spielgebiets');
    const key = `${z}/${x}/${y}`;
    try {
      if (!tileInflight.has(key)) {
        checkBudget();
        tileInflight.set(key, fetchTile(z, x, y, file).finally(() => tileInflight.delete(key)));
      }
      buf = await tileInflight.get(key);
    } catch (e) {
      if (!stat) {
        if (e instanceof HttpError) throw e;
        console.error(`Kachel ${key}: ${e.message}`);
        throw new HttpError(502, 'Kachel gerade nicht verfügbar');
      }
      buf = await fs.promises.readFile(file); // eine alte Kachel ist besser als keine
    }
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=604800' });
  res.end(buf);
}

// Kacheln, die 30 Tage niemand mehr gebraucht hat, wieder löschen – und dabei die Größe des Speichers zählen.
// Asynchron, damit der Server währenddessen weiter antwortet.
async function cleanTiles() {
  let files;
  try { files = await fs.promises.readdir(TILE_DIR, { recursive: true }); } catch { return; }
  const limit = Date.now() - 30 * 86400e3;
  let bytes = 0;
  for (const f of files) {
    const full = path.join(TILE_DIR, f);
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs < limit) await fs.promises.unlink(full);
      else bytes += st.size;
    } catch { /* schon weg */ }
  }
  cacheBytes = bytes;
  if (bytes < MAX_CACHE_BYTES) fullWarned = false;
}

function startTileCleanup() {
  cleanTiles();
  setInterval(cleanTiles, 6 * 3600e3);
}

module.exports = { serveTile, startTileCleanup };
