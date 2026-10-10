'use strict';

// API der Spielleitung (/api/admin/…) – Aufsicht darf ansehen, Notfälle bearbeiten und Nachrichten senden.
// Jeder Raum gehört einem Inhaber (Admin oder Lehrkräfte-Konto); roomFor() prüft, wer ihn sehen bzw. steuern darf.

const QRCode = require('qrcode');
const { ADMIN_PASSWORD, SUPERVISOR_PASSWORD, ADMIN_SESSION_MS, MAX_ROOMS_PER_USER } = require('../config');
const { HttpError, randomId, cleanName, cleanText } = require('../util');
const { state, playersOf, markDirty, logEvent } = require('../store');
const game = require('../game');
const { roomSummary, adminRoom } = require('../views');
const {
  route, readJson, rateLimit, countOf, safeEqual, session, principalFor, startSession, revokeSession, setAdminCookie,
  requireLogin, requireManager, canView, ownsForAlerts, roomFor, getRoomPlayer, sendCsv, csvTime, fileSafe,
  keyCount, limitKey, requireOwnPage, ownerActive,
} = require('../http');
const accounts = require('../accounts');

const ROOM_NAME_MAX = 40;

// Wer ist angemeldet? (für die Admin-Seite: Rolle, Konto-Art, Name)
function accountInfo(p) {
  if (!p) return null;
  const room = p.kind === 'roomsup' ? state.rooms[p.roomId] : null;
  return {
    kind: p.kind,
    name: p.kind === 'manager' ? p.user.name : p.kind === 'roomsup' ? `Aufsicht „${room?.name}“` : p.kind === 'admin' ? 'Admin' : 'Aufsicht',
    email: p.user?.email ?? null,
    roomId: p.roomId ?? null,
  };
}

route('GET', '/api/admin/session', (req) => {
  const p = session(req);
  return { admin: !!p, role: p?.role ?? null, account: accountInfo(p) };
});

// Fehlversuche insgesamt (über alle Absender) – bremst verteiltes Passwort-Raten
let failed = { n: 0, reset: 0 };

route('POST', '/api/admin/login', async (req, res) => {
  requireOwnPage(req);
  rateLimit(req, 'login', 10, 5 * 60e3);
  const t = Date.now();
  if (failed.reset < t) failed = { n: 0, reset: t + 15 * 60e3 };
  // Bei sehr vielen Fehlversuchen insgesamt dürfen nur noch Absender ohne eigene Fehlversuche probieren –
  // so sperrt ein Angriff die Spielleitung (neues Netz, richtiges Passwort) nicht aus
  if (failed.n >= 100 && countOf(req, 'login-fail') >= 2) throw new HttpError(429, 'Zu viele Fehlversuche – bitte in einigen Minuten erneut versuchen.');
  const { email, password } = await readJson(req);
  const pw = typeof password === 'string' ? password : '';
  const fail = (msg) => {
    failed.n++;
    rateLimit(req, 'login-fail', 1e6, 15 * 60e3); // zählt nur mit
    throw new HttpError(401, msg);
  };
  let holder;
  if (typeof email === 'string' && email.trim()) {
    // Je Konto höchstens 10 Fehlversuche in 15 Minuten – egal von wie vielen Adressen (gegen verteiltes Raten)
    const acctKey = `login-acct:${email.trim().toLowerCase().slice(0, 200)}`;
    if (keyCount(acctKey) >= 10) throw new HttpError(429, 'Zu viele Fehlversuche für dieses Konto – bitte in 15 Minuten erneut versuchen.');
    const u = await accounts.checkLogin(email, pw);
    if (!u) {
      try { limitKey(acctKey, 1e6, 15 * 60e3); } catch { /* zählt nur mit */ }
      fail('E-Mail oder Passwort falsch');
    }
    if (u.status === 'pending') throw new HttpError(403, 'Dein Konto wartet noch auf die Freigabe durch den Admin.');
    if (u.status !== 'active') throw new HttpError(403, 'Dieses Konto ist gesperrt. Bitte beim Admin melden.');
    u.lastLoginAt = Date.now();
    markDirty();
    holder = `u:${u.id}:${u.sessionVersion}`;
  } else {
    holder = safeEqual(pw, ADMIN_PASSWORD) ? 'admin'
      : SUPERVISOR_PASSWORD && safeEqual(pw, SUPERVISOR_PASSWORD) ? 'supervisor' : null;
    if (!holder) fail('Falsches Passwort');
  }
  startSession(req, res, holder, ADMIN_SESSION_MS);
  const p = principalFor(holder);
  return { admin: true, role: p.role, account: accountInfo(p) };
});

// Aufsicht-Link: meldet dieses Gerät als Aufsicht genau eines Raums an (nur ansehen, Notfälle, Nachrichten)
route('POST', '/api/admin/sup-login', async (req, res) => {
  requireOwnPage(req);
  rateLimit(req, 'sup-login', 30, 5 * 60e3);
  const { token } = await readJson(req);
  const t = typeof token === 'string' ? token : '';
  const room = t.length >= 16 && Object.values(state.rooms).find((r) => r.supLink && safeEqual(r.supLink.token, t) && ownerActive(r));
  if (!room) throw new HttpError(404, 'Dieser Aufsicht-Link ist ungültig oder wurde zurückgezogen.');
  startSession(req, res, `s:${room.id}:${room.supLink.id}`, ADMIN_SESSION_MS);
  logEvent(room, 'Aufsicht über den Aufsicht-Link angemeldet');
  return { admin: true, role: 'supervisor', roomId: room.id, account: { kind: 'roomsup', name: `Aufsicht „${room.name}“`, roomId: room.id } };
});

route('POST', '/api/admin/logout', (req, res) => {
  // nur aus der eigenen Seite – sonst könnte eine fremde Seite die Spielleitung mitten im Spiel abmelden
  if (req.headers['x-requested-with'] !== 'manhunt') throw new HttpError(403, 'Ungültige Anfrage');
  revokeSession(req); // das alte Cookie gilt danach auch dann nicht mehr, wenn es jemand kopiert hat
  setAdminCookie(req, res, '', 0);
  return { admin: false };
});

route('GET', '/api/admin/rooms', (req) => {
  const p = requireLogin(req);
  return Object.values(state.rooms).filter((r) => canView(p, r)).sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({ ...roomSummary(r), own: r.ownerId === p.owner || r.id === p.roomId, ownerName: accounts.ownerName(r.ownerId) }));
});

// Neuer Raum – mit copyFrom werden die Einstellungen eines bestehenden Raums übernommen (ohne Geräte und Verlauf)
route('POST', '/api/admin/rooms', async (req) => {
  const p = requireManager(req);
  const body = await readJson(req);
  const template = body.copyFrom != null ? roomFor(req, String(body.copyFrom)).room : null;
  if (p.kind === 'manager' && Object.values(state.rooms).filter((r) => r.ownerId === p.owner).length >= MAX_ROOMS_PER_USER) {
    throw new HttpError(409, `Höchstens ${MAX_ROOMS_PER_USER} Räume je Konto – bitte alte Räume löschen.`);
  }
  const mine = Object.values(state.rooms).filter((r) => r.ownerId === p.owner).length;
  const fallback = template ? cleanName(`${template.name} (Kopie)`, ROOM_NAME_MAX) : `Raum ${mine + 1}`;
  return adminRoom(game.createRoom(cleanName(body.name, ROOM_NAME_MAX) || fallback, template, p.owner), p);
});

route('GET', '/api/admin/rooms/:id', (req, res, { id }) => {
  const { p, room } = roomFor(req, id);
  return adminRoom(room, p);
});

route('PATCH', '/api/admin/rooms/:id', async (req, res, { id }) => {
  const { p, room } = roomFor(req, id, { manage: true });
  const body = await readJson(req);
  if (body.name != null) room.name = cleanName(body.name, ROOM_NAME_MAX) || room.name;
  if (typeof body.joinOpen === 'boolean') {
    room.joinOpen = body.joinOpen;
    logEvent(room, body.joinOpen ? 'Beitritt geöffnet' : 'Beitritt geschlossen');
  }
  if (body.settings && typeof body.settings === 'object') game.applySettings(room, body.settings);
  markDirty();
  return adminRoom(room, p);
});

route('DELETE', '/api/admin/rooms/:id', (req, res, { id }) => {
  game.deleteRoom(roomFor(req, id, { manage: true }).room);
  return { ok: true };
});

route('POST', '/api/admin/rooms/:id/:action', async (req, res, { id, action }) => {
  // Nachrichten darf auch die Aufsicht senden, alles andere nur die Spielleitung
  const { p, room } = roomFor(req, id, { manage: action !== 'message' });
  const body = await readJson(req);
  switch (action) {
    case 'start': game.startGame(room); break;
    case 'end':
      if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft nicht.');
      game.endGame(room, null, 'Spiel von der Spielleitung beendet');
      break;
    case 'lobby': game.backToLobby(room); break;
    case 'ping':
      if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft nicht.');
      game.doPing(room, 'admin');
      break;
    case 'time': game.adjustTime(room, body.minutes); break;
    case 'draw': game.drawRoles(room, body.runners); break;
    case 'message': {
      const text = cleanText(body.text, 300);
      room.message = text ? { id: randomId(6), text, at: Date.now() } : null;
      const who = p.role === 'supervisor' ? ' (Aufsicht)' : p.kind === 'admin' && room.ownerId !== 'admin' ? ' (Admin)' : '';
      logEvent(room, text ? `Nachricht an alle${who}: ${text}` : `Nachricht gelöscht${who}`);
      break;
    }
    case 'bots': game.addBots(room, body.runners, body.hunters); break;
    // Aufsicht-Link (neu) erzeugen – ein alter Link und damit angemeldete Geräte werden ungültig
    case 'suplink':
      // Der Admin sieht den Schlüssel fremder Räume nicht – einen neuen zu erzeugen würde nur den der Lehrkraft entwerten
      if (p.kind === 'admin' && room.ownerId !== 'admin') throw new HttpError(403, 'Den Aufsicht-Link verwaltet die Lehrkraft, der der Raum gehört.');
      room.supLink = { id: randomId(6), token: randomId(24), at: Date.now() };
      logEvent(room, 'Aufsicht-Link erzeugt (ein älterer Link gilt nicht mehr)');
      break;
    default: throw new HttpError(404, 'Unbekannte Aktion');
  }
  markDirty();
  return adminRoom(room, p);
});

route('PATCH', '/api/admin/rooms/:id/players/:pid', async (req, res, { id, pid }) => {
  const { p: who, room } = roomFor(req, id, { manage: true });
  const p = getRoomPlayer(room, pid);
  const body = await readJson(req);
  if (body.name != null) {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Name fehlt');
    if (playersOf(room).some((o) => o.id !== p.id && o.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Name schon vergeben');
    p.name = name;
  }
  if ('role' in body) {
    if (body.role !== null && !game.ROLES.has(body.role)) throw new HttpError(400, 'Ungültige Rolle');
    if (room.status === 'running' && body.role === null) throw new HttpError(409, 'Im laufenden Spiel braucht jedes Gerät eine Rolle.');
    p.role = body.role;
    if (room.status === 'running' && p.role === 'runner') p.wasRunner = true;
    if (p.role === 'runner') p.caughtAt = null;
  }
  if (typeof body.caught === 'boolean') {
    if (room.status !== 'running') throw new HttpError(409, 'Das Spiel läuft nicht.');
    if (body.caught) game.catchRunner(room, p, 'Spielleitung');
    else game.releaseRunner(room, p);
  }
  markDirty();
  return adminRoom(room, who);
});

route('DELETE', '/api/admin/rooms/:id/players/:pid', (req, res, { id, pid }) => {
  const { p: who, room } = roomFor(req, id, { manage: true });
  const p = getRoomPlayer(room, pid);
  game.removePlayer(room, p, 'admin');
  logEvent(room, `${p.name} wurde entfernt`);
  return adminRoom(room, who);
});

route('DELETE', '/api/admin/rooms/:id/players', (req, res, { id }) => {
  const { p, room } = roomFor(req, id, { manage: true });
  game.removeAllPlayers(room);
  return adminRoom(room, p);
});

route('DELETE', '/api/admin/rooms/:id/rounds', (req, res, { id }) => {
  const { p, room } = roomFor(req, id, { manage: true });
  game.resetEvaluation(room);
  return adminRoom(room, p);
});

route('DELETE', '/api/admin/rooms/:id/bots', (req, res, { id }) => {
  const { p, room } = roomFor(req, id, { manage: true });
  game.removeBots(room);
  return adminRoom(room, p);
});

// Aufsicht-Link zurückziehen – damit angemeldete Geräte verlieren den Zugang sofort
route('DELETE', '/api/admin/rooms/:id/suplink', (req, res, { id }) => {
  const { p, room } = roomFor(req, id, { manage: true });
  if (room.supLink) logEvent(room, 'Aufsicht-Link zurückgezogen');
  room.supLink = null;
  markDirty();
  return adminRoom(room, p);
});

// Warnung (Signalverlust / außerhalb) für genau diesen Vorfall quittieren
route('POST', '/api/admin/rooms/:id/players/:pid/ack', async (req, res, { id, pid }) => {
  const { room } = roomFor(req, id);
  const p = getRoomPlayer(room, pid);
  const { type } = await readJson(req);
  if (!['signal', 'zone', 'join', 'battery'].includes(type)) throw new HttpError(400, 'Ungültige Warnung');
  p.warnAck = { ...p.warnAck, [type]: { signal: p.lastSeen || 0, zone: p.outsideSince, join: p.joinedAt, battery: p.batteryLowSince }[type] };
  markDirty();
  return { ok: true };
});

// Offene Notfälle und Warnungen der eigenen Räume – die Admin-Seite fragt das auf jeder Ansicht ab.
// Räume anderer Lehrkräfte lösen auch beim Admin keinen Alarm aus (ihre Notfälle stehen in der Raumliste).
route('GET', '/api/admin/alerts', (req) => {
  const p = requireLogin(req);
  const own = Object.values(state.rooms).filter((r) => ownsForAlerts(p, r));
  const emergencies = [];
  const warnings = [];
  for (const room of own) {
    for (const e of room.emergencies) {
      if (e.resolvedAt) continue;
      const p = room.players[e.playerId];
      emergencies.push({
        id: e.id, roomId: room.id, roomName: room.name, playerId: e.playerId, name: e.name,
        at: e.at, receivedAt: e.receivedAt ?? null, ackAt: e.ackAt, pos: p?.pos || e.pos, lastSeen: p?.lastSeen ?? null,
      });
    }
    warnings.push(...game.roomWarnings(room));
  }
  return {
    emergencies: emergencies.sort((a, b) => a.at - b.at),
    warnings: warnings.sort((a, b) => a.since - b.since),
    // laufende Spiele: Die Admin-Seite hält dann das Display an
    running: own.filter((r) => r.status === 'running').length,
    // für den Admin: Registrierungen, die auf Freigabe warten
    pendingAccounts: p.kind === 'admin' ? Object.values(state.users).filter((u) => u.status === 'pending').length : 0,
  };
});

route('PATCH', '/api/admin/rooms/:id/emergencies/:eid', async (req, res, { id, eid }) => {
  const { p, room } = roomFor(req, id);
  const role = p.role;
  const e = room.emergencies.find((x) => x.id === eid);
  if (!e) throw new HttpError(404, 'Notfall nicht gefunden');
  const body = await readJson(req);
  if (body.ack && !e.ackAt && !e.resolvedAt) {
    e.ackAt = Date.now();
    logEvent(room, `Notfall von ${e.name}: von der ${role === 'supervisor' ? 'Aufsicht' : 'Spielleitung'} gesehen`);
  }
  if (body.resolve && !e.resolvedAt) game.resolveEmergency(room, e, 'admin');
  markDirty();
  return { ok: true };
});

// Ping-Replay für den Beamer: alle Pings der letzten bzw. laufenden Runde (keine Bewegungsspuren, keine Jäger)
route('GET', '/api/admin/rooms/:id/replay', (req, res, { id }) => {
  const { room } = roomFor(req, id);
  if (room.status === 'running') throw new HttpError(409, 'Das Replay gibt es erst nach Spielende.');
  const round = room.rounds.at(-1);
  if (!room.pings.length || !round) throw new HttpError(404, 'Für diesen Raum gibt es noch keine Pings.');
  const s = room.settings;
  // Zeiten, Gefangene, Spielfeld und Treffpunkt aus der Auswertung der letzten Runde
  const startedAt = round.startedAt;
  const zone = round.zone !== undefined ? round.zone : s.zone;
  return {
    name: room.name,
    roundNo: round.no,
    status: room.status,
    startedAt, huntStartsAt: startedAt + round.settings.headStartMin * 60e3, endsAt: startedAt + round.settings.durationMin * 60e3,
    endedAt: round.endedAt,
    result: { winner: round.winner, reason: round.reason },
    zone, shrinkFinalRadius: zone ? round.settings.shrinkFinalRadius : null,
    meetingPoint: round.meetingPoint !== undefined ? round.meetingPoint : s.meetingPoint,
    pings: room.pings.map(({ at, kind, by, positions }) => ({
      at, kind, by,
      positions: positions.map((p) => (p.lat != null ? { name: p.name, lat: p.lat, lng: p.lng } : { name: p.name, blocked: !!p.blocked, missing: !!p.missing })),
    })),
    runners: round.runners.map((r) => ({ name: r.name, caughtAt: r.caughtAt })),
  };
});

route('GET', '/api/admin/rooms/:id/export/:kind', (req, res, { id, kind }) => {
  const { room } = roomFor(req, id);
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
async function sendQr(res, text, cache) {
  if (!/^https?:\/\/[^\s]{1,300}$/.test(text)) throw new HttpError(400, 'Ungültige URL');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': cache });
  res.end(svg);
}

route('GET', '/api/admin/qr.svg', async (req, res, params, url) => {
  requireLogin(req);
  const text = url.searchParams.get('text') || '';
  // Wiederbeitritts-Links enthalten den Zugangsschlüssel – die nur per POST (nicht in Adresse, Verlauf oder Cache)
  if (/\/r\//.test(text)) throw new HttpError(400, 'Wiederbeitritts-Links bitte per POST');
  await sendQr(res, text, 'private, max-age=300');
});

route('POST', '/api/admin/qr', async (req, res) => {
  requireLogin(req);
  const { text } = await readJson(req);
  await sendQr(res, String(text ?? ''), 'no-store');
});
