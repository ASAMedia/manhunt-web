'use strict';

// Statische Dateien, Web-App-Manifest und robots.txt

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR, LEAFLET_DIR } = require('./config');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const PAGES = {
  '/': 'index.html', '/admin': 'admin.html', '/play': 'play.html', '/print': 'print.html',
  '/datenschutz': 'datenschutz.html', '/hilfe': 'hilfe.html', '/replay': 'replay.html',
};

// Spieler bekommen ein Manifest mit ihrem Wiederbeitritts-Link als Startadresse: Auf dem iPhone hat die
// installierte App einen eigenen Speicher und wüsste sonst nicht, in welchem Spiel man ist.
function manifest(url) {
  const r = url.searchParams.get('r');
  const admin = url.searchParams.get('app') === 'admin';
  const start = admin ? '/admin' : (r && /^[A-Za-z0-9_-]{10,64}$/.test(r) ? `/r/${r}` : '/');
  return {
    id: admin ? '/admin' : '/play',
    name: admin ? 'Manhunt – Spielleitung' : 'Manhunt',
    short_name: admin ? 'Spielleitung' : 'Manhunt',
    start_url: start,
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f1216',
    theme_color: '#d13b3b',
    lang: 'de',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}

function serveManifest(res, url) {
  res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(manifest(url)));
}

// Suchmaschinen sollen nichts von diesem Server aufnehmen
function serveRobots(res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  res.end('User-agent: *\nDisallow: /\n');
}

function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : null;
}

function resolveStatic(pathname) {
  if (Object.hasOwn(PAGES, pathname)) return path.join(PUBLIC_DIR, PAGES[pathname]);
  if (/^\/j\/[A-Za-z0-9]{1,12}$/.test(pathname)) return path.join(PUBLIC_DIR, 'join.html');
  if (/^\/r\/[A-Za-z0-9_-]{10,64}$/.test(pathname)) return path.join(PUBLIC_DIR, 'play.html');
  if (pathname.startsWith('/vendor/leaflet/')) return safeJoin(LEAFLET_DIR, pathname.slice('/vendor/leaflet/'.length));
  return safeJoin(PUBLIC_DIR, pathname.slice(1));
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Methode nicht erlaubt');
  const file = resolveStatic(pathname);
  let stat;
  try { stat = file && fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nicht gefunden');
  }
  const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    ETag: etag,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

module.exports = { serveManifest, serveRobots, serveStatic };
