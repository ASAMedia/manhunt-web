'use strict';

// Spiellogik: Räume, Einstellungen, Runden, Pings, Fangen, Blocks, Spielfeld, Warnungen,
// Notfälle, Test-Geräte, automatisches Löschen und der Sekundentakt

const crypto = require('node:crypto');
const { MAP_CENTER, MAX_PINGS, MAX_PLAYERS, AUTO_DELETE_DAYS } = require('./config');
const { HttpError, randomId, distanceM, offsetPoint, bearingTo, cleanName, cleanText, clampInt, clampNum } = require('./util');
const { state, tokenIndex, playersOf, saveState, markDirty, logEvent } = require('./store');

const ROLES = new Set(['hunter', 'runner']);
const TRANSPORT = { U: 'U-Bahn', S: 'S-Bahn', Bus: 'Bus', Tram: 'Tram', Fuss: 'zu Fuß' };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 Zeichen, ohne I/O/0/1

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
    blocksPerRunner: 1,       // so oft darf jeder Gejagte einen Ping aussetzen (0 = aus)
  };
}

// Räume aus älteren Versionen um neue Felder ergänzen
function migrateRoom(room) {
  room.emergencies ??= [];
  room.rounds ??= [];
  room.settings = { ...defaultSettings(), ...room.settings };
}

// --- Räume -------------------------------------------------------------------

function newRoomCode() {
  const used = new Set(Object.values(state.rooms).map((r) => r.code));
  let code;
  do code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % 32]).join('');
  while (used.has(code));
  return code;
}

// template: optional ein bestehender Raum, dessen Einstellungen (Spielfeld, Treffpunkt, Regeln …) übernommen werden
function createRoom(name, template = null) {
  const room = {
    id: randomId(6),
    name,
    code: newRoomCode(),
    joinOpen: true,
    createdAt: Date.now(),
    settings: template ? structuredClone({ ...defaultSettings(), ...template.settings }) : defaultSettings(),
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
  logEvent(room, template ? `Raum erstellt (Einstellungen von „${template.name}“ übernommen)` : 'Raum erstellt');
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
  if (input.rules != null) s.rules = cleanText(input.rules, 3000);
  if (input.blocksPerRunner != null) s.blocksPerRunner = clampInt(input.blocksPerRunner, 0, 5) ?? s.blocksPerRunner;
  if (s.headStartMin >= s.durationMin) throw new HttpError(400, 'Der Vorsprung muss kürzer als die Spieldauer sein.');
  if (s.shrinkEnabled && s.zone && s.shrinkFinalRadius >= s.zone.radius) {
    throw new HttpError(400, 'Der End-Radius muss kleiner sein als der Spielfeld-Radius.');
  }
  room.settings = s;
  if (room.status === 'running') schedule(room);
  for (const p of playersOf(room)) updateZoneFlag(room, p, false);
  markDirty();
}

// --- Runden ------------------------------------------------------------------

function schedule(room) {
  const s = room.settings;
  room.huntStartsAt = room.startedAt + s.headStartMin * 60e3;
  room.endsAt = room.startedAt + s.durationMin * 60e3;
  const lastRegular = room.pings.findLast((p) => p.kind === 'regular');
  room.nextPingAt = lastRegular ? lastRegular.at + s.pingIntervalMin * 60e3 : room.huntStartsAt;
}

function resetRoundFields(p) {
  p.caughtAt = null;
  p.transport = null;
  p.blocksUsed = 0;
  p.blockArmed = false;
}

function startGame(room) {
  if (room.status !== 'lobby') throw new HttpError(409, 'Starten geht nur aus der Lobby.');
  const players = playersOf(room);
  if (players.some((p) => !p.role)) throw new HttpError(409, 'Noch nicht alle Geräte haben eine Rolle.');
  const hunters = players.filter((p) => p.role === 'hunter').length;
  const runners = players.filter((p) => p.role === 'runner').length;
  if (!hunters || !runners) throw new HttpError(409, 'Es braucht mindestens einen Jäger und einen Gejagten.');
  for (const p of players) {
    resetRoundFields(p);
    p.wasRunner = p.role === 'runner';
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
    blocks: playersOf(room).reduce((sum, p) => sum + (p.blocksUsed || 0), 0),
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
    p.wasRunner = false;
    resetRoundFields(p);
  }
  logEvent(room, 'Zurück in der Lobby');
}

// Ping: Positionen aller Gejagten. Wer vorher einen Block eingesetzt hat, bleibt bei genau diesem Ping unsichtbar.
function doPing(room, kind, by) {
  const at = Date.now();
  let blocked = 0;
  const positions = playersOf(room)
    .filter((p) => p.role === 'runner')
    .map((p) => {
      if (p.blockArmed) {
        p.blockArmed = false;
        blocked++;
        return { playerId: p.id, name: p.name, blocked: true };
      }
      return p.pos
        ? { playerId: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, acc: p.pos.acc, t: p.pos.t }
        : { playerId: p.id, name: p.name, missing: true };
    });
  room.pings.push({ id: randomId(6), at, kind, by: by || null, positions });
  if (room.pings.length > MAX_PINGS) room.pings.splice(0, room.pings.length - MAX_PINGS);
  if (kind === 'regular') {
    const iv = room.settings.pingIntervalMin * 60e3;
    do room.nextPingAt += iv; while (room.nextPingAt <= at);
  }
  const label = { regular: 'Ping', admin: 'Sofort-Ping (Spielleitung)', extra: `Extra-Ping von ${by}` }[kind];
  logEvent(room, `${label}: ${positions.length} Gejagte${blocked ? `, davon ${blocked} blockiert` : ''}`);
}

function armBlock(room, p) {
  if (room.status !== 'running' || p.role !== 'runner') throw new HttpError(409, 'Nur Gejagte können im laufenden Spiel blocken.');
  if (p.blockArmed) throw new HttpError(409, 'Der nächste Ping ist schon blockiert.');
  if ((p.blocksUsed || 0) >= room.settings.blocksPerRunner) throw new HttpError(409, 'Keine Blocks mehr übrig.');
  p.blocksUsed = (p.blocksUsed || 0) + 1;
  p.blockArmed = true;
  logEvent(room, `${p.name} blockiert den nächsten Ping`);
}

function catchRunner(room, p, how) {
  if (p.role !== 'runner') throw new HttpError(409, 'Nur Gejagte können gefangen werden.');
  p.role = 'hunter';
  p.caughtAt = Date.now();
  p.wasRunner = true;
  p.blockArmed = false;
  logEvent(room, `${p.name} wurde gefangen (${how}) und ist jetzt Jäger`, p.bot);
}

function releaseRunner(room, p) {
  if (!p.caughtAt) throw new HttpError(409, `${p.name} ist nicht gefangen.`);
  p.role = 'runner';
  p.caughtAt = null;
  logEvent(room, `${p.name} ist wieder Gejagter (Korrektur Spielleitung)`);
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

// --- Spielfeld + Warnungen ---------------------------------------------------------

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
    // Wer mitten im Spiel beitritt, wird automatisch Jäger – die Aufsicht soll prüfen, ob das Gerät dazugehört
    if (!p.bot && p.joinedAt > room.startedAt) {
      out.push({ ...base, type: 'join', since: p.joinedAt, key: p.joinedAt, acked: p.warnAck?.join === p.joinedAt });
    }
  }
  return out;
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
      const target = lastPing.positions.filter((x) => x.lat != null)
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

// --- Takt ----------------------------------------------------------------------
// Jede Sekunde: Pings auslösen, Spielende prüfen. Alle 3 s: Test-Geräte bewegen, schrumpfendes Spielfeld prüfen.

let tickNo = 0;
function tick() {
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
}

function startGameTimers() {
  setInterval(tick, 1000);
  setInterval(autoDelete, 60e3);
}

module.exports = {
  ROLES, TRANSPORT, defaultSettings, migrateRoom,
  createRoom, deleteRoom, applySettings,
  startGame, endGame, backToLobby, doPing, armBlock, catchRunner, releaseRunner, drawRoles, removePlayer,
  currentZone, updateZoneFlag, roomWarnings,
  addBots, removeBots,
  activeEmergency, raiseEmergency, resolveEmergency,
  autoDeleteAt, autoDelete, startGameTimers,
};
