'use strict';

// HTTP-Grundlagen: JSON, Cookies, Rate-Limits, Anmeldung, Router, CSV, Sicherheits-Header, Übersetzung von Fehlern

const crypto = require('node:crypto');
const net = require('node:net');
const { TRUST_PROXY, TILE_PROXY, PUBLIC_URL, SESSION_SECRET, ADMIN_PASSWORD, SUPERVISOR_PASSWORD } = require('./config');
const { HttpError } = require('./util');
const { state, tokenIndex } = require('./store');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new HttpError(413, 'Anfrage zu groß');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* kaputtes Cookie ignorieren */ }
  }
  return out;
}

function isHttps(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-proto']) return req.headers['x-forwarded-proto'].split(',')[0].trim() === 'https';
  return PUBLIC_URL.startsWith('https://');
}

// Hinter einem Proxy (Caddy, Cloudflare-Tunnel, nginx) zählt der letzte Eintrag in X-Forwarded-For:
// den hängt der eigene Proxy an. Weiter links stehende Einträge kann der Client frei erfinden.
function clientIp(req) {
  if (TRUST_PROXY) {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
    if (net.isIP(ip)) return ip;
  }
  return req.socket.remoteAddress || '?';
}

// --- Rate-Limits (pro IP und Zweck) ---------------------------------------------

const buckets = new Map();
const MAX_BUCKETS = 20000; // Obergrenze, damit viele (gefälschte) Absender den Speicher nicht füllen

// Zählt Versuche unter einem beliebigen Schlüssel (IP, Spieler …)
function limitKey(k, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(k);
  if (!b || b.reset < t) {
    if (!b && buckets.size >= MAX_BUCKETS) {
      for (const [key, x] of buckets) if (x.reset < t) buckets.delete(key);
      if (buckets.size >= MAX_BUCKETS) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten.');
    }
    buckets.set(k, (b = { n: 0, reset: t + windowMs }));
  }
  if (++b.n > max) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten.');
}

const rateLimit = (req, key, max, windowMs) => limitKey(`${key}:${clientIp(req)}`, max, windowMs);

function startRateLimitCleanup() {
  setInterval(() => {
    const t = Date.now();
    for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
  }, 60e3);
}

// --- Anmeldung -------------------------------------------------------------------

// Admin-Sitzung: signiertes Cookie. Der Schlüssel hängt auch an den Passwörtern –
// wer ein Passwort ändert, meldet damit alle alten Sitzungen ab.
const SIGN_KEY = crypto.createHash('sha256').update(`${SESSION_SECRET}|${ADMIN_PASSWORD}|${SUPERVISOR_PASSWORD}`).digest();
const sign = (v) => crypto.createHmac('sha256', SIGN_KEY).update(v).digest('base64url');

function safeEqual(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}

// Rolle aus dem signierten Sitzungs-Cookie: 'admin' (Spielleitung), 'supervisor' (Aufsicht) oder null
function sessionRole(req) {
  const [role, exp, sig] = (parseCookies(req).mh_admin || '').split('.');
  if (!['admin', 'supervisor'].includes(role) || !sig || !(Number(exp) > Date.now())) return null;
  if (role === 'supervisor' && !SUPERVISOR_PASSWORD) return null;
  return safeEqual(sig, sign(`${role}.${exp}`)) ? role : null;
}

function setAdminCookie(req, res, value, maxAgeSec) {
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mh_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`);
}

// requireAdmin: nur Spielleitung. requireStaff: Spielleitung oder Aufsicht (ansehen, Notfälle, Nachrichten).
function requireRole(req, allowSupervisor) {
  const role = sessionRole(req);
  if (!role) throw new HttpError(401, 'Bitte als Spielleitung anmelden.');
  if (role === 'supervisor' && !allowSupervisor) throw new HttpError(403, 'Das darf nur die Spielleitung.');
  // Schutz gegen Cross-Site-Requests: nur eigene fetch()-Aufrufe setzen diesen Header
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'manhunt') throw new HttpError(403, 'Ungültige Anfrage');
  return role;
}
const requireAdmin = (req) => requireRole(req, false);
const requireStaff = (req) => requireRole(req, true);

function getRoom(id) {
  const room = Object.hasOwn(state.rooms, id) ? state.rooms[id] : null;
  if (!room) throw new HttpError(404, 'Raum nicht gefunden');
  return room;
}

function getRoomPlayer(room, pid) {
  const p = Object.hasOwn(room.players, pid) ? room.players[pid] : null;
  if (!p) throw new HttpError(404, 'Gerät nicht gefunden');
  return p;
}

function authPlayer(req) {
  const token = req.headers['x-player-token'];
  const ref = token && tokenIndex.get(token);
  const room = ref && state.rooms[ref.roomId];
  const p = room && room.players[ref.playerId];
  if (!p) throw new HttpError(401, 'Du bist in keinem Spiel angemeldet.');
  return { room, p };
}

// --- Router ------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, re, handler });
}

// true, wenn eine Route gepasst hat (Antwort ist dann geschrieben)
async function dispatch(req, res, pathname, url) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const result = await r.handler(req, res, m.groups || {}, url);
    if (!res.headersSent) sendJson(res, 200, result);
    return true;
  }
  return false;
}

const BOM = String.fromCharCode(0xfeff);

// --- CSV-Export (Semikolon + BOM, damit Excel Umlaute und Spalten richtig erkennt) ---

function sendCsv(res, filename, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    // Schutz vor Formeln in Excel (Namen wie "=HYPERLINK(...)")
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = BOM + `${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const csvTime = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '');
// Dateiname nur aus ASCII, damit der Download-Header in allen Browsern funktioniert
const fileSafe = (s) => s
  .replace(/[äÄöÖüÜß]/g, (c) => ({ ä: 'ae', Ä: 'Ae', ö: 'oe', Ö: 'Oe', ü: 'ue', Ü: 'Ue', ß: 'ss' })[c])
  .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'raum';

// --- Sicherheits-Header -------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), screen-wake-lock=(self), camera=(), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${TILE_PROXY ? '' : ' https:'}`, "connect-src 'self'", "frame-ancestors 'none'",
    "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Das Spiel soll in keiner Suchmaschine auftauchen
  'X-Robots-Tag': 'noindex, nofollow',
};

function setSecurityHeaders(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // Nur bei HTTPS: Browser merken sich, die Seite nie mehr unverschlüsselt aufzurufen (180 Tage)
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

// --- Fehlermeldungen für Spieler auf Englisch (X-Lang: en) ------------------------------

const EN_ERRORS = {
  'Du bist in keinem Spiel angemeldet.': 'You are not in a game.',
  'Spiel nicht gefunden – Code prüfen.': 'Game not found – please check the code.',
  'Der Beitritt ist geschlossen. Frag die Spielleitung.': 'Joining is closed. Ask the game master.',
  'Bitte einen Namen eingeben.': 'Please enter a name.',
  'Dieser Name ist schon vergeben.': 'This name is already taken.',
  'Der Raum ist voll.': 'The game is full.',
  'Das Spiel läuft gerade nicht.': 'The game is not running.',
  'Nur Gejagte können gefangen werden.': 'Only runners can be caught.',
  'Nur Jäger können Extra-Pings auslösen.': 'Only hunters can trigger extra pings.',
  'Während des Vorsprungs gibt es keine Pings.': 'There are no pings during the head start.',
  'Keine Extra-Pings mehr übrig.': 'No extra pings left.',
  'Umbenennen geht nur vor dem Spiel.': 'You can only rename before the game starts.',
  'Gejagte können das laufende Spiel nicht verlassen – melde dich bei der Spielleitung.': 'Runners cannot leave a running game – please contact the game master.',
  'Verkehrsmittel-Meldungen sind in diesem Spiel aus.': 'Transport reports are turned off in this game.',
  'Nur Gejagte melden im laufenden Spiel ihr Verkehrsmittel.': 'Only runners report their transport during the game.',
  'Unbekanntes Verkehrsmittel': 'Unknown means of transport',
  'Nur Gejagte können im laufenden Spiel blocken.': 'Only runners can block during the game.',
  'Der nächste Ping ist schon blockiert.': 'The next ping is already blocked.',
  'Keine Blocks mehr übrig.': 'No blocks left.',
  'Zu viele Versuche – bitte kurz warten.': 'Too many attempts – please wait a moment.',
  Serverfehler: 'Server error',
};

const translateError = (req, msg) => (req.headers['x-lang'] === 'en' && EN_ERRORS[msg]) || msg;

module.exports = {
  sendJson, readJson, isHttps, rateLimit, limitKey, startRateLimitCleanup,
  sign, safeEqual, sessionRole, setAdminCookie, requireAdmin, requireStaff,
  getRoom, getRoomPlayer, authPlayer,
  route, dispatch, sendCsv, csvTime, fileSafe,
  setSecurityHeaders, translateError,
};
