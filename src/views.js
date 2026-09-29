'use strict';

// Sichten: was die Spielleitung bzw. ein Gerät vom Raum zu sehen bekommt

const { playersOf } = require('./store');
const { currentZone, roomWarnings, activeEmergency, autoDeleteAt } = require('./game');

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, role: p.role, caughtAt: p.caughtAt, wasRunner: !!p.wasRunner,
    joinedAt: p.joinedAt, lastSeen: p.lastSeen, pos: p.pos, outside: !!p.outside,
    battery: p.battery ?? null, charging: p.charging ?? null, geoError: p.geoError || null,
    bot: !!p.bot, transport: p.transport || null,
    check: p.check || null, blocksUsed: p.blocksUsed || 0, blockArmed: !!p.blockArmed,
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

// role: 'admin' oder 'supervisor' – den Wiederbeitritts-Link (Zugang als dieses Gerät) bekommt nur die Spielleitung
function adminRoom(room, role = 'admin') {
  const warnings = roomWarnings(room);
  return {
    ...roomSummary(room),
    settings: room.settings,
    ...zoneView(room),
    players: playersOf(room).map((p) => ({
      ...publicPlayer(p),
      ...(role === 'admin' && { rejoinPath: `/r/${p.token}` }),
      emergency: !!activeEmergency(room, p.id),
      warnings: warnings.filter((w) => w.playerId === p.id).map((w) => ({ type: w.type, since: w.since, acked: w.acked })),
    })),
    pings: room.status === 'lobby' ? [] : room.pings.slice(-10),
    replayPings: room.pings.length,
    events: room.events.slice(-100).map(({ at, text }) => ({ at, text })),
    rounds: room.rounds,
    serverTime: Date.now(),
  };
}

function playerView(room, me) {
  const players = playersOf(room);
  const s = room.settings;
  const emergency = activeEmergency(room, me.id);
  // Standorte, Pings und Verkehrsmittel anderer gibt es nur im laufenden Spiel und nur für Jäger –
  // in der Lobby und nach Spielende bekommt kein Handy fremde Standorte (die Auflösung zeigt das Replay am Beamer)
  const running = room.status === 'running';
  const hunterInGame = running && me.role === 'hunter';
  const showTransport = s.transportReports && hunterInGame;
  const view = {
    serverTime: Date.now(),
    room: {
      name: room.name, ...zoneView(room), meetingPoint: s.meetingPoint, emergencyPhone: s.emergencyPhone || null,
      pingIntervalMin: s.pingIntervalMin, durationMin: s.durationMin, headStartMin: s.headStartMin,
      pingWarningSec: s.pingWarningSec, transportReports: s.transportReports,
      shrinkEnabled: s.shrinkEnabled, shrinkFinalRadius: s.shrinkFinalRadius, rules: s.rules, blocksPerRunner: s.blocksPerRunner,
      ...roomTiming(room),
    },
    me: {
      id: me.id, name: me.name, role: me.role, caughtAt: me.caughtAt, outside: !!me.outside,
      emergency: emergency ? { at: emergency.at, ackAt: emergency.ackAt } : null,
      transport: me.transport || null,
      blocksLeft: me.role === 'runner' ? Math.max(0, s.blocksPerRunner - (me.blocksUsed || 0)) : 0,
      blockArmed: !!me.blockArmed,
      check: me.check || null,
    },
    runners: players.filter((p) => p.role === 'runner' || p.wasRunner)
      .map((p) => ({ name: p.name, caughtAt: p.caughtAt, ...(showTransport && { transport: p.transport || null }) })),
    hunterCount: players.filter((p) => p.role === 'hunter').length,
    lastPingAt: running ? room.pings.at(-1)?.at ?? null : null,
    lastPingKind: running ? room.pings.at(-1)?.kind ?? null : null,
  };
  if (room.status === 'lobby') view.lobby = players.map((p) => p.name);
  if (hunterInGame) {
    view.pings = room.pings.slice(-4);
    view.hunters = players
      .filter((p) => p.role === 'hunter' && p.id !== me.id && p.pos)
      .map((p) => ({ name: p.name, lat: p.pos.lat, lng: p.pos.lng, t: p.pos.t }));
  }
  return view;
}

module.exports = { publicPlayer, roomSummary, adminRoom, playerView };
