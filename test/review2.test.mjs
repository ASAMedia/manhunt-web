// Zweite Sicherheits- und Datenschutzprüfung: Sichtbarkeit, Lobby-Standorte, Überfluten, Flächen, Schlüssel in Adressen
import { client } from './lib.mjs';

const north = (lat, m) => lat + m / 111320;

export default async function review2({ base, adminPass, supPass, check, section }) {
  const req = client(base);
  const A = { admin: true };
  const SUP = { as: 'sup' };
  // eigene Absender-Adresse: die übrigen Tests haben das Login-Limit von 127.0.0.1 schon teilweise verbraucht
  const xff = { headers: { 'X-Forwarded-For': '203.0.113.50' } };
  await req('POST', '/api/admin/login', { password: adminPass }, xff);
  await req('POST', '/api/admin/login', { password: supPass }, { ...SUP, ...xff });

  section('Sichtbarkeit und Lobby-Standorte');
  // Raum anlegen und beitreten – die Spielleitung muss dafür nicht angemeldet sein oder zuschauen
  const room = (await req('POST', '/api/admin/rooms', { name: 'Prüfung 2' }, A)).data;
  const C = { lat: 52.52, lng: 13.40 };
  const tok = {};
  for (const n of ['G1', 'J1', 'J2']) tok[n] = (await req('POST', `/api/join/${room.code}`, { name: n })).data.token;
  const pos = (t, lat, lng = C.lng) => req('POST', '/api/play/pos', { lat, lng, acc: 8 }, { token: t });
  const accepted = (await pos(tok.J1, C.lat)).data;
  await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { zone: { ...C, radius: 500 }, headStartMin: 0, durationMin: 30, pingIntervalMin: 5 } }, A);
  const adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, SUP)).data;
  check(!accepted.ignored && adm.players.find((p) => p.name === 'J1').pos?.lat === C.lat, 'Lobby: Standort angenommen, auch ohne angemeldete Spielleitung');
  const pid = (n) => adm.players.find((p) => p.name === n).id;
  await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid('G1')}`, { role: 'runner' }, A);
  await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid('J1')}`, { role: 'hunter' }, A);
  await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid('J2')}`, { role: 'hunter' }, A);
  await pos(tok.J2, C.lat);
  await pos(tok.G1, C.lat);
  const lobbyHunter = (await req('GET', '/api/play/state', undefined, { token: tok.J1 })).data;
  check(lobbyHunter.hunters === undefined && lobbyHunter.pings === undefined, 'Lobby: Jäger bekommen keine Standorte anderer Jäger');
  tok.Spaet = (await req('POST', `/api/join/${room.code}`, { name: 'Spaet' })).data.token;
  const al = (await req('GET', '/api/admin/alerts', undefined, SUP)).data;
  check(al.warnings.some((w) => w.type === 'join' && w.name === 'Spaet'), 'Warnung „neu beigetreten“ schon in der Lobby (nach Rollenverteilung)');
  check(!al.warnings.some((w) => w.type === 'join' && ['G1', 'J1', 'J2'].includes(w.name)), 'keine Warnung für rechtzeitig Beigetretene');

  await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, A);
  const runningHunter = (await req('GET', '/api/play/state', undefined, { token: tok.J1 })).data;
  const runningRunner = (await req('GET', '/api/play/state', undefined, { token: tok.G1 })).data;
  check(runningHunter.hunters?.some((h) => h.name === 'J2') && runningRunner.hunters === undefined && runningRunner.pings === undefined,
    'Im Spiel: Jäger sehen Mitjäger, Gejagte nichts');

  section('Gejagte sehen Jäger beim Ping');
  await pos(tok.J1, C.lat, C.lng + 0.001);
  await pos(tok.J2, C.lat, C.lng - 0.001);
  await req('POST', `/api/admin/rooms/${room.id}/ping`, undefined, A);
  let rv = (await req('GET', '/api/play/state', undefined, { token: tok.G1 })).data;
  const j1 = () => rv.huntersAtPing?.hunters.find((h) => h.name === 'J1');
  check(rv.huntersAtPing?.hunters.length === 2 && j1()?.lng === C.lng + 0.001 && rv.huntersAtPing.at > 0,
    'Gejagte bekommen beim Ping die Jäger-Positionen (Jäger ohne Standort fehlen)', rv.huntersAtPing);
  await pos(tok.J1, C.lat, C.lng + 0.005);
  rv = (await req('GET', '/api/play/state', undefined, { token: tok.G1 })).data;
  check(j1()?.lng === C.lng + 0.001, 'nur Momentaufnahme: spätere Bewegung der Jäger sehen Gejagte erst beim nächsten Ping');
  const hv = (await req('GET', '/api/play/state', undefined, { token: tok.J1 })).data;
  check(hv.huntersAtPing === undefined && hv.pings.every((p) => p.hunters === undefined), 'Jäger bekommen die Momentaufnahme nicht zusätzlich');

  section('Spielfeldrand mit Toleranz');
  const outsideOf = async (m) => {
    await pos(tok.G1, north(C.lat, m));
    return (await req('GET', '/api/play/state', undefined, { token: tok.G1 })).data.me.outside;
  };
  check(await outsideOf(510) === false, '10 m jenseits des Rands: noch nicht „außerhalb“ (GPS-Zittern)');
  check(await outsideOf(530) === true, '30 m jenseits: außerhalb');
  check(await outsideOf(490) === true, '10 m zurück im Feld: bleibt „außerhalb“, bis klar drinnen');
  check(await outsideOf(470) === false, '30 m im Feld: wieder drinnen');

  section('Schutz vor Überfluten');
  let limited = 0;
  for (let i = 0; i < 70 && !limited; i++) if ((await pos(tok.J2, C.lat)).status === 429) limited = i;
  check(limited > 50, `Positionen pro Handy begrenzt (429 nach ${limited})`);
  let v6 = 0;
  for (let i = 1; i <= 12 && !v6; i++) {
    const r = await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'manhunt', 'X-Forwarded-For': `2001:db8:77:1::${i.toString(16)}` },
      body: JSON.stringify({ password: 'falsch-falsch' }),
    });
    if (r.status === 429) v6 = i;
  }
  check(v6 === 11, 'IPv6: alle Adressen eines /64-Netzes teilen sich ein Limit', v6);
  // wichtige Ereignisse bleiben im Verlauf, auch wenn er überläuft
  await req('POST', '/api/play/sos', undefined, { token: tok.G1 });
  for (let i = 0; i < 310; i++) await req('POST', `/api/admin/rooms/${room.id}/message`, { text: `Test ${i}` }, A);
  const csv = (await req('GET', `/api/admin/rooms/${room.id}/export/verlauf.csv`, undefined, A)).data;
  check(csv.includes('NOTFALL von G1') && csv.includes('Runde 1 gestartet') && !csv.includes('Test 0;') && csv.includes('Test 309'),
    'Verlauf voll: Notruf und Rundenstart bleiben, alte Nachrichten fallen raus');
  await req('POST', `/api/admin/rooms/${room.id}/end`, undefined, A);
  const endedRunner = (await req('GET', '/api/play/state', undefined, { token: tok.G1 })).data;
  check(endedRunner.pings === undefined && endedRunner.huntersAtPing === undefined && endedRunner.runners.every((r) => r.transport === undefined),
    'Nach Spielende: keine Pings, keine Jäger, keine Verkehrsmittel');

  section('Flächen');
  const m2deg = ([y, x]) => [52.5 + y / 111320, 13.4 + x / 67770];
  const setPoly = (pts, extra = {}) => req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { zone: { points: pts.map(m2deg) }, ...extra } }, A);
  const bowtie = await setPoly([[0, 0], [1000, 1000], [0, 1000], [1000, 0]]);
  check(bowtie.status === 400 && bowtie.data.error.includes('überkreuzen'), 'sich überkreuzende Fläche abgelehnt', bowtie.data);
  const line = await setPoly([[0, 0], [500, 500], [1000, 1000]]);
  check(line.status === 400 && line.data.error === 'Die Fläche ist zu klein.', 'Fläche ohne Inhalt (alle Ecken auf einer Linie) abgelehnt');
  const L = [[0, 0], [0, 1000], [200, 1000], [200, 200], [1000, 200], [1000, 0]];
  const lShrink = await setPoly(L, { shrinkEnabled: true, shrinkFinalRadius: 150 });
  check(lShrink.status === 400 && lShrink.data.error.includes('schrumpfen'), 'L-Form mit Schrumpfen abgelehnt (würde aus der Fläche wandern)', lShrink.data);
  check((await setPoly(L, { shrinkEnabled: false })).status === 200, 'L-Form ohne Schrumpfen erlaubt');
  check((await setPoly([[0, 0], [0, 1000], [1000, 1000], [1000, 0]], { shrinkEnabled: true, shrinkFinalRadius: 150 })).status === 200, 'Rechteck mit Schrumpfen erlaubt');

  section('Zugangsschlüssel nicht in Adressen');
  const token = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data.players.find((p) => p.name === 'G1').rejoinPath;
  check((await req('GET', `/api/admin/qr.svg?text=${encodeURIComponent(`https://x.example${token}`)}`, undefined, A)).status === 400, 'QR mit Wiederbeitritts-Link per GET abgelehnt');
  const qr = await fetch(`${base}/api/admin/qr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'manhunt', Cookie: await cookieOf(base, adminPass) },
    body: JSON.stringify({ text: `https://x.example${token}` }),
  });
  check(qr.status === 200 && qr.headers.get('content-type').includes('svg') && qr.headers.get('cache-control') === 'no-store', 'QR per POST, nicht zwischengespeichert');
  const errRes = await fetch(`${base}/api/client-error`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'manhunt', 'X-Forwarded-For': '198.51.100.7' },
    body: JSON.stringify({ message: 'Fehler beim Beitreten', page: `/j/${room.code}` }),
  });
  const errs = (await req('GET', '/api/admin/client-errors', undefined, A)).data;
  check(errRes.status === 200 && errs.some((e) => e.page === '/j/…') && !JSON.stringify(errs).includes(room.code), 'Fehlerberichte ohne Spielcode');

  section('Wiederkommen nach geschlossenem Tab');
  const again = (await req('GET', `/api/join/${room.code}`, undefined, { token: tok.G1 })).data;
  const fresh = (await req('GET', `/api/join/${room.code}`)).data;
  check(again.member === true && fresh.member === false, 'erneuter QR-Scan mit gespeichertem Spiel erkennt das bestehende Gerät (zurück ins Spiel statt doppelt)');
  const other = (await req('POST', '/api/admin/rooms', { name: 'Anderer Raum' }, A)).data;
  check((await req('GET', `/api/join/${other.code}`, undefined, { token: tok.G1 })).data.member === false, 'Token aus einem anderen Raum zählt nicht');
  await req('DELETE', `/api/admin/rooms/${other.id}`, undefined, A);

  section('Geräte entfernen');
  const rm = (await req('POST', '/api/admin/rooms', { name: 'Entfernen' }, A)).data;
  const rt = {};
  for (const n of ['R', 'H1', 'H2', 'H3']) rt[n] = (await req('POST', `/api/join/${rm.code}`, { name: n })).data.token;
  let ra = (await req('GET', `/api/admin/rooms/${rm.id}`, undefined, A)).data;
  const rid = (n) => ra.players.find((p) => p.name === n)?.id;
  for (const [n, role] of [['R', 'runner'], ['H1', 'hunter'], ['H2', 'hunter'], ['H3', 'hunter']]) {
    await req('PATCH', `/api/admin/rooms/${rm.id}/players/${rid(n)}`, { role }, A);
  }
  await req('POST', `/api/admin/rooms/${rm.id}/start`, undefined, A);
  ra = (await req('DELETE', `/api/admin/rooms/${rm.id}/players/${rid('H1')}`, undefined, A)).data;
  const gone = await req('GET', '/api/play/state', undefined, { token: rt.H1 });
  check(!ra.players.some((p) => p.name === 'H1') && gone.status === 401 && ra.status === 'running', 'im laufenden Spiel entfernt: weg aus der Liste, Handy abgemeldet');
  await req('POST', `/api/admin/rooms/${rm.id}/end`, undefined, A);
  ra = (await req('POST', `/api/admin/rooms/${rm.id}/lobby`, undefined, A)).data;
  ra = (await req('DELETE', `/api/admin/rooms/${rm.id}/players/${rid('H2')}`, undefined, A)).data;
  check(!ra.players.some((p) => p.name === 'H2') && (await req('GET', '/api/play/state', undefined, { token: rt.H2 })).status === 401,
    'nach „Neue Runde“ in der Lobby entfernt: weg aus der Liste, Handy abgemeldet');
  await pos(rt.H2, C.lat);
  ra = (await req('GET', `/api/admin/rooms/${rm.id}`, undefined, A)).data;
  check(ra.players.length === 2 && !ra.players.some((p) => ['H1', 'H2'].includes(p.name)), 'entfernte Geräte kommen nicht zurück (auch wenn ihr Handy weiter sendet)');
  check((await req('DELETE', `/api/admin/rooms/${rm.id}/players`, undefined, SUP)).status === 403, 'Alle entfernen: nicht für die Aufsicht');
  await req('POST', `/api/admin/rooms/${rm.id}/start`, undefined, A);
  const whileRunning = await req('DELETE', `/api/admin/rooms/${rm.id}/players`, undefined, A);
  check(whileRunning.status === 409 && whileRunning.data.error.includes('Spiel beenden'), 'Alle entfernen: nicht im laufenden Spiel');
  await req('POST', `/api/admin/rooms/${rm.id}/end`, undefined, A);
  ra = (await req('DELETE', `/api/admin/rooms/${rm.id}/players`, undefined, A)).data;
  const after = await Promise.all([rt.R, rt.H3].map((t) => req('GET', '/api/play/state', undefined, { token: t })));
  check(ra.players.length === 0 && after.every((r) => r.status === 401) && ra.events.some((e) => e.text === 'Alle 2 Geräte entfernt') && ra.rounds.length === 2,
    'Alle entfernen nach Spielende: Raum leer, Handys abgemeldet, Verlauf und Auswertung bleiben', ra.events.slice(-2));
  await req('DELETE', `/api/admin/rooms/${rm.id}`, undefined, A);

  section('Einrichtungs-Check');
  const sc = (await req('GET', '/api/admin/setup-check', undefined, A)).data;
  const byTitle = (t) => sc.checks?.find((c) => c.title === t);
  check(Array.isArray(sc.checks) && sc.checks.length >= 10 && sc.serverTime > 0, 'Einrichtungs-Check liefert Prüfpunkte', sc);
  check(byTitle('HTTPS')?.status === 'warn' && byTitle('Öffentliche Adresse')?.status === 'warn', 'Test-Server ohne HTTPS/PUBLIC_URL: Warnungen');
  check(byTitle('Adressen hinter dem Proxy')?.status === 'warn', 'ohne X-Forwarded-For: Warnung zu den Geräte-Adressen');
  const viaProxy = (await req('GET', '/api/admin/setup-check', undefined, { ...A, headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' } })).data;
  const pick = (t) => viaProxy.checks.find((c) => c.title === t);
  check(pick('Adressen hinter dem Proxy').status === 'ok' && pick('Adressen hinter dem Proxy').text.includes('203.0.113.9') && pick('HTTPS').status === 'ok',
    'hinter einem korrekt eingestellten Proxy: HTTPS und Geräte-Adresse ok', viaProxy.checks.slice(0, 3));
  check(byTitle('Datenschutz-Angaben')?.status === 'warn' && byTitle('Karte')?.status === 'ok', 'fehlende Datenschutz-Angaben gemeldet, Karte erreichbar');
  check((await req('GET', '/api/admin/setup-check', undefined, SUP)).status === 403, 'Einrichtungs-Check nur für die Spielleitung');
  const cards = await req('GET', '/notfallkarten');
  check(cards.status === 200 && cards.ct.includes('html'), '/notfallkarten ausgeliefert');

  section('Abmelden beendet die Sitzung');
  const old = await cookieOf(base, adminPass);
  const hdr = { Cookie: old, 'X-Requested-With': 'manhunt' };
  check((await fetch(`${base}/api/admin/rooms`, { headers: hdr })).status === 200, 'Sitzung gültig');
  await fetch(`${base}/api/admin/logout`, { method: 'POST', headers: hdr });
  check((await fetch(`${base}/api/admin/rooms`, { headers: hdr })).status === 401, 'nach dem Abmelden ist auch ein kopiertes Cookie ungültig');
  await req('DELETE', `/api/admin/rooms/${room.id}`, undefined, A);
}

async function cookieOf(base, password) {
  const r = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'manhunt', 'X-Forwarded-For': '203.0.113.51' }, body: JSON.stringify({ password }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}
