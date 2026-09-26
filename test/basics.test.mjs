// Grundfunktionen: Anmeldung, Räume, Beitritt, Rollen, Einstellungen, Notfall, Spielablauf, Sicherheit
import { client, sleep } from './lib.mjs';

export default async function basics({ base, adminPass: PASS, check, section }) {
  const req = client(base);

  section('Grundlagen');
  check((await req('GET', '/api/health')).data.ok === true, 'health');
  check((await req('GET', '/api/admin/session')).data.admin === false, 'nicht angemeldet');
  check((await req('GET', '/api/admin/rooms', undefined, { admin: true })).status === 401, 'rooms ohne Login = 401');
  check((await req('POST', '/api/admin/login', { password: 'falsch' })).status === 401, 'falsches Passwort = 401');
  check((await req('POST', '/api/admin/login', { password: PASS })).status === 200, 'Login ok');
  check((await req('GET', '/api/admin/session', undefined, { admin: true })).data.admin === true, 'Session aktiv');
  check((await req('POST', '/api/admin/rooms', { name: 'X' }, { admin: true, noHeader: true })).status === 403, 'POST ohne X-Requested-With = 403');

  section('Raum + Beitritt');
  const room = (await req('POST', '/api/admin/rooms', { name: 'Testrunde' }, { admin: true })).data;
  check(room.code?.length === 6 && room.status === 'lobby', 'Raum erstellt', room.code);
  check((await req('GET', `/api/join/${room.code.toLowerCase()}`)).data.name === 'Testrunde', 'Join-Info (Code case-insensitiv)');
  const tokens = {};
  for (const n of ['Anna', 'Ben', 'Jäger-Team 1', 'Jäger-Team 2', 'Extra']) {
    const r = await req('POST', `/api/join/${room.code}`, { name: n });
    tokens[n] = r.data.token;
    check(r.status === 200 && tokens[n], `Beitritt ${n}`);
  }
  check((await req('POST', `/api/join/${room.code}`, { name: 'anna' })).status === 409, 'doppelter Name = 409');
  check((await req('POST', `/api/join/${room.code}`, { name: '  <>  ' })).status === 400, 'Name nur aus <> = 400');
  let st = (await req('GET', '/api/play/state', undefined, { token: tokens.Anna })).data;
  check(st.me.name === 'Anna' && st.me.role === null && st.room.code === room.code, 'Spielerstatus Lobby');
  check(st.lobby.length === 5, 'Lobby-Liste');

  section('Selbstverwaltung in der Lobby');
  check((await req('POST', '/api/play/rename', { name: 'Team Rot' }, { token: tokens['Jäger-Team 1'] })).data.me.name === 'Team Rot', 'Umbenennen');
  check((await req('POST', '/api/play/leave', undefined, { token: tokens.Extra })).status === 200, 'Gerät verlässt Spiel');
  check((await req('GET', '/api/play/state', undefined, { token: tokens.Extra })).status === 401, 'Token danach ungültig');

  section('Rollen');
  let adm = (await req('POST', `/api/admin/rooms/${room.id}/draw`, { runners: 2 }, { admin: true })).data;
  check(adm.players.filter((p) => p.role === 'runner').length === 2 && adm.players.filter((p) => p.role === 'hunter').length === 2, 'Auslosen 2 Gejagte / 2 Jäger');
  const byName = (a, n) => a.players.find((p) => p.name === n);
  for (const [n, role] of [['Anna', 'runner'], ['Ben', 'runner'], ['Team Rot', 'hunter'], ['Jäger-Team 2', 'hunter']]) {
    adm = (await req('PATCH', `/api/admin/rooms/${room.id}/players/${byName(adm, n).id}`, { role }, { admin: true })).data;
  }
  check(byName(adm, 'Anna').role === 'runner' && byName(adm, 'Team Rot').role === 'hunter', 'Rollen manuell gesetzt');

  section('Einstellungen');
  const zone = { lat: 52.517, lng: 13.3889, radius: 1000 };
  check((await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { headStartMin: 10, durationMin: 5 } }, { admin: true })).status === 400, 'Vorsprung >= Dauer = 400');
  adm = (await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { pingIntervalMin: 1, durationMin: 5, headStartMin: 0, extraPings: 1, zone } }, { admin: true })).data;
  check(adm.settings.pingIntervalMin === 1 && adm.settings.zone.radius === 1000, 'Einstellungen gespeichert');

  section('Positionen');
  const pos = { Anna: [52.518, 13.389], Ben: [52.516, 13.39], 'Team Rot': [52.52, 13.385], 'Jäger-Team 2': [52.515, 13.38] };
  const tokenOf = { Anna: tokens.Anna, Ben: tokens.Ben, 'Team Rot': tokens['Jäger-Team 1'], 'Jäger-Team 2': tokens['Jäger-Team 2'] };
  for (const [n, [lat, lng]] of Object.entries(pos)) {
    await req('POST', '/api/play/pos', { lat, lng, acc: 12, age: 1000, battery: 0.8, charging: false }, { token: tokenOf[n] });
  }
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  check(adm.players.every((p) => p.pos && p.battery === 0.8), 'Admin sieht alle Positionen + Akku');
  check(adm.players.every((p) => !p.outside), 'alle im Spielfeld');

  section('Treffpunkt + Notfall-Telefon');
  check((await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { meetingPoint: { lat: 'x', lng: 13 } } }, { admin: true })).status === 400, 'ungültiger Treffpunkt = 400');
  check((await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { emergencyPhone: 'ruf mich an' } }, { admin: true })).status === 400, 'ungültige Telefonnummer = 400');
  adm = (await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { meetingPoint: { lat: 52.5208, lng: 13.4094, label: '  Weltzeituhr <b>Alex</b> ' }, emergencyPhone: '+49 170 1234567' } }, { admin: true })).data;
  check(adm.settings.meetingPoint?.label === 'Weltzeituhr bAlex/b' && adm.settings.emergencyPhone === '+49 170 1234567', 'Treffpunkt + Telefon gespeichert, Label bereinigt', adm.settings);
  let pv = (await req('GET', '/api/play/state', undefined, { token: tokens.Anna })).data;
  check(pv.room.meetingPoint?.lat === 52.5208 && pv.room.emergencyPhone === '+49 170 1234567', 'Spieler sieht Treffpunkt + Telefon');
  check(typeof adm.autoDeleteAt === 'number' && adm.autoDeleteAt > Date.now() + 6 * 86400e3, 'Auto-Löschdatum ~7 Tage in der Zukunft');

  section('Notfall');
  pv = (await req('POST', '/api/play/sos', undefined, { token: tokens.Ben })).data;
  check(pv.me.emergency?.at && pv.me.emergency.ackAt === null, 'SOS ausgelöst');
  check((await req('POST', '/api/play/sos', undefined, { token: tokens.Ben })).status === 200, 'doppeltes SOS ok');
  let alerts = (await req('GET', '/api/admin/alerts', undefined, { admin: true })).data.emergencies;
  check(alerts.length === 1 && alerts[0].name === 'Ben' && alerts[0].pos?.lat === 52.516, 'Admin-Alarmliste: 1 Notfall mit Standort', alerts);
  check((await req('GET', '/api/admin/alerts')).status === 401, 'Alarmliste nur für Admin');
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  check(byName(adm, 'Ben').emergency === true && adm.emergencies === 1, 'Raum zeigt Notfall am Gerät');
  check((await req('PATCH', `/api/admin/rooms/${room.id}/emergencies/${alerts[0].id}`, { ack: true }, { admin: true })).status === 200, 'Notfall gesehen');
  pv = (await req('GET', '/api/play/state', undefined, { token: tokens.Ben })).data;
  check(pv.me.emergency?.ackAt > 0, 'Spieler sieht „gesehen“');
  await req('PATCH', `/api/admin/rooms/${room.id}/emergencies/${alerts[0].id}`, { resolve: true }, { admin: true });
  check((await req('GET', '/api/admin/alerts', undefined, { admin: true })).data.emergencies.length === 0, 'Notfall erledigt → Liste leer');
  check((await req('GET', '/api/play/state', undefined, { token: tokens.Ben })).data.me.emergency === null, 'Spieler: kein Notfall mehr');
  await req('POST', '/api/play/sos', undefined, { token: tokens.Anna });
  pv = (await req('POST', '/api/play/sos-cancel', undefined, { token: tokens.Anna })).data;
  check(pv.me.emergency === null, 'Entwarnung durch Spieler');
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  check(['NOTFALL von Ben!', 'Entwarnung von Anna'].every((t) => adm.events.some((e) => e.text === t)), 'Notfälle im Verlauf');
  const tmpTok = (await req('POST', `/api/join/${room.code}`, { name: 'Temp' })).data.token;
  await req('POST', '/api/play/sos', undefined, { token: tmpTok });
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  await req('DELETE', `/api/admin/rooms/${room.id}/players/${byName(adm, 'Temp').id}`, undefined, { admin: true });
  check((await req('GET', '/api/admin/alerts', undefined, { admin: true })).data.emergencies.length === 0, 'Entferntes Gerät: Notfall automatisch erledigt');

  section('Spiel');
  check((await req('POST', '/api/play/extra-ping', undefined, { token: tokenOf['Team Rot'] })).status === 409, 'Extra-Ping vor Start = 409');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, { admin: true })).data;
  check(adm.status === 'running', 'Spiel gestartet');
  await sleep(1500);
  let hunter = (await req('GET', '/api/play/state', undefined, { token: tokenOf['Team Rot'] })).data;
  let runner = (await req('GET', '/api/play/state', undefined, { token: tokens.Anna })).data;
  check(hunter.pings?.length === 1 && hunter.pings[0].positions.length === 2, 'Erster Ping bei Vorsprung 0 mit 2 Gejagten', hunter.pings);
  check(hunter.hunters?.length === 1 && hunter.hunters[0].name === 'Jäger-Team 2', 'Jäger sieht anderes Jäger-Team live');
  check(runner.pings === undefined && runner.hunters === undefined, 'Gejagter sieht weder Pings noch Jäger');
  check(runner.lastPingAt === hunter.pings[0].at, 'Gejagter kennt Ping-Zeitpunkt');
  check(JSON.stringify(runner).includes('13.385') === false, 'keine Jäger-Koordinaten im Gejagten-Status');
  check((await req('POST', '/api/play/extra-ping', undefined, { token: tokens.Anna })).status === 403, 'Gejagter kann keinen Extra-Ping');
  hunter = (await req('POST', '/api/play/extra-ping', undefined, { token: tokenOf['Jäger-Team 2'] })).data;
  check(hunter.pings.length === 2 && hunter.pings[1].kind === 'extra' && hunter.room.extraPingsLeft === 0, 'Extra-Ping ausgelöst, 0 übrig');
  check((await req('POST', '/api/play/extra-ping', undefined, { token: tokenOf['Team Rot'] })).status === 409, 'kein Extra-Ping mehr');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/ping`, undefined, { admin: true })).data;
  check(adm.pings.at(-1).kind === 'admin', 'Sofort-Ping Spielleitung');
  check((await req('POST', `/api/admin/rooms/${room.id}/draw`, { runners: 1 }, { admin: true })).status === 409, 'Auslosen im Spiel = 409');

  section('Später beitreten');
  const lateTok = (await req('POST', `/api/join/${room.code}`, { name: 'Spätstarter' })).data.token;
  const late = (await req('GET', '/api/play/state', undefined, { token: lateTok })).data;
  check(late.me.role === 'hunter' && Array.isArray(late.pings) && late.pings.length === 3, 'Beitritt im laufenden Spiel → Jäger mit Pings', late.me);
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  check(adm.events.some((e) => e.text === 'Spätstarter ist beigetreten (automatisch Jäger)'), 'Verlauf vermerkt automatischen Jäger');

  section('Spielfeld');
  await req('POST', '/api/play/pos', { lat: 52.54, lng: 13.389, acc: 10 }, { token: tokens.Ben });
  runner = (await req('GET', '/api/play/state', undefined, { token: tokens.Ben })).data;
  check(runner.me.outside === true, 'Ben außerhalb erkannt');
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  check(byName(adm, 'Ben').outside && adm.events.some((e) => e.text.includes('Ben hat das Spielfeld verlassen')), 'Admin sieht Zonenverstoß');
  await req('POST', '/api/play/pos', { lat: 52.517, lng: 13.389, acc: 10 }, { token: tokens.Ben });

  section('Nachricht');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/message`, { text: 'Alle zum Treffpunkt!' }, { admin: true })).data;
  runner = (await req('GET', '/api/play/state', undefined, { token: tokens.Ben })).data;
  check(runner.room.message?.text === 'Alle zum Treffpunkt!', 'Nachricht kommt beim Spieler an');

  section('Fangen');
  runner = (await req('POST', '/api/play/caught', undefined, { token: tokens.Anna })).data;
  check(runner.me.role === 'hunter' && runner.me.caughtAt, 'Anna meldet sich gefangen → Jäger');
  check(Array.isArray(runner.pings), 'Anna sieht jetzt Pings');
  adm = (await req('PATCH', `/api/admin/rooms/${room.id}/players/${byName(adm, 'Anna').id}`, { caught: false }, { admin: true })).data;
  check(byName(adm, 'Anna').role === 'runner', 'Korrektur: Anna wieder Gejagte');
  await req('POST', '/api/play/caught', undefined, { token: tokens.Anna });
  adm = (await req('PATCH', `/api/admin/rooms/${room.id}/players/${byName(adm, 'Ben').id}`, { caught: true }, { admin: true })).data;
  await sleep(1500);
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).data;
  check(adm.status === 'ended' && adm.result.winner === 'hunters', 'Alle gefangen → Jäger gewinnen', adm.result);
  runner = (await req('GET', '/api/play/state', undefined, { token: tokens.Ben })).data;
  check(runner.runners.length === 2 && runner.runners.every((r) => r.caughtAt), 'Endübersicht Gejagte');

  section('Neue Runde');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/lobby`, undefined, { admin: true })).data;
  check(adm.status === 'lobby' && byName(adm, 'Anna').role === 'runner' && byName(adm, 'Ben').role === 'runner', 'Lobby: Startrollen wiederhergestellt');
  const lobbyLate = (await req('POST', `/api/join/${room.code}`, { name: 'Lobby-Nachzügler' })).data.token;
  check((await req('GET', '/api/play/state', undefined, { token: lobbyLate })).data.me.role === 'hunter', 'Beitritt in Lobby nach Rollenverteilung → Jäger');
  const fresh = (await req('POST', '/api/admin/rooms', { name: 'Frisch' }, { admin: true })).data;
  const freshTok = (await req('POST', `/api/join/${fresh.code}`, { name: 'Erste' })).data.token;
  check((await req('GET', '/api/play/state', undefined, { token: freshTok })).data.me.role === null, 'Beitritt vor Rollenverteilung → keine Rolle');
  await req('DELETE', `/api/admin/rooms/${fresh.id}`, undefined, { admin: true });

  section('Zeitablauf');
  await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { durationMin: 5, headStartMin: 1 } }, { admin: true });
  adm = (await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, { admin: true })).data;
  check(adm.huntStartsAt - adm.startedAt === 60000 && adm.endsAt - adm.startedAt === 300000, 'Vorsprung/Ende geplant');
  check((await req('POST', '/api/play/extra-ping', undefined, { token: tokenOf['Team Rot'] })).status === 409, 'Extra-Ping im Vorsprung = 409');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/end`, undefined, { admin: true })).data;
  check(adm.status === 'ended', 'Spiel manuell beendet');

  section('Sonstiges');
  const qr = await req('GET', `/api/admin/qr.svg?text=${encodeURIComponent('https://x.example/j/' + room.code)}`, undefined, { admin: true });
  check(qr.status === 200 && qr.ct.includes('svg') && qr.data.startsWith('<svg'), 'QR-SVG');
  check((await req('GET', `/api/admin/qr.svg?text=javascript:alert(1)`, undefined, { admin: true })).status === 400, 'QR nur für http(s)');
  const rejoin = await req('GET', byName(adm, 'Anna').rejoinPath);
  check(rejoin.status === 200 && rejoin.ct.includes('html'), 'Rejoin-Seite');
  check((await req('GET', '/vendor/leaflet/leaflet.js')).status === 200, 'Leaflet ausgeliefert');
  check((await req('GET', '/../server.js')).status === 404, 'kein Pfad-Ausbruch');
  check((await req('GET', '/%2e%2e/server.js')).status !== 200, 'kein Pfad-Ausbruch (kodiert)');
  check((await req('DELETE', `/api/admin/rooms/${room.id}`, undefined, { admin: true })).status === 200, 'Raum gelöscht');
  check((await req('GET', '/api/play/state', undefined, { token: tokens.Anna })).status === 401, 'Spieler-Token nach Löschen ungültig');

}
