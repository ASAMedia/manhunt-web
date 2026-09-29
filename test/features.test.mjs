// Aufsicht, Warnungen, Verkehrsmittel, schrumpfendes Spielfeld, Regeln, Test-Geräte, Auswertung, Export
import { client, sleep } from './lib.mjs';

export default async function features({ base, adminPass: PASS, supPass: SUP, check, section }) {
  const req = client(base);
  const A = { as: 'admin' };
  const S = { as: 'sup' };

  section('Aufsicht');
  check((await req('POST', '/api/admin/login', { password: PASS }, A)).data.role === 'admin', 'Login Spielleitung → admin');
  check((await req('POST', '/api/admin/login', { password: SUP }, S)).data.role === 'supervisor', 'Login Aufsicht → supervisor');
  check((await req('GET', '/api/admin/session', undefined, S)).data.role === 'supervisor', 'Sitzung Aufsicht');
  const room = (await req('POST', '/api/admin/rooms', { name: 'Neu-Test' }, A)).data;
  check((await req('GET', '/api/admin/rooms', undefined, S)).status === 200, 'Aufsicht sieht Räume');
  check((await req('GET', `/api/admin/rooms/${room.id}`, undefined, S)).status === 200, 'Aufsicht sieht Raum');
  check((await req('POST', '/api/admin/rooms', { name: 'x' }, S)).status === 403, 'Aufsicht: Raum anlegen verboten');
  check((await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { pingIntervalMin: 2 } }, S)).status === 403, 'Aufsicht: Einstellungen verboten');
  check((await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, S)).status === 403, 'Aufsicht: Start verboten');
  check((await req('POST', `/api/admin/rooms/${room.id}/bots`, { runners: 1 }, S)).status === 403, 'Aufsicht: Test-Geräte verboten');
  check((await req('DELETE', `/api/admin/rooms/${room.id}`, undefined, S)).status === 403, 'Aufsicht: Löschen verboten');
  check((await req('POST', `/api/admin/rooms/${room.id}/message`, { text: 'Hallo von der Aufsicht' }, S)).status === 200, 'Aufsicht: Nachricht erlaubt');
  let adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  check(adm.events.some((e) => e.text === 'Nachricht an alle (Aufsicht): Hallo von der Aufsicht'), 'Verlauf nennt Aufsicht');
  check((await req('GET', '/api/admin/alerts', undefined, S)).status === 200, 'Aufsicht: Alarmliste erlaubt');

  section('Einstellungen');
  const zone = { lat: 52.517, lng: 13.3889, radius: 1000 };
  check((await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { zone, shrinkEnabled: true, shrinkFinalRadius: 1000 } }, A)).status === 400, 'End-Radius >= Radius = 400');
  adm = (await req('PATCH', `/api/admin/rooms/${room.id}`, {
    settings: {
      zone, shrinkEnabled: true, shrinkFinalRadius: 200, transportReports: true, pingWarningSec: 30, signalAlarmMin: 0.05,
      rules: 'Eigene Regeln\n• Zeile 2', durationMin: 5, headStartMin: 0, pingIntervalMin: 1,
    },
  }, A)).data;
  const st = adm.settings;
  check(st.shrinkEnabled && st.shrinkFinalRadius === 200 && st.transportReports && st.pingWarningSec === 30 && st.signalAlarmMin === 0.1 && st.rules === 'Eigene Regeln\n• Zeile 2',
    'Neue Einstellungen gespeichert (0,05 min → 0,1 gerundet)', st);
  // 0,1 min = 6 s Signal-Grenze für den Test
  const tok = {};
  for (const n of ['R1', 'R2', 'H1']) tok[n] = (await req('POST', `/api/join/${room.code}`, { name: n })).data.token;
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  const pid = (n) => adm.players.find((p) => p.name === n).id;
  for (const [n, r] of [['R1', 'runner'], ['R2', 'runner'], ['H1', 'hunter']]) await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid(n)}`, { role: r }, A);
  for (const n of ['R1', 'R2', 'H1']) await req('POST', '/api/play/pos', { lat: 52.5175, lng: 13.389, acc: 10 }, { token: tok[n] });

  section('Spiel mit neuen Optionen');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, A)).data;
  check(adm.status === 'running', 'gestartet');
  await sleep(1500);
  let pv = (await req('GET', '/api/play/state', undefined, { token: tok.R1 })).data;
  check(pv.room.zone.radius < 1000 && pv.room.zone.radius > 900 && pv.room.zoneFinalRadius === 200, 'Spielfeld schrumpft (aktueller + End-Radius)', pv.room.zone);
  check(pv.room.rules === 'Eigene Regeln\n• Zeile 2' && pv.room.pingWarningSec === 30 && pv.room.transportReports, 'Spieler bekommt Regeln + Optionen');
  pv = (await req('POST', '/api/play/transport', { mode: 'U' }, { token: tok.R1 })).data;
  check(pv.me.transport?.mode === 'U', 'Gejagter meldet U-Bahn');
  check((await req('POST', '/api/play/transport', { mode: 'Rakete' }, { token: tok.R1 })).status === 400, 'Unbekanntes Verkehrsmittel = 400');
  check((await req('POST', '/api/play/transport', { mode: 'Bus' }, { token: tok.H1 })).status === 409, 'Jäger kann nicht melden');
  const hv = (await req('GET', '/api/play/state', undefined, { token: tok.H1 })).data;
  check(hv.runners.find((r) => r.name === 'R1')?.transport?.mode === 'U', 'Jäger sieht Verkehrsmittel');
  const rv = (await req('GET', '/api/play/state', undefined, { token: tok.R2 })).data;
  check(rv.runners.every((r) => !('transport' in r)), 'Gejagte sehen keine Verkehrsmittel anderer');

  section('Warnungen');
  await sleep(6500);
  await req('POST', '/api/play/pos', { lat: 52.5175, lng: 13.389, acc: 10 }, { token: tok.R1 });
  let al = (await req('GET', '/api/admin/alerts', undefined, S)).data;
  const sigR2 = al.warnings.find((w) => w.name === 'R2' && w.type === 'signal');
  check(sigR2 && !sigR2.acked, 'Signalverlust R2 gemeldet', al.warnings);
  check(!al.warnings.some((w) => w.name === 'R1' && w.type === 'signal'), 'R1 sendet → keine Warnung');
  check((await req('POST', `/api/admin/rooms/${room.id}/players/${pid('R2')}/ack`, { type: 'signal' }, S)).status === 200, 'Aufsicht quittiert');
  al = (await req('GET', '/api/admin/alerts', undefined, A)).data;
  check(al.warnings.find((w) => w.name === 'R2' && w.type === 'signal')?.acked === true, 'Warnung als quittiert markiert');
  await req('POST', '/api/play/pos', { lat: 52.5175, lng: 13.389, acc: 10 }, { token: tok.R2 });
  al = (await req('GET', '/api/admin/alerts', undefined, A)).data;
  check(!al.warnings.some((w) => w.name === 'R2' && w.type === 'signal'), 'R2 sendet wieder → Warnung weg');
  await req('POST', '/api/play/pos', { lat: 52.56, lng: 13.389, acc: 10 }, { token: tok.R1 });
  al = (await req('GET', '/api/admin/alerts', undefined, A)).data;
  check(al.warnings.some((w) => w.name === 'R1' && w.type === 'zone' && !w.acked), 'Spielfeld verlassen → Warnung');
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  check(adm.warnings >= 1 && adm.players.find((p) => p.name === 'R1').warnings.some((w) => w.type === 'zone'), 'Raum zeigt Warnungen am Gerät');

  section('Auswertung + Export');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/end`, undefined, A)).data;
  const round = adm.rounds.at(-1);
  check(adm.rounds.length === 1 && round.no === 1 && round.runners.map((r) => r.name).sort().join() === 'R1,R2' && round.pings.regular >= 1, 'Runde ausgewertet', round);
  check(!JSON.stringify(adm.rounds.map(({ zone, meetingPoint, ...rest }) => rest)).includes('52.5'), 'Auswertung enthält keine Standorte von Personen (nur Spielfeld und Treffpunkt)');
  const csv = await req('GET', `/api/admin/rooms/${room.id}/export/verlauf.csv`, undefined, S);
  check(csv.status === 200 && csv.ct.includes('text/csv') && csv.data.replace(String.fromCharCode(0xfeff), '').startsWith('Zeit;Ereignis'), 'Verlauf-CSV (Aufsicht)');
  const csv2 = await req('GET', `/api/admin/rooms/${room.id}/export/auswertung.csv`, undefined, A);
  check(csv2.status === 200 && csv2.data.includes('Runde;Start;Ende') && csv2.data.includes('R1'), 'Auswertungs-CSV');
  check((await req('GET', `/api/admin/rooms/${room.id}/export/x.csv`, undefined, A)).status === 404, 'unbekannter Export = 404');
  check((await req('GET', `/api/admin/rooms/${room.id}/export/verlauf.csv`)).status === 401, 'Export nur angemeldet');
  const pr = await req('GET', '/print');
  check(pr.status === 200 && pr.ct.includes('html'), 'Druckblatt-Seite');

  section('Test-Geräte');
  const probe = (await req('POST', '/api/admin/rooms', { name: 'Probe' }, A)).data;
  await req('PATCH', `/api/admin/rooms/${probe.id}`, { settings: { zone } }, A);
  const t0 = Date.now();
  adm = (await req('POST', `/api/admin/rooms/${probe.id}/bots`, { runners: 2, hunters: 1 }, A)).data;
  check(adm.players.length === 3 && adm.players.every((p) => p.bot && p.pos) && adm.players.filter((p) => p.role === 'runner').length === 2, '3 Test-Geräte mit Position');
  const before = JSON.stringify(adm.players.map((p) => p.pos));
  await sleep(3600);
  adm = (await req('GET', `/api/admin/rooms/${probe.id}`, undefined, A)).data;
  check(JSON.stringify(adm.players.map((p) => p.pos)) !== before, 'Test-Geräte bewegen sich');
  check(adm.autoDeleteAt < t0 + 7 * 86400e3 + 1500, 'Test-Geräte verlängern das Auto-Löschen nicht', { autoDeleteAt: adm.autoDeleteAt, limit: t0 + 7 * 86400e3 });
  check(adm.bots === 3, 'Raumliste zählt Test-Geräte');
  adm = (await req('DELETE', `/api/admin/rooms/${probe.id}/bots`, undefined, A)).data;
  check(adm.players.length === 0, 'Test-Geräte entfernt');

  await req('DELETE', `/api/admin/rooms/${probe.id}`, undefined, A);
  await req('DELETE', `/api/admin/rooms/${room.id}`, undefined, A);
}
