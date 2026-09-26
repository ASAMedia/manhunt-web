'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = process.env.TILE_ATTRIBUTION || '&copy; OpenStreetMap-Mitwirkende';
const MAP_CENTER = parseCenter(process.env.MAP_CENTER) || [52.517, 13.3889]; // Berlin-Mitte
// Räume werden so viele Tage nach der letzten Aktivität gelöscht (0 = nie); laufende Spiele nie
const AUTO_DELETE_DAYS = ['', undefined].includes(process.env.AUTO_DELETE_DAYS)
  ? 7
  : Math.max(0, Number(process.env.AUTO_DELETE_DAYS) || 0);

// Optionales zweites Passwort für eine Aufsichtsperson (sieht alles, darf aber nichts starten/löschen/einstellen)
const SUPERVISOR_PASSWORD = process.env.SUPERVISOR_PASSWORD || '';

if (ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD fehlt oder ist kürzer als 8 Zeichen. Bitte in .env setzen.');
  process.exit(1);
}
if (SUPERVISOR_PASSWORD && (SUPERVISOR_PASSWORD.length < 8 || SUPERVISOR_PASSWORD === ADMIN_PASSWORD)) {
  console.error('SUPERVISOR_PASSWORD muss mindestens 8 Zeichen haben und sich vom ADMIN_PASSWORD unterscheiden.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const SESSION_SECRET = loadSessionSecret();

const PUBLIC_DIR = path.join(__dirname, 'public');
const LEAFLET_DIR = path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist');

const MAX_PLAYERS = 100;
const MAX_PINGS = 60;
const MAX_EVENTS = 300;
const ADMIN_SESSION_MS = 12 * 3600e3;
const ROLES = new Set(['hunter', 'runner']);

function parseCenter(v) {
  if (!v) return null;
  const [lat, lng] = v.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

// ---------------------------------------------------------------------------
// Zustand + Persistenz
// ---------------------------------------------------------------------------

let state = { rooms: {} };
const tokenIndex = new Map(); // Spieler-Token -> { roomId, playerId }
let dirty = false;

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.rooms) state.rooms = {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('state.json konnte nicht gelesen werden:', e.message);
  }
  for (const room of Object.values(state.rooms)) {
    // Räume aus älteren Versionen um neue Felder ergänzen
    room.emergencies ??= [];
    room.rounds ??= [];
    room.settings = { ...defaultSettings(), ...room.settings };
    for (const p of Object.values(room.players)) tokenIndex.set(p.token, { roomId: room.id, playerId: p.id });
  }
}

function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

const markDirty = () => { dirty = true; };

setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try { saveState(); } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); dirty = true; }
}, 3000);

function shutdown() {
  try { saveState(); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 Zeichen, ohne I/O/0/1

function newRoomCode() {
  const used = new Set(Object.values(state.rooms).map((r) => r.code));
  let code;
  do code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % 32]).join('');
  while (used.has(code));
  return code;
}

function distanceM(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function cleanName(v, max = 24) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// wie clampInt, aber mit einer Nachkommastelle (z. B. 0,5 Minuten)
function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Spiellogik
// ---------------------------------------------------------------------------

// bot = Ereignis eines Test-Geräts (zählt nicht als Aktivität fürs automatische Löschen)
function logEvent(room, text, bot = false) {
  room.events.push(bot ? { at: Date.now(), text, bot: true } : { at: Date.now(), text });
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
  markDirty();
}

const playersOf = (room) => Object.values(room.players);
const runnersLeft = (room) => playersOf(room).filter((p) => p.role === 'runner').length;

function defaultSettings() {
  return {
    pingIntervalMin: 5, durationMin: 90, headStartMin: 10, extraPings: 3,
    zone: null, meetingPoint: null, emergencyPhone: '',
    signalAlarmMin: 3,        // Alarm, wenn ein Gerät so lange nichts sendet (0 = aus)
    pingWarningSec: 60,       // Vorwarnung vor jedem Ping (0 = aus)
    transportReports: false,  // Gejagte melden ihr Verkehrsmittel (Mister-X-Stil)
    shrinkEnabled: false,     // Spielfeld wird bis zum Spielende kleiner
    shrinkFinalRadius: 400,
    rules: '',                // eigener Regeltext; leer = Standardregeln
  };
}

const TRANSPORT = { U: 'U-Bahn', S: 'S-Bahn', Bus: 'Bus', Tram: 'Tram', Fuss: 'zu Fuß' };

function createRoom(name) {
  const room = {
    id: randomId(6),
    name,
    code: newRoomCode(),
    joinOpen: true,
    createdAt: Date.now(),
    settings: defaultSettings(),
    status: 'lobby',
    startedAt: null,
    huntStartsAt: null,
    endsAt: null,
    endedAt: null,
    nextPingAt: null,
    extraPingsUsed: 0,
    result: null,
    message: null,
    pings: [],
    events: [],
    emergencies: [],
    rounds: [],
    players: {},
  };
  state.rooms[room.id] = room;
  logEvent(room, 'Raum erstellt');
  return room;
}

function deleteRoom(room) {
  for (const p of playersOf(room)) tokenIndex.delete(p.token);
  delete state.rooms[room.id];
  // Löschen sofort auf die Platte schreiben, damit die Standortdaten wirklich weg sind
  try { saveState(); } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); markDirty(); }
}

function applySettings(room, input) {
  const s = { ...room.settings };
  if (input.pingIntervalMin != null) s.pingIntervalMin = clampInt(input.pingIntervalMin, 1, 180) ?? s.pingIntervalMin;
  if (input.durationMin != null) s.durationMin = clampInt(input.durationMin, 5, 1440) ?? s.durationMin;
  if (input.headStartMin != null) s.headStartMin = clampInt(input.headStartMin, 0, 120) ?? s.headStartMin;
  if (input.extraPings != null) s.extraPings = clampInt(input.extraPings, 0, 50) ?? s.extraPings;
  if ('zone' in input) {
    const z = input.zone;
    if (z === null) s.zone = null;
    else {
      const lat = Number(z?.lat), lng = Number(z?.lng), radius = clampInt(z?.radius, 50, 50000);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && radius)) throw new HttpError(400, 'Ungültige Zone');
      s.zone = { lat, lng, radius };
    }
  }
  if ('meetingPoint' in input) {
    const m = input.meetingPoint;
    if (m === null) s.meetingPoint = null;
    else {
      const lat = Number(m?.lat), lng = Number(m?.lng);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new HttpError(400, 'Ungültiger Treffpunkt');
      s.meetingPoint = { lat, lng, label: cleanName(m.label, 60) || 'Treffpunkt' };
    }
  }
  if (input.emergencyPhone != null) {
    const phone = String(input.emergencyPhone).trim();
    if (phone && !/^\+?[0-9][0-9 /()-]{2,24}$/.test(phone)) throw new HttpError(400, 'Ungültige Notfall-Telefonnummer');
    s.emergencyPhone = phone;
  }
  if (input.signalAlarmMin != null) s.signalAlarmMin = clampNum(input.signalAlarmMin, 0, 30) ?? s.signalAlarmMin;
  if (input.pingWarningSec != null) s.pingWarningSec = clampInt(input.pingWarningSec, 0, 600) ?? s.pingWarningSec;
  if (typeof input.transportReports === 'boolean') s.transportReports = input.transportReports;
  if (typeof input.shrinkEnabled === 'boolean') s.shrinkEnabled = input.shrinkEnabled;
  if (input.shrinkFinalRadius != null) s.shrinkFinalRadius = clampInt(input.shrinkFinalRadius, 50, 50000) ?? s.shrinkFinalRadius;
  if (input.rules != null) s.rules = String(input.rules).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 3000);
  if (s.headStartMin >= s.durationMin) throw new HttpError(400, 'Der Vorsprung muss kürzer als die Spieldauer sein.');
  if (s.shrinkEnabled && s.zone && s.shrinkFinalRadius >= s.zone.radius) {
    throw new HttpError(400, 'Der End-Radius muss kleiner sein als der Spielfeld-Radius.');
  }
  room.settings = s;
  if (room.status === 'running') schedule(room);
  for (const p of playersOf(room)) updateZoneFlag(room, p, false);
  markDirty();
}

function schedule(room) {
  const s = room.settings;
  room.huntStartsAt = room.startedAt + s.headStartMin * 60e3;
  room.endsAt = room.startedAt + s.durationMin * 60e3;
  const lastRegular = room.pings.findLast((p) => p.kind === 'regular');
  room.nextPingAt = lastRegular ? lastRegular.at + s.pingIntervalMin * 60e3 : room.huntStartsAt;
}

function startGame(room) {
  if (room.status !== 'lobby') throw new HttpError(409, 'Starten geht nur aus der Lobby.');
  const players = playersOf(room);
  if (players.some((p) => !p.role)) throw new HttpError(409, 'Noch nicht alle Geräte haben eine Rolle.');
  const hunters = players.filter((p) => p.role === 'hunter').length;
  const runners = players.filter((p) => p.role === 'runner').length;
  if (!hunters || !runners) throw new HttpError(409, 'Es braucht mindestens einen Jäger und einen Gejagten.');
  for (const p of players) {
    p.caughtAt = null;
    p.wasRunner = p.role === 'runner';
    p.transport = null;
  }
  Object.assign(room, {
    status: 'running', startedAt: Date.now(), endedAt: null, pings: [], extraPingsUsed: 0, result: null,
    roundNo: (room.roundNo || 0) + 1,
  });
  schedule(room);
  logEvent(room, `Runde ${room.roundNo} gestartet: ${runners} Gejagte, ${hunters} Jäger-Geräte`);
}

function endGame(room, winner, reason) {
  Object.assign(room, { status: 'ended', endedAt: Date.now(), nextPingAt: null, result: { winner, reason } });
  logEvent(room, reason);
  room.rounds.push(roundSummary(room));
  if (room.rounds.length > 20) room.rounds.shift();
}

// Auswertung einer Runde – bewusst ohne Bewegungsspuren
function roundSummary(room) {
  const s = room.settings;
  const count = (kind) => room.pings.filter((p) => p.kind === kind).length;
  return {
    no: room.roundNo || room.rounds.length + 1,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    winner: room.result.winner,
    reason: room.result.reason,
    settings: {
      pingIntervalMin: s.pingIntervalMin, durationMin: s.durationMin, headStartMin: s.headStartMin,
      zoneRadius: s.zone?.radius ?? null, shrinkFinalRadius: s.shrinkEnabled && s.zone ? s.shrinkFinalRadius : null,
    },
    runners: playersOf(room).filter((p) => p.wasRunner).map((p) => ({
      name: p.name,
      caughtAt: p.caughtAt,
      survivedMin: Math.round(((p.caughtAt || room.endedAt) - room.startedAt) / 6e3) / 10,
    })).sort((a, b) => b.survivedMin - a.survivedMin),
    hunterDevices: playersOf(room).filter((p) => p.role === 'hunter' && !p.wasRunner).length,
    pings: { regular: count('regular'), extra: count('extra'), admin: count('admin') },
    emergencies: room.emergencies.filter((e) => e.at >= room.startedAt && e.at <= room.endedAt).length,
  };
}

function backToLobby(room) {
  if (room.status === 'running') throw new HttpError(409, 'Erst das Spiel beenden.');
  Object.assign(room, {
    status: 'lobby', startedAt: null, huntStartsAt: null, endsAt: null, endedAt: null,
    nextPingAt: null, result: null, pings: [], extraPingsUsed: 0,
  });
  for (const p of playersOf(room)) {
    // Gefangene sind im Spiel zu Jägern geworden – für die nächste Runde die Startrollen wiederherstellen
    if (p.wasRunner) p.role = 'runner';
    p.caughtAt = null;
    p.wasRunner = false;
    p.transport = null;
  }
  logEvent(room, 'Zurück in der Lobby');
}

function doPing(room, kind, by) {
  const at = Date.now();
  const positions = playersOf(room)
    .filter((p) => p.role === 'runner')
    .map((p) => (p.pos
      ? { playerId: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, acc: p.pos.acc, t: p.pos.t }
      : { playerId: p.id, name: p.name, missing: true }));
  room.pings.push({ id: randomId(6), at, kind, by: by || null, positions });
  if (room.pings.length > MAX_PINGS) room.pings.splice(0, room.pings.length - MAX_PINGS);
  if (kind === 'regular') {
    const iv = room.settings.pingIntervalMin * 60e3;
    do room.nextPingAt += iv; while (room.nextPingAt <= at);
  }
  const label = { regular: 'Ping', admin: 'Sofort-Ping (Spielleitung)', extra: `Extra-Ping von ${by}` }[kind];
  logEvent(room, `${label}: ${positions.length} Gejagte`);
}

function catchRunner(room, p, how) {
  if (p.role !== 'runner') throw new HttpError(409, 'Nur Gejagte können gefangen werden.');
  p.role = 'hunter';
  p.caughtAt = Date.now();
  p.wasRunner = true;
  logEvent(room, `${p.name} wurde gefangen (${how}) und ist jetzt Jäger`, p.bot);
}

function releaseRunner(room, p) {
  if (!p.caughtAt) throw new HttpError(409, `${p.name} ist nicht gefangen.`);
  p.role = 'runner';
  p.caughtAt = null;
  logEvent(room, `${p.name} ist wieder Gejagter (Korrektur Spielleitung)`);
}

// Aktuelles Spielfeld – beim schrumpfenden Spielfeld wird der Radius vom Ende des Vorsprungs
// bis zum Spielende gleichmäßig vom Start- auf den End-Radius verkleinert.
function currentZone(room, t = Date.now()) {
  const z = room.settings.zone;
  if (!z) return null;
  const s = room.settings;
  if (!s.shrinkEnabled || room.status !== 'running' || !(s.shrinkFinalRadius < z.radius)) return { ...z };
  const f = Math.min(1, Math.max(0, (t - room.huntStartsAt) / (room.endsAt - room.huntStartsAt)));
  return { ...z, radius: Math.round(z.radius - (z.radius - s.shrinkFinalRadius) * f) };
}

function updateZoneFlag(room, p, log = true) {
  const z = currentZone(room);
  const outside = !!(z && p.pos && distanceM(p.pos, z) > z.radius);
  if (outside !== !!p.outside) {
    p.outside = outside;
    p.outsideSince = outside ? Date.now() : null;
    if (log && room.status === 'running') logEvent(room, `${p.name} ${outside ? 'hat das Spielfeld verlassen' : 'ist zurück im Spielfeld'}`, p.bot);
  }
}

// Warnungen für die Aufsicht: kein Signal mehr oder außerhalb des Spielfelds.
// Eine Quittung gilt nur für genau diesen Vorfall (gleicher Zeitstempel).
function roomWarnings(room, t = Date.now()) {
  if (room.status !== 'running') return [];
  const out = [];
  const limit = room.settings.signalAlarmMin * 60e3;
  for (const p of playersOf(room)) {
    const base = { roomId: room.id, roomName: room.name, playerId: p.id, name: p.name, role: p.role, pos: p.pos };
    const lastSignal = p.lastSeen || room.startedAt;
    if (limit && t - lastSignal > limit) {
      const key = p.lastSeen || 0;
      out.push({ ...base, type: 'signal', since: lastSignal, key, acked: p.warnAck?.signal === key });
    }
    if (p.outside && p.outsideSince) {
      out.push({ ...base, type: 'zone', since: p.outsideSince, key: p.outsideSince, acked: p.warnAck?.zone === p.outsideSince });
    }
  }
  return out;
}

function drawRoles(room, runnerCount) {
  if (room.status !== 'lobby') throw new HttpError(409, 'Auslosen geht nur in der Lobby.');
  const players = playersOf(room);
  if (players.length < 2) throw new HttpError(409, 'Es braucht mindestens zwei Geräte.');
  const n = clampInt(runnerCount, 1, players.length - 1);
  if (!n) throw new HttpError(400, 'Ungültige Anzahl');
  for (let i = players.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [players[i], players[j]] = [players[j], players[i]];
  }
  players.forEach((p, i) => { p.role = i < n ? 'runner' : 'hunter'; });
  logEvent(room, `Rollen ausgelost: ${n} Gejagte, ${players.length - n} Jäger`);
}

function removePlayer(room, p, by) {
  const e = activeEmergency(room, p.id);
  if (e) resolveEmergency(room, e, by);
  tokenIndex.delete(p.token);
  delete room.players[p.id];
  markDirty();
}

// --- Test-Geräte (Probespiel) --------------------------------------------------

function addBots(room, runners, hunters) {
  const nR = clampInt(runners, 0, 10) ?? 0;
  const nH = clampInt(hunters, 0, 10) ?? 0;
  if (!nR && !nH) throw new HttpError(400, 'Mindestens ein Test-Gerät angeben.');
  if (playersOf(room).length + nR + nH > MAX_PLAYERS) throw new HttpError(403, 'Der Raum ist voll.');
  const z = room.settings.zone;
  const center = z ? { lat: z.lat, lng: z.lng } : { lat: MAP_CENTER[0], lng: MAP_CENTER[1] };
  const spread = (z?.radius ?? 800) * 0.6;
  const taken = new Set(playersOf(room).map((p) => p.name.toLowerCase()));
  const make = (role, label) => {
    let i = 1;
    while (taken.has(`${label} ${i}`.toLowerCase())) i++;
    const name = `${label} ${i}`;
    taken.add(name.toLowerCase());
    const p = {
      id: randomId(6), token: randomId(24), name, role, joinedAt: Date.now(), bot: true,
      lastSeen: Date.now(), pos: { ...offsetPoint(center, Math.random() * spread, Math.random() * 360), acc: 8, t: Date.now() },
      heading: Math.random() * 360, battery: 0.6 + Math.random() * 0.4, charging: false,
      caughtAt: null, wasRunner: room.status === 'running' && role === 'runner', outside: false,
    };
    room.players[p.id] = p;
    tokenIndex.set(p.token, { roomId: room.id, playerId: p.id });
  };
  for (let i = 0; i < nR; i++) make('runner', 'Test-Gejagt');
  for (let i = 0; i < nH; i++) make('hunter', 'Test-Jäger');
  logEvent(room, `${nR + nH} Test-Geräte hinzugefügt (${nR} Gejagte, ${nH} Jäger)`, true);
}

function removeBots(room) {
  const bots = playersOf(room).filter((p) => p.bot);
  for (const p of bots) removePlayer(room, p, 'admin');
  if (bots.length) logEvent(room, `${bots.length} Test-Geräte entfernt`, true);
}

// Punkt in `dist` Metern Entfernung in Richtung `bearing` (Grad)
function offsetPoint(p, dist, bearing) {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (dist * Math.cos(rad)) / 111320;
  const dLng = (dist * Math.sin(rad)) / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

const bearingTo = (a, b) => (Math.atan2(
  (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat,
) * 180) / Math.PI;

// Test-Geräte gehen zufällig umher, bleiben im Spielfeld, Jäger laufen auf den letzten Ping zu.
// Test-Gejagte gelten als gefangen, wenn ein Jäger näher als 20 m kommt.
function simulateBots(room, dtSec) {
  const t = Date.now();
  const z = currentZone(room);
  const lastPing = room.pings.at(-1);
  const players = playersOf(room);
  for (const p of players) {
    if (!p.bot || !p.pos) continue;
    const speed = p.role === 'hunter' ? 1.9 : 1.5;
    if (room.status === 'running' && p.role === 'hunter' && lastPing?.positions.length && Math.random() < 0.6) {
      const target = lastPing.positions.filter((x) => !x.missing)
        .sort((a, b) => distanceM(p.pos, a) - distanceM(p.pos, b))[0];
      if (target) p.heading = bearingTo(p.pos, target);
    }
    p.heading += (Math.random() - 0.5) * 50;
    if (z && distanceM(p.pos, z) > z.radius * 0.9) p.heading = bearingTo(p.pos, z);
    p.pos = { ...offsetPoint(p.pos, speed * dtSec, p.heading), acc: 6 + Math.round(Math.random() * 10), t };
    p.lastSeen = t;
    p.battery = Math.max(0.05, p.battery - 0.00003 * dtSec);
    updateZoneFlag(room, p);
  }
  if (room.status !== 'running' || t < room.huntStartsAt) return;
  const hunters = players.filter((p) => p.role === 'hunter' && p.pos);
  for (const r of players.filter((p) => p.bot && p.role === 'runner')) {
    if (hunters.some((h) => distanceM(h.pos, r.pos) < 20)) catchRunner(room, r, 'Test-Gerät');
  }
}

// --- Notfall -----------------------------------------------------------------

const activeEmergency = (room, playerId) => room.emergencies.find((e) => e.playerId === playerId && !e.resolvedAt);

function raiseEmergency(room, p) {
  const existing = activeEmergency(room, p.id);
  if (existing) return existing;
  const e = {
    id: randomId(6), playerId: p.id, name: p.name, at: Date.now(),
    pos: p.pos ? { ...p.pos } : null, ackAt: null, resolvedAt: null, resolvedBy: null,
  };
  room.emergencies.push(e);
  // alte, erledigte Notfälle nicht endlos aufbewahren
  if (room.emergencies.length > 50) room.emergencies = room.emergencies.filter((x, i, all) => !x.resolvedAt || i >= all.length - 50);
  logEvent(room, `NOTFALL von ${p.name}!`);
  return e;
}

function resolveEmergency(room, e, by) {
  e.resolvedAt = Date.now();
  e.resolvedBy = by;
  logEvent(room, by === 'player' ? `Entwarnung von ${e.name}` : `Notfall von ${e.name} erledigt (Spielleitung)`);
}

// --- Automatisches Löschen ----------------------------------------------------

function lastActivity(room) {
  let t = Math.max(room.createdAt, room.endedAt || 0);
  // Test-Geräte zählen nicht als Aktivität, sonst würde ein Probe-Raum nie gelöscht
  const real = room.events.findLast((e) => !e.bot);
  if (real?.at > t) t = real.at;
  for (const p of playersOf(room)) if (!p.bot && p.lastSeen > t) t = p.lastSeen;
  return t;
}

function autoDeleteAt(room) {
  if (!AUTO_DELETE_DAYS || room.status === 'running') return null;
  return lastActivity(room) + AUTO_DELETE_DAYS * 86400e3;
}

function autoDelete() {
  const t = Date.now();
  for (const room of Object.values(state.rooms)) {
    const at = autoDeleteAt(room);
    if (at && at <= t) {
      console.log(`Raum „${room.name}“ automatisch gelöscht (${AUTO_DELETE_DAYS} Tage ohne Aktivität)`);
      deleteRoom(room);
    }
  }
}
setInterval(autoDelete, 60e3);

// Takt: Pings auslösen, Spielende prüfen; alle 3 s Test-Geräte bewegen und das schrumpfende Spielfeld prüfen
let tickNo = 0;
setInterval(() => {
  const t = Date.now();
  const slow = ++tickNo % 3 === 0;
  for (const room of Object.values(state.rooms)) {
    if (slow && room.status !== 'ended' && playersOf(room).some((p) => p.bot)) {
      simulateBots(room, 3);
      markDirty();
    }
    if (room.status !== 'running') continue;
    if (slow && room.settings.shrinkEnabled) for (const p of playersOf(room)) updateZoneFlag(room, p);
    if (runnersLeft(room) === 0) {
      endGame(room, 'hunters', 'Alle Gejagten wurden gefangen – die Jäger gewinnen!');
    } else if (t >= room.endsAt) {
      const left = playersOf(room).filter((p) => p.role === 'runner').map((p) => p.name);
      endGame(room, 'runners', `Zeit abgelaufen – ${left.join(', ')} ${left.length === 1 ? 'wurde' : 'wurden'} nicht gefangen. Die Gejagten gewinnen!`);
    } else if (t >= room.huntStartsAt && t >= room.nextPingAt) {
      doPing(room, 'regular');
    }
  }
}, 1000);

// ---------------------------------------------------------------------------
// Sichten (was wer sehen darf)
// ---------------------------------------------------------------------------

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, role: p.role, caughtAt: p.caughtAt, wasRunner: !!p.wasRunner,
    joinedAt: p.joinedAt, lastSeen: p.lastSeen, pos: p.pos, outside: !!p.outside,
    battery: p.battery ?? null, charging: p.charging ?? null, geoError: p.geoError || null,
    bot: !!p.bot, transport: p.transport || null,
  };
}

// Spielfeld für die Anzeige: aktueller Kreis und – beim Schrumpfen – der End-Kreis
function zoneView(room) {
  const zone = currentZone(room);
  const s = room.settings;
  const shrinking = !!(zone && s.shrinkEnabled && s.shrinkFinalRadius < s.zone.radius);
  return { zone, zoneFinalRadius: shrinking ? s.shrinkFinalRadius : null };
}

function roomTiming(room) {
  return {
    status: room.status, startedAt: room.startedAt, huntStartsAt: room.huntStartsAt, endsAt: room.endsAt,
    endedAt: room.endedAt, nextPingAt: room.nextPingAt, result: room.result, message: room.message,
    extraPingsLeft: Math.max(0, room.settings.extraPings - room.extraPingsUsed),
  };
}

function roomSummary(room) {
  const players = playersOf(room);
  return {
    id: room.id, name: room.name, code: room.code, joinOpen: room.joinOpen, createdAt: room.createdAt,
    ...roomTiming(room),
    players: players.length,
    hunters: players.filter((p) => p.role === 'hunter').length,
    runners: players.filter((p) => p.role === 'runner').length,
    emergencies: room.emergencies.filter((e) => !e.resolvedAt).length,
    warnings: roomWarnings(room).filter((w) => !w.acked).length,
    bots: players.filter((p) => p.bot).length,
    autoDeleteAt: autoDeleteAt(room),
  };
}

function adminRoom(room) {
  const warnings = roomWarnings(room);
  return {
    ...roomSummary(room),
    settings: room.settings,
    ...zoneView(room),
    players: playersOf(room).map((p) => ({
      ...publicPlayer(p),
      rejoinPath: `/r/${p.token}`,
      emergency: !!activeEmergency(room, p.id),
      warnings: warnings.filter((w) => w.playerId === p.id).map((w) => ({ type: w.type, since: w.since, acked: w.acked })),
    })),
    pings: room.pings.slice(-10),
    events: room.events.slice(-100).map(({ at, text }) => ({ at, text })),
    rounds: room.rounds,
    serverTime: Date.now(),
  };
}

function playerView(room, me) {
  const players = playersOf(room);
  const s = room.settings;
  const emergency = activeEmergency(room, me.id);
  // Verkehrsmittel der Gejagten sehen nur Jäger (und alle nach Spielende)
  const showTransport = s.transportReports && (me.role === 'hunter' || room.status === 'ended');
  const view = {
    serverTime: Date.now(),
    room: {
      name: room.name, code: room.code, ...zoneView(room), meetingPoint: s.meetingPoint, emergencyPhone: s.emergencyPhone || null,
      pingIntervalMin: s.pingIntervalMin, durationMin: s.durationMin, headStartMin: s.headStartMin,
      pingWarningSec: s.pingWarningSec, transportReports: s.transportReports,
      shrinkEnabled: s.shrinkEnabled, shrinkFinalRadius: s.shrinkFinalRadius, rules: s.rules,
      ...roomTiming(room),
    },
    me: {
      id: me.id, name: me.name, role: me.role, caughtAt: me.caughtAt, outside: !!me.outside,
      emergency: emergency ? { at: emergency.at, ackAt: emergency.ackAt } : null,
      transport: me.transport || null,
    },
    runners: players.filter((p) => p.role === 'runner' || p.wasRunner)
      .map((p) => ({ name: p.name, caughtAt: p.caughtAt, ...(showTransport && { transport: p.transport || null }) })),
    hunterCount: players.filter((p) => p.role === 'hunter').length,
    lastPingAt: room.pings.at(-1)?.at ?? null,
    lastPingKind: room.pings.at(-1)?.kind ?? null,
  };
  if (room.status === 'lobby') view.lobby = players.map((p) => p.name);
  if (me.role === 'hunter' || room.status === 'ended') {
    view.pings = room.pings.slice(-4);
  }
  if (me.role === 'hunter') {
    view.hunters = players
      .filter((p) => p.role === 'hunter' && p.id !== me.id && p.pos)
      .map((p) => ({ name: p.name, lat: p.pos.lat, lng: p.pos.lng, t: p.pos.t }));
  }
  return view;
}

// ---------------------------------------------------------------------------
// HTTP-Grundlagen
// ---------------------------------------------------------------------------

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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-proto']) return req.headers['x-forwarded-proto'].split(',')[0].trim() === 'https';
  return PUBLIC_URL.startsWith('https://');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '?';
}

const buckets = new Map();
function rateLimit(req, key, max, windowMs) {
  const k = `${key}:${clientIp(req)}`;
  const t = Date.now();
  let b = buckets.get(k);
  if (!b || b.reset < t) buckets.set(k, (b = { n: 0, reset: t + windowMs }));
  if (++b.n > max) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten.');
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60e3);

// Admin-Sitzung: signiertes Cookie
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

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
  const room = state.rooms[id];
  if (!room) throw new HttpError(404, 'Raum nicht gefunden');
  return room;
}

function getRoomPlayer(room, pid) {
  const p = room.players[pid];
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

// ---------------------------------------------------------------------------
// API-Routen
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler });
}

route('GET', '/api/health', () => ({ ok: true }));

route('GET', '/api/config', () => ({
  tileUrl: TILE_URL, tileAttribution: TILE_ATTRIBUTION, mapCenter: MAP_CENTER, publicUrl: PUBLIC_URL || null,
  autoDeleteDays: AUTO_DELETE_DAYS,
}));

// --- Spielleitung -----------------------------------------------------------

route('GET', '/api/admin/session', (req) => {
  const role = sessionRole(req);
  return { admin: !!role, role };
});

route('POST', '/api/admin/login', async (req, res) => {
  rateLimit(req, 'login', 10, 5 * 60e3);
  const { password } = await readJson(req);
  const role = safeEqual(password || '', ADMIN_PASSWORD) ? 'admin'
    : SUPERVISOR_PASSWORD && safeEqual(password || '', SUPERVISOR_PASSWORD) ? 'supervisor' : null;
  if (!role) throw new HttpError(401, 'Falsches Passwort');
  const exp = Date.now() + ADMIN_SESSION_MS;
  setAdminCookie(req, res, `${role}.${exp}.${sign(`${role}.${exp}`)}`, ADMIN_SESSION_MS / 1000);
  return { admin: true, role };
});

route('POST', '/api/admin/logout', (req, res) => {
  setAdminCookie(req, res, '', 0);
  return { admin: false };
});

route('GET', '/api/admin/rooms', (req) => {
  requireStaff(req);
  return Object.values(state.rooms).sort((a, b) => b.createdAt - a.createdAt).map(roomSummary);
});

route('POST', '/api/admin/rooms', async (req) => {
  requireAdmin(req);
  const name = cleanName((await readJson(req)).name) || `Raum ${Object.keys(state.rooms).length + 1}`;
  return adminRoom(createRoom(name));
});

route('GET', '/api/admin/rooms/:id', (req, res, { id }) => {
  requireStaff(req);
  return adminRoom(getRoom(id));
});

route('PATCH', '/api/admin/rooms/:id', async (req, res, { id }) => {
  requireAdmin(req);
  const room = getRoom(id);
  const body = await readJson(req);
  if (body.name != null) room.name = cleanName(body.name) || room.name;
  if (typeof body.joinOpen === 'boolean') {
    room.joinOpen = body.joinOpen;
    logEvent(room, body.joinOpen ? 'Beitritt geöffnet' : 'Beitritt geschlossen');
  }
  if (body.settings) applySettings(room, body.settings);
  markDirty();
  return adminRoom(room);
});

route('DELETE', '/api/admin/rooms/:id', (req, res, { id }) => {
  requireAdmin(req);
  deleteRoom(getRoom(id));
  return { ok: true };
});

route('POST', '/api/admin/rooms/:id/:action', async (req, res, { id, action }) => {
  // Nachrichten darf auch die Aufsicht senden, alles andere nur die Spielleitung
  const role = action === 'message' ? requireStaff(req) : requireAdmin(req);
  const room = getRoom(id);
  const body = await readJson(req);
  switch (action) {
    case 'start': startGame(room); break;
    case 'end':
      if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft nicht.');
      endGame(room, null, 'Spiel von der Spielleitung beendet');
      break;
    case 'lobby': backToLobby(room); break;
    case 'ping':
      if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft nicht.');
      doPing(room, 'admin');
      break;
    case 'draw': drawRoles(room, body.runners); break;
    case 'message': {
      const text = String(body.text ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 300);
      room.message = text ? { id: randomId(6), text, at: Date.now() } : null;
      const who = role === 'supervisor' ? ' (Aufsicht)' : '';
      logEvent(room, text ? `Nachricht an alle${who}: ${text}` : `Nachricht gelöscht${who}`);
      break;
    }
    case 'bots': addBots(room, body.runners, body.hunters); break;
    default: throw new HttpError(404, 'Unbekannte Aktion');
  }
  markDirty();
  return adminRoom(room);
});

route('PATCH', '/api/admin/rooms/:id/players/:pid', async (req, res, { id, pid }) => {
  requireAdmin(req);
  const room = getRoom(id);
  const p = getRoomPlayer(room, pid);
  const body = await readJson(req);
  if (body.name != null) {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Name fehlt');
    if (playersOf(room).some((o) => o.id !== p.id && o.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Name schon vergeben');
    p.name = name;
  }
  if ('role' in body) {
    if (body.role !== null && !ROLES.has(body.role)) throw new HttpError(400, 'Ungültige Rolle');
    if (room.status === 'running' && body.role === null) throw new HttpError(409, 'Im laufenden Spiel braucht jedes Gerät eine Rolle.');
    p.role = body.role;
    if (room.status === 'running' && p.role === 'runner') p.wasRunner = true;
    if (p.role === 'runner') p.caughtAt = null;
  }
  if (typeof body.caught === 'boolean') {
    if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft nicht.');
    if (body.caught) catchRunner(room, p, 'Spielleitung');
    else releaseRunner(room, p);
  }
  markDirty();
  return adminRoom(room);
});

route('DELETE', '/api/admin/rooms/:id/players/:pid', (req, res, { id, pid }) => {
  requireAdmin(req);
  const room = getRoom(id);
  const p = getRoomPlayer(room, pid);
  removePlayer(room, p, 'admin');
  logEvent(room, `${p.name} wurde entfernt`);
  return adminRoom(room);
});

route('DELETE', '/api/admin/rooms/:id/bots', (req, res, { id }) => {
  requireAdmin(req);
  const room = getRoom(id);
  removeBots(room);
  return adminRoom(room);
});

// Warnung (Signalverlust / außerhalb) für genau diesen Vorfall quittieren
route('POST', '/api/admin/rooms/:id/players/:pid/ack', async (req, res, { id, pid }) => {
  requireStaff(req);
  const room = getRoom(id);
  const p = getRoomPlayer(room, pid);
  const { type } = await readJson(req);
  if (type !== 'signal' && type !== 'zone') throw new HttpError(400, 'Ungültige Warnung');
  p.warnAck = { ...p.warnAck, [type]: type === 'signal' ? p.lastSeen || 0 : p.outsideSince };
  markDirty();
  return { ok: true };
});

// Offene Notfälle und Warnungen aller Räume – die Admin-Seite fragt das auf jeder Ansicht ab
route('GET', '/api/admin/alerts', (req) => {
  requireStaff(req);
  const emergencies = [];
  const warnings = [];
  for (const room of Object.values(state.rooms)) {
    for (const e of room.emergencies) {
      if (e.resolvedAt) continue;
      const p = room.players[e.playerId];
      emergencies.push({
        id: e.id, roomId: room.id, roomName: room.name, playerId: e.playerId, name: e.name,
        at: e.at, ackAt: e.ackAt, pos: p?.pos || e.pos, lastSeen: p?.lastSeen ?? null,
      });
    }
    warnings.push(...roomWarnings(room));
  }
  return {
    emergencies: emergencies.sort((a, b) => a.at - b.at),
    warnings: warnings.sort((a, b) => a.since - b.since),
  };
});

route('PATCH', '/api/admin/rooms/:id/emergencies/:eid', async (req, res, { id, eid }) => {
  const role = requireStaff(req);
  const room = getRoom(id);
  const e = room.emergencies.find((x) => x.id === eid);
  if (!e) throw new HttpError(404, 'Notfall nicht gefunden');
  const body = await readJson(req);
  if (body.ack && !e.ackAt && !e.resolvedAt) {
    e.ackAt = Date.now();
    logEvent(room, `Notfall von ${e.name}: von der ${role === 'supervisor' ? 'Aufsicht' : 'Spielleitung'} gesehen`);
  }
  if (body.resolve && !e.resolvedAt) resolveEmergency(room, e, 'admin');
  markDirty();
  return { ok: true };
});

// CSV-Export (Semikolon + BOM, damit Excel Umlaute und Spalten richtig erkennt)
function sendCsv(res, filename, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
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

route('GET', '/api/admin/rooms/:id/export/:kind', (req, res, { id, kind }) => {
  requireStaff(req);
  const room = getRoom(id);
  if (kind === 'verlauf.csv') {
    return sendCsv(res, `${fileSafe(room.name)}_verlauf.csv`, [
      ['Zeit', 'Ereignis'],
      ...room.events.map((e) => [csvTime(e.at), e.text]),
    ]);
  }
  if (kind === 'auswertung.csv') {
    const rows = [['Runde', 'Start', 'Ende', 'Ergebnis', 'Gejagte', 'Gefangen um', 'Im Spiel (min)', 'Pings', 'Extra-Pings', 'Sofort-Pings', 'Notfälle']];
    for (const r of room.rounds) {
      for (const g of r.runners.length ? r.runners : [{}]) {
        rows.push([r.no, csvTime(r.startedAt), csvTime(r.endedAt), r.reason, g.name ?? '', csvTime(g.caughtAt),
          g.survivedMin != null ? String(g.survivedMin).replace('.', ',') : '', r.pings.regular, r.pings.extra, r.pings.admin, r.emergencies]);
      }
    }
    return sendCsv(res, `${fileSafe(room.name)}_auswertung.csv`, rows);
  }
  throw new HttpError(404, 'Unbekannter Export');
});

// QR-Code als SVG für eine beliebige Spiel-URL (Spielleitung und Aufsicht)
route('GET', '/api/admin/qr.svg', async (req, res, params, url) => {
  requireStaff(req);
  const text = url.searchParams.get('text') || '';
  if (!/^https?:\/\/[^\s]{1,300}$/.test(text)) throw new HttpError(400, 'Ungültige URL');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' });
  res.end(svg);
});

// --- Spieler ----------------------------------------------------------------

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
    lastSeen: null, pos: null, caughtAt: null, wasRunner: false, outside: false,
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
  p.lastSeen = t;
  const lat = Number(b.lat), lng = Number(b.lng);
  if (b.lat != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    const age = clampInt(b.age, 0, 3600e3) || 0;
    p.pos = { lat, lng, acc: clampInt(b.acc, 0, 100000), t: t - age };
    p.geoError = null;
    updateZoneFlag(room, p);
  } else if (b.error) {
    p.geoError = String(b.error).slice(0, 40);
  }
  if (typeof b.battery === 'number') p.battery = Math.min(1, Math.max(0, b.battery));
  if (typeof b.charging === 'boolean') p.charging = b.charging;
  markDirty();
  return { ok: true };
});

route('POST', '/api/play/caught', (req) => {
  const { room, p } = authPlayer(req);
  if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft gerade nicht.');
  catchRunner(room, p, 'selbst gemeldet');
  return playerView(room, p);
});

route('POST', '/api/play/extra-ping', (req) => {
  const { room, p } = authPlayer(req);
  if (p.role !== 'hunter') throw new HttpError(403, 'Nur Jäger können Extra-Pings auslösen.');
  if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft gerade nicht.');
  if (Date.now() < room.huntStartsAt) throw new HttpError(409, 'Während des Vorsprungs gibt es keine Pings.');
  if (room.extraPingsUsed >= room.settings.extraPings) throw new HttpError(409, 'Keine Extra-Pings mehr übrig.');
  room.extraPingsUsed++;
  doPing(room, 'extra', p.name);
  return playerView(room, p);
});

route('POST', '/api/play/rename', async (req) => {
  const { room, p } = authPlayer(req);
  if (room.status !== 'lobby') throw new HttpError(409, 'Umbenennen geht nur vor dem Spiel.');
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
  removePlayer(room, p, 'player');
  logEvent(room, `${p.name} hat das Spiel verlassen`);
  return { ok: true };
});

// Mister-X-Stil: Gejagte melden beim Einsteigen ihr Verkehrsmittel (nur die Art, keine Linie)
route('POST', '/api/play/transport', async (req) => {
  const { room, p } = authPlayer(req);
  if (!room.settings.transportReports) throw new HttpError(409, 'Verkehrsmittel-Meldungen sind in diesem Spiel aus.');
  if (room.status !== 'running' || p.role !== 'runner') throw new HttpError(409, 'Nur Gejagte melden im laufenden Spiel ihr Verkehrsmittel.');
  const { mode } = await readJson(req);
  if (!TRANSPORT[mode]) throw new HttpError(400, 'Unbekanntes Verkehrsmittel');
  p.transport = { mode, at: Date.now() };
  logEvent(room, `${p.name} meldet: ${TRANSPORT[mode]}`);
  return playerView(room, p);
});

route('POST', '/api/play/sos', (req) => {
  const { room, p } = authPlayer(req);
  raiseEmergency(room, p);
  return playerView(room, p);
});

route('POST', '/api/play/sos-cancel', (req) => {
  const { room, p } = authPlayer(req);
  const e = activeEmergency(room, p.id);
  if (e) resolveEmergency(room, e, 'player');
  return playerView(room, p);
});

// ---------------------------------------------------------------------------
// Statische Dateien
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/play': 'play.html', '/print': 'print.html' };

function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : null;
}

function resolveStatic(pathname) {
  if (PAGES[pathname]) return path.join(PUBLIC_DIR, PAGES[pathname]);
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), screen-wake-lock=(self), camera=(), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:", "connect-src 'self'", "frame-ancestors 'none'",
    "base-uri 'self'", "form-action 'self'",
  ].join('; '),
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const result = await r.handler(req, res, m.groups || {}, url);
      if (!res.headersSent) sendJson(res, 200, result);
      return;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (e instanceof URIError) return sendJson(res, 400, { error: 'Ungültige Adresse' });
    console.error(e);
    sendJson(res, 500, { error: 'Serverfehler' });
  }
});

loadState();
autoDelete();
server.listen(PORT, () => {
  console.log(`Manhunt läuft auf Port ${PORT} (Daten: ${DATA_DIR})`);
  console.log(AUTO_DELETE_DAYS ? `Räume werden ${AUTO_DELETE_DAYS} Tage nach der letzten Aktivität gelöscht` : 'Automatisches Löschen ist aus');
  if (PUBLIC_URL) console.log(`Öffentliche Adresse: ${PUBLIC_URL}`);
});
