'use strict';

// API für Handys: Beitreten (/api/join/…) und Spielen (/api/play/…, angemeldet über X-Player-Token)

const { MAX_PLAYERS } = require('../config');
const { HttpError, randomId, cleanName, clampInt } = require('../util');
const { state, tokenIndex, playersOf, markDirty, logEvent } = require('../store');
const game = require('../game');
const { playerView } = require('../views');
const { route, readJson, rateLimit, limitKey, authPlayer } = require('../http');

// Nach Spielende werden Standorte nur noch kurz angenommen (Rückweg zum Treffpunkt) – danach nicht mehr,
// damit z. B. eine zu Hause geöffnete App keinen Standort mehr schickt und das automatische Löschen nicht aufhält
const AFTER_END_MS = 2 * 3600e3;

function roomByCode(code) {
  const c = String(code).toUpperCase();
  const room = Object.values(state.rooms).find((r) => r.code === c);
  if (!room) throw new HttpError(404, 'Spiel nicht gefunden – Code prüfen.');
  return room;
}

route('GET', '/api/join/:code', (req, res, { code }) => {
  // großzügig, weil eine ganze Klasse oft über dasselbe WLAN (eine IP) beitritt
  rateLimit(req, 'join-info', 300, 60e3);
  const room = roomByCode(code);
  return { name: room.name, joinOpen: room.joinOpen, status: room.status };
});

route('POST', '/api/join/:code', async (req, res, { code }) => {
  rateLimit(req, 'join', 120, 60e3);
  const room = roomByCode(code);
  if (!room.joinOpen) throw new HttpError(403, 'Der Beitritt ist geschlossen. Frag die Spielleitung.');
  const name = cleanName((await readJson(req)).name);
  if (!name) throw new HttpError(400, 'Bitte einen Namen eingeben.');
  if (playersOf(room).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Dieser Name ist schon vergeben.');
  if (playersOf(room).length >= MAX_PLAYERS) throw new HttpError(403, 'Der Raum ist voll.');
  // Wer nach dem Verteilen der Rollen oder während des Spiels dazukommt, wird automatisch Jäger
  const lateJoin = room.status !== 'lobby' || playersOf(room).some((o) => o.role);
  const p = {
    id: randomId(6), token: randomId(24), name, role: lateJoin ? 'hunter' : null, joinedAt: Date.now(),
    lastSeen: null, pos: null, caughtAt: null, wasRunner: false, outside: false, lateJoin,
  };
  room.players[p.id] = p;
  tokenIndex.set(p.token, { roomId: room.id, playerId: p.id });
  logEvent(room, `${name} ist beigetreten${lateJoin ? ' (automatisch Jäger)' : ''}`);
  return { token: p.token };
});

route('GET', '/api/play/state', (req) => {
  const { room, p } = authPlayer(req);
  return playerView(room, p);
});

route('POST', '/api/play/pos', async (req) => {
  const { room, p } = authPlayer(req);
  const b = await readJson(req);
  const t = Date.now();
  if (room.status === 'ended' && t - room.endedAt > AFTER_END_MS) return { ok: true, ignored: true };
  // Das Handy sendet höchstens alle 3 Sekunden – mehr ist Missbrauch (z. B. um den Verlauf zu fluten)
  limitKey(`pos:${p.id}`, 60, 60e3);
  p.lastSeen = t;
  const lat = Number(b.lat), lng = Number(b.lng);
  if (b.lat != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    const age = clampInt(b.age, 0, 3600e3) || 0;
    p.pos = { lat, lng, acc: clampInt(b.acc, 0, 100000), t: t - age };
    p.geoError = null;
    game.updateZoneFlag(room, p);
  } else if (b.error) {
    p.geoError = String(b.error).slice(0, 40);
  }
  if (Number.isFinite(b.battery)) p.battery = Math.min(1, Math.max(0, b.battery));
  if (typeof b.charging === 'boolean') p.charging = b.charging;
  // Akku-Warnung ab unter 15 %, Entwarnung erst ab 20 % oder beim Laden (kein Flackern um die Grenze)
  if (p.battery != null) {
    if (p.battery < 0.15 && !p.charging) p.batteryLowSince ??= t;
    else if (p.battery >= 0.2 || p.charging) p.batteryLowSince = null;
  }
  markDirty();
  return { ok: true };
});

route('POST', '/api/play/caught', (req) => {
  const { room, p } = authPlayer(req);
  if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft gerade nicht.');
  game.catchRunner(room, p, 'selbst gemeldet');
  return playerView(room, p);
});

route('POST', '/api/play/extra-ping', (req) => {
  const { room, p } = authPlayer(req);
  if (p.role !== 'hunter') throw new HttpError(403, 'Nur Jäger können Extra-Pings auslösen.');
  if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft gerade nicht.');
  if (Date.now() < room.huntStartsAt) throw new HttpError(409, 'Während des Vorsprungs gibt es keine Pings.');
  if (room.extraPingsUsed >= room.settings.extraPings) throw new HttpError(409, 'Keine Extra-Pings mehr übrig.');
  room.extraPingsUsed++;
  game.doPing(room, 'extra', p.name);
  return playerView(room, p);
});

route('POST', '/api/play/rename', async (req) => {
  const { room, p } = authPlayer(req);
  if (room.status !== 'lobby') throw new HttpError(409, 'Umbenennen geht nur vor dem Spiel.');
  limitKey(`rename:${p.id}`, 10, 10 * 60e3);
  const name = cleanName((await readJson(req)).name);
  if (!name) throw new HttpError(400, 'Bitte einen Namen eingeben.');
  if (playersOf(room).some((o) => o.id !== p.id && o.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Dieser Name ist schon vergeben.');
  logEvent(room, `${p.name} heißt jetzt ${name}`);
  p.name = name;
  return playerView(room, p);
});

route('POST', '/api/play/leave', (req) => {
  const { room, p } = authPlayer(req);
  if (room.status === 'running' && p.role === 'runner') throw new HttpError(409, 'Gejagte können das laufende Spiel nicht verlassen – melde dich bei der Spielleitung.');
  game.removePlayer(room, p, 'player');
  logEvent(room, `${p.name} hat das Spiel verlassen`);
  return { ok: true };
});

// Mister-X-Stil: Gejagte melden beim Einsteigen ihr Verkehrsmittel (nur die Art, keine Linie)
route('POST', '/api/play/transport', async (req) => {
  const { room, p } = authPlayer(req);
  if (!room.settings.transportReports) throw new HttpError(409, 'Verkehrsmittel-Meldungen sind in diesem Spiel aus.');
  if (room.status !== 'running' || p.role !== 'runner') throw new HttpError(409, 'Nur Gejagte melden im laufenden Spiel ihr Verkehrsmittel.');
  limitKey(`transport:${p.id}`, 30, 10 * 60e3);
  const { mode } = await readJson(req);
  if (!Object.hasOwn(game.TRANSPORT, mode)) throw new HttpError(400, 'Unbekanntes Verkehrsmittel');
  p.transport = { mode, at: Date.now() };
  logEvent(room, `${p.name} meldet: ${game.TRANSPORT[mode]}`);
  return playerView(room, p);
});

route('POST', '/api/play/sos', (req) => {
  const { room, p } = authPlayer(req);
  game.raiseEmergency(room, p);
  return playerView(room, p);
});

// Gejagte setzen einen Block: Beim nächsten Ping sehen die Jäger sie nicht
route('POST', '/api/play/block', (req) => {
  const { room, p } = authPlayer(req);
  game.armBlock(room, p);
  return playerView(room, p);
});

// Ergebnis des Handy-Checks (GPS, Display-an, Ton …) – die Spielleitung sieht es in der Geräte-Liste
route('POST', '/api/play/check', async (req) => {
  const { p } = authPlayer(req);
  const b = await readJson(req);
  const pick = (v, allowed) => (allowed.includes(v) ? v : null);
  p.check = {
    gps: pick(b.gps, ['ok', 'weak', 'fail']),
    wakeLock: pick(b.wakeLock, ['ok', 'fail', 'unsupported']),
    sound: pick(b.sound, ['ok', 'fail', 'untested']),
    vibrate: typeof b.vibrate === 'boolean' ? b.vibrate : null,
    battery: Number.isFinite(b.battery) ? Math.min(1, Math.max(0, b.battery)) : null,
    platform: pick(b.platform, ['ios', 'android', 'other']),
    installed: b.installed === true,
    at: Date.now(),
  };
  markDirty();
  return { ok: true };
});

// SOS selbst wird nie gebremst – nur das Entwarnen, damit niemand mit SOS/Entwarnung den Verlauf flutet.
// Im Zweifel bleibt der Notruf also aktiv.
route('POST', '/api/play/sos-cancel', (req) => {
  const { room, p } = authPlayer(req);
  const e = game.activeEmergency(room, p.id);
  if (e) {
    limitKey(`sos-cancel:${p.id}`, 5, 10 * 60e3);
    game.resolveEmergency(room, e, 'player');
  }
  return playerView(room, p);
});
