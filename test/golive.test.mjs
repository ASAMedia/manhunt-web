// Vor dem Live-Gang: Raum kopieren, Version, Suchmaschinen-Sperre, Fehlerberichte, Härtung
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { client, startServer, sleep } from './lib.mjs';

const lon2tile = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export default async function golive({ base, adminPass, supPass, check, section }) {
  const req = client(base);
  const A = { admin: true };
  const SUP = { as: 'sup' };
  await req('POST', '/api/admin/login', { password: adminPass });
  await req('POST', '/api/admin/login', { password: supPass }, SUP);

  section('Raum kopieren');
  const src = (await req('POST', '/api/admin/rooms', { name: 'Vorlage' }, A)).data;
  await req('PATCH', `/api/admin/rooms/${src.id}`, {
    settings: {
      zone: { lat: 52.52, lng: 13.4, radius: 1500 }, meetingPoint: { lat: 52.521, lng: 13.401, label: 'Brunnen' },
      pingIntervalMin: 7, rules: 'Eigene Regeln', blocksPerRunner: 2, emergencyPhone: '+49 30 123456',
    },
  }, A);
  await req('POST', `/api/join/${src.code}`, { name: 'Anna' });
  const copy = (await req('POST', '/api/admin/rooms', { copyFrom: src.id }, A)).data;
  check(copy.id !== src.id && copy.code !== src.code, 'Kopie ist ein eigener Raum mit eigenem Code');
  check(copy.name === 'Vorlage (Kopie)', 'Standardname „… (Kopie)“', copy.name);
  check(copy.settings.zone?.radius === 1500 && copy.settings.meetingPoint?.label === 'Brunnen'
    && copy.settings.pingIntervalMin === 7 && copy.settings.rules === 'Eigene Regeln' && copy.settings.blocksPerRunner === 2,
  'Spielfeld, Treffpunkt, Regeln und Einstellungen übernommen', copy.settings);
  check(copy.players.length === 0 && copy.status === 'lobby', 'Kopie ohne Geräte, in der Lobby');
  await req('PATCH', `/api/admin/rooms/${copy.id}`, { settings: { pingIntervalMin: 3 } }, A);
  const srcAgain = (await req('GET', `/api/admin/rooms/${src.id}`, undefined, A)).data;
  check(srcAgain.settings.pingIntervalMin === 7, 'Änderung an der Kopie ändert die Vorlage nicht');
  const named = (await req('POST', '/api/admin/rooms', { name: 'Runde 2', copyFrom: src.id }, A)).data;
  check(named.name === 'Runde 2', 'Kopie mit eigenem Namen');
  check((await req('POST', '/api/admin/rooms', { copyFrom: 'gibtsnicht' }, A)).status === 404, 'Kopie aus unbekanntem Raum = 404');
  check((await req('POST', '/api/admin/rooms', { copyFrom: src.id }, SUP)).status === 403, 'Aufsicht darf nicht kopieren');

  section('Version und Suchmaschinen');
  const cfg = (await req('GET', '/api/config')).data;
  check(/^\d+\.\d+\.\d+/.test(cfg.version), 'Version in /api/config', cfg.version);
  const robots = await fetch(`${base}/robots.txt`);
  check(robots.status === 200 && (await robots.text()).includes('Disallow: /'), 'robots.txt sperrt alles');
  for (const url of ['/', '/api/health', '/j/ABCDEF']) {
    const res = await fetch(base + url);
    check(res.headers.get('x-robots-tag') === 'noindex, nofollow', `X-Robots-Tag auf ${url}`);
  }
  const plain = await fetch(`${base}/`);
  check(!plain.headers.get('strict-transport-security'), 'kein HSTS über http');

  section('Fehlerberichte von Handys');
  const token = 'AbCdEfGhIjKlMnOpQrStUvWx';
  const rep = await req('POST', '/api/client-error', {
    message: 'TypeError: x is undefined', source: '/play.js', line: 42, col: 7,
    stack: `at render (/play.js:42:7)\nat https://example.org/r/${token}?a=1`, page: `/r/${token}`, role: 'runner', lang: 'de',
    name: 'Anna', lat: 52.5,
  }, { noHeader: true, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } });
  check(rep.status === 200, 'Fehlerbericht ohne Anmeldung angenommen');
  await req('POST', '/api/client-error', { message: 'TypeError: x is undefined', source: '/play.js', line: 42 }, {
    noHeader: true, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' },
  });
  const list = (await req('GET', '/api/admin/client-errors', undefined, SUP)).data;
  const e = list[0];
  check(list.length === 1 && e.count === 2, 'gleicher Fehler wird gezählt statt doppelt gelistet', list);
  check(e.agent === 'Safari 17 / iOS', 'nur Browser und System statt ganzer Kennung', e.agent);
  const all = JSON.stringify(list);
  check(!all.includes(token) && !all.includes('Anna') && !all.includes('52.5') && !all.includes('?a=1'),
    'kein Token, Name, Standort oder Query im Bericht', all);
  check((await req('GET', '/api/admin/client-errors')).status === 401, 'Liste nur für Spielleitung/Aufsicht');
  check((await req('DELETE', '/api/admin/client-errors', undefined, SUP)).status === 403, 'Aufsicht darf die Liste nicht leeren');
  await req('DELETE', '/api/admin/client-errors', undefined, A);
  check((await req('GET', '/api/admin/client-errors', undefined, A)).data.length === 0, 'Spielleitung leert die Liste');
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    limited = (await req('POST', '/api/client-error', { message: `Fehler ${i}` }, { noHeader: true })).status === 429;
  }
  check(limited, 'Fehlerberichte sind begrenzt (Rate-Limit)');

  section('Härtung');
  check((await req('GET', '/api/admin/rooms/__proto__', undefined, A)).status === 404, 'Raum „__proto__“ = 404 statt Absturz');
  check((await req('GET', '/api/admin/rooms/constructor', undefined, A)).status === 404, 'Raum „constructor“ = 404');
  check((await req('PATCH', `/api/admin/rooms/${src.id}/players/__proto__`, { name: 'x' }, A)).status === 404, 'Gerät „__proto__“ = 404');
  const evil = (await req('POST', `/api/join/${src.code}`, { name: '=HYPERLINK("x")' })).data.token;
  check(!!evil, 'Name mit = am Anfang darf beitreten');
  const csv = (await req('GET', `/api/admin/rooms/${src.id}/export/verlauf.csv`, undefined, A)).data;
  check(!/;=HYPERLINK/.test(csv) && csv.includes("'=HYPERLINK"), 'CSV entschärft Formeln', csv.slice(-200));
  const tx = await req('POST', '/api/play/transport', { mode: 'constructor' }, { token: evil });
  check(tx.status === 409 || tx.status === 400, 'Verkehrsmittel „constructor“ abgelehnt', tx);
  const badCookie = await fetch(`${base}/api/admin/session`, { headers: { Cookie: 'mh_admin=%E0%A4%A' } });
  check(badCookie.status === 200 && (await badCookie.json()).admin === false, 'kaputtes Cookie = nicht angemeldet statt Fehler');

  section('Sicherheits-Review');
  // Rollen: den Wiederbeitritts-Link (= Zugang als Gerät) bekommt nur die Spielleitung
  const asAdmin = (await req('GET', `/api/admin/rooms/${src.id}`, undefined, A)).data;
  const asSup = (await req('GET', `/api/admin/rooms/${src.id}`, undefined, SUP)).data;
  check(asAdmin.players.every((p) => p.rejoinPath) && asSup.players.every((p) => !p.rejoinPath), 'Aufsicht bekommt keine Wiederbeitritts-Links');
  const msg = (await req('POST', `/api/admin/rooms/${src.id}/message`, { text: 'Hallo' }, SUP)).data;
  check(msg.players.every((p) => !p.rejoinPath), 'auch nicht über „Nachricht senden“');

  // Unsichtbare Zeichen im Namen
  const zw = String.fromCharCode(0x200b);
  check((await req('POST', `/api/join/${src.code}`, { name: `Anna${zw}` })).status === 409, 'Name mit unsichtbarem Zeichen gilt als derselbe Name');

  // Beitritt während des Spiels: wird Jäger, die Aufsicht bekommt eine Warnung
  const game = (await req('POST', '/api/admin/rooms', { name: 'Nachzügler-Test' }, A)).data;
  const t = {};
  for (const n of ['G1', 'J1']) t[n] = (await req('POST', `/api/join/${game.code}`, { name: n })).data.token;
  const g1 = (await req('GET', `/api/admin/rooms/${game.id}`, undefined, A)).data;
  await req('PATCH', `/api/admin/rooms/${game.id}/players/${g1.players.find((p) => p.name === 'G1').id}`, { role: 'runner' }, A);
  await req('PATCH', `/api/admin/rooms/${game.id}/players/${g1.players.find((p) => p.name === 'J1').id}`, { role: 'hunter' }, A);
  await req('POST', `/api/admin/rooms/${game.id}/start`, undefined, A);
  await sleep(5);
  t.X = (await req('POST', `/api/join/${game.code}`, { name: 'Fremd' })).data.token;
  const pvX = (await req('GET', '/api/play/state', undefined, { token: t.X })).data;
  check(pvX.me.role === 'hunter' && pvX.room.code === undefined, 'Nachzügler wird Jäger, sieht keinen Raumcode');
  let al = (await req('GET', '/api/admin/alerts', undefined, SUP)).data;
  const jw = al.warnings.find((w) => w.type === 'join' && w.name === 'Fremd');
  check(!!jw && !jw.acked, 'Warnung „neu im laufenden Spiel“ für die Aufsicht');
  check(!al.warnings.some((w) => w.type === 'join' && ['G1', 'J1'].includes(w.name)), 'keine Warnung für Geräte, die vor dem Start da waren');
  await req('POST', `/api/admin/rooms/${game.id}/players/${jw.playerId}/ack`, { type: 'join' }, SUP);
  al = (await req('GET', '/api/admin/alerts', undefined, SUP)).data;
  check(al.warnings.find((w) => w.type === 'join' && w.name === 'Fremd')?.acked === true, 'Warnung lässt sich quittieren');

  // SOS/Entwarnung-Schleife wird gebremst – der Notruf bleibt dann aktiv
  let lastCancel = 0;
  for (let i = 0; i < 6; i++) {
    await req('POST', '/api/play/sos', undefined, { token: t.G1 });
    lastCancel = (await req('POST', '/api/play/sos-cancel', undefined, { token: t.G1 })).status;
  }
  const sos = (await req('GET', '/api/play/state', undefined, { token: t.G1 })).data;
  check(lastCancel === 429 && !!sos.me.emergency, 'nach 5 Entwarnungen ist Schluss – der Notruf bleibt aktiv');
  await req('DELETE', `/api/admin/rooms/${game.id}`, undefined, A);

  // Abmelden nur von der eigenen Seite
  check((await req('POST', '/api/admin/logout', undefined, { admin: true, noHeader: true })).status === 403, 'Abmelden ohne eigenen Header (fremde Seite) = 403');

  // Kartenkacheln: Gebiet und Zoom begrenzt
  const far9 = await req('GET', `/tiles/9/${lon2tile(0, 9)}/${lat2tile(0, 9)}.png`);
  check(far9.status === 404, 'Zoom 9 weit weg = 404');
  const east = { lat: 52.517, lng: 13.68 }; // 20 km östlich der Mitte, in keinem Spielfeld
  const z17 = `/tiles/17/${lon2tile(east.lng, 17)}/${lat2tile(east.lat, 17)}.png`;
  check((await req('GET', z17)).status === 404, 'Detail-Kachel außerhalb der Spielfelder für Spieler = 404');
  check((await req('GET', z17, undefined, A)).status === 200, 'Spielleitung darf rund um die Kartenmitte alles');
  check((await req('GET', `/tiles/16/${lon2tile(east.lng, 16)}/${lat2tile(east.lat, 16)}.png`)).status === 200, 'Stadtebene (Zoom 16) für alle');
  check((await req('GET', `/tiles/19/${lon2tile(13.3889, 19)}/${lat2tile(52.517, 19)}.png`, undefined, A)).status === 404, 'Zoom 19 wird nie geholt');

  // Falsche IP-Header umgehen das Login-Limit nicht (Proxy hängt die echte IP hinten an)
  let limitedLogin = false;
  for (let i = 0; i < 12 && !limitedLogin; i++) {
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.${i}, 10.9.8.7`, 'CF-Connecting-IP': `5.6.7.${i}` },
      body: JSON.stringify({ password: 'falsch-falsch' }),
    });
    limitedLogin = res.status === 429;
  }
  check(limitedLogin, 'Login-Limit greift trotz wechselnder gefälschter IP-Header');

  // Tippfehler bei der Löschfrist verhindert den Start
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-cfg-'));
  let refused = false;
  try {
    const s = await startServer({ ADMIN_PASSWORD: adminPass, DATA_DIR: dir, AUTO_DELETE_DAYS: '7d', TILE_PROXY: '0' });
    await s.stop();
  } catch (e) {
    refused = /AUTO_DELETE_DAYS/.test(e.message);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  check(refused, 'AUTO_DELETE_DAYS=7d verhindert den Start (statt still „nie löschen“)');
}
