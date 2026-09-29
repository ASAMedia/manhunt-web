'use strict';

// Manhunt – Einstiegspunkt: Server starten und Anfragen verteilen.
// Die eigentliche Arbeit steckt in src/ (Spiellogik, Sichten, Routen, Karten, statische Dateien).

const http = require('node:http');
const config = require('./src/config');
const { HttpError } = require('./src/util');
const store = require('./src/store');
const game = require('./src/game');
const { route, dispatch, sendJson, setSecurityHeaders, translateError, startRateLimitCleanup } = require('./src/http');
const { serveTile, startTileCleanup } = require('./src/tiles');
const { serveManifest, serveRobots, serveStatic } = require('./src/static');

// Routen registrieren
require('./src/routes/admin');
require('./src/routes/player');
require('./src/clientErrors');

route('GET', '/api/health', () => ({ ok: true }));

route('GET', '/api/config', () => ({
  tileUrl: config.TILE_PROXY ? '/tiles/{z}/{x}/{y}.png' : config.TILE_URL,
  tileProxy: config.TILE_PROXY,
  tileAttribution: config.TILE_ATTRIBUTION, mapCenter: config.MAP_CENTER, publicUrl: config.PUBLIC_URL || null,
  autoDeleteDays: config.AUTO_DELETE_DAYS, privacyContact: config.PRIVACY_CONTACT || null,
  privacyController: config.PRIVACY_CONTROLLER || null, privacyHosting: config.PRIVACY_HOSTING || null,
  version: config.VERSION, build: config.BUILD,
}));

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(req, res);
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const tile = config.TILE_PROXY && req.method === 'GET' && /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
    if (tile) return await serveTile(req, res, Number(tile[1]), Number(tile[2]), Number(tile[3]));
    if (pathname === '/manifest.webmanifest') return serveManifest(res, url);
    if (pathname === '/robots.txt') return serveRobots(res);
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (!(await dispatch(req, res, pathname, url))) throw new HttpError(404, 'Unbekannter Endpunkt');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: translateError(req, e.message) });
    if (e instanceof URIError) return sendJson(res, 400, { error: 'Ungültige Adresse' });
    console.error(e);
    sendJson(res, 500, { error: translateError(req, 'Serverfehler') });
  }
});
// Langsame oder hängende Verbindungen nicht ewig offen halten
server.requestTimeout = 30e3;
server.headersTimeout = 20e3;

function shutdown() {
  try { store.saveState(); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

store.loadState(game.migrateRoom);
game.autoDelete();
store.startAutosave();
game.startGameTimers();
startRateLimitCleanup();
startTileCleanup();

server.listen(config.PORT, () => {
  const { PORT, DATA_DIR, AUTO_DELETE_DAYS, PUBLIC_URL, VERSION, BUILD } = config;
  console.log(`Manhunt ${VERSION}${BUILD ? ` (${BUILD})` : ''} läuft auf Port ${PORT} (Daten: ${DATA_DIR})`);
  console.log(AUTO_DELETE_DAYS ? `Räume werden ${AUTO_DELETE_DAYS} Tage nach der letzten Aktivität gelöscht` : 'Automatisches Löschen ist aus');
  if (PUBLIC_URL) console.log(`Öffentliche Adresse: ${PUBLIC_URL}`);
});
