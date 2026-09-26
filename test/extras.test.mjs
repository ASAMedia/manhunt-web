// Blocks, Handy-Check, englische Fehlermeldungen, App-Manifest, Seiten, Kartenkachel-Zwischenspeicher
import { client, sleep } from './lib.mjs';

const lon2tile = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export default async function extras({ base, adminPass, check, section, tiles }) {
  const req = client(base);
  const A = { admin: true };
  await req('POST', '/api/admin/login', { password: adminPass });

  section('Blocks');
  const room = (await req('POST', '/api/admin/rooms', { name: 'Block-Test' }, A)).data;
  check(room.settings.blocksPerRunner === 1, 'Standard: 1 Block pro Gejagtem');
  await req('PATCH', `/api/admin/rooms/${room.id}`, {
    settings: { zone: { lat: 52.517, lng: 13.3889, radius: 1000 }, pingIntervalMin: 1, durationMin: 5, headStartMin: 0, extraPings: 3 },
  }, A);
  const tok = {};
  for (const n of ['R1', 'R2', 'H1']) tok[n] = (await req('POST', `/api/join/${room.code}`, { name: n })).data.token;
  let adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  const pid = (n) => adm.players.find((p) => p.name === n).id;
  for (const [n, r] of [['R1', 'runner'], ['R2', 'runner'], ['H1', 'hunter']]) await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid(n)}`, { role: r }, A);
  for (const n of ['R1', 'R2', 'H1']) await req('POST', '/api/play/pos', { lat: 52.5175, lng: 13.389, acc: 10 }, { token: tok[n] });
  check((await req('POST', '/api/play/block', undefined, { token: tok.R1 })).status === 409, 'Block vor Spielstart = 409');
  await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, A);
  await sleep(1300);
  let pv = (await req('POST', '/api/play/block', undefined, { token: tok.R1 })).data;
  check(pv.me.blockArmed === true && pv.me.blocksLeft === 0, 'R1 setzt Block, 0 übrig', pv.me);
  check((await req('POST', '/api/play/block', undefined, { token: tok.R1 })).data.error === 'Der nächste Ping ist schon blockiert.', 'zweiter Block auf denselben Ping abgelehnt');
  check((await req('POST', '/api/play/block', undefined, { token: tok.H1 })).status === 409, 'Jäger kann nicht blocken');
  const hv = (await req('POST', '/api/play/extra-ping', undefined, { token: tok.H1 })).data;
  const ping = hv.pings.at(-1).positions;
  const r1 = ping.find((p) => p.name === 'R1');
  check(r1.blocked === true && r1.lat === undefined, 'Beim Ping ist R1 blockiert – ohne Koordinaten', r1);
  check(ping.find((p) => p.name === 'R2').lat === 52.5175, 'R2 beim Ping sichtbar');
  pv = (await req('GET', '/api/play/state', undefined, { token: tok.R1 })).data;
  check(pv.me.blockArmed === false, 'Block nach dem Ping verbraucht');
  const en = await req('POST', '/api/play/block', undefined, { token: tok.R1, headers: { 'X-Lang': 'en' } });
  check(en.status === 409 && en.data.error === 'No blocks left.', 'Keine Blocks mehr – Meldung auf Englisch', en.data);
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  check(adm.players.find((p) => p.name === 'R1').blocksUsed === 1 && adm.events.some((e) => e.text === 'R1 blockiert den nächsten Ping'), 'Spielleitung sieht Block');
  check(adm.events.some((e) => e.text.includes('davon 1 blockiert')), 'Verlauf nennt blockierten Ping');

  section('Handy-Check');
  check((await req('POST', '/api/play/check', {
    gps: 'ok', wakeLock: 'vielleicht', sound: 'ok', vibrate: false, battery: 7, platform: 'ios', installed: true,
  }, { token: tok.R2 })).status === 200, 'Check gemeldet');
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  const c = adm.players.find((p) => p.name === 'R2').check;
  check(c.gps === 'ok' && c.wakeLock === null && c.battery === 1 && c.platform === 'ios' && c.installed === true && c.at > 0,
    'Check-Werte bereinigt gespeichert (ungültig → null, Akku begrenzt)', c);
  pv = (await req('GET', '/api/play/state', undefined, { token: tok.R2 })).data;
  check(pv.me.check?.gps === 'ok', 'Spieler bekommt eigenen Check zurück');

  adm = (await req('POST', `/api/admin/rooms/${room.id}/end`, undefined, A)).data;
  check(adm.rounds.at(-1).blocks === 1, 'Auswertung zählt Blocks');
  adm = (await req('POST', `/api/admin/rooms/${room.id}/lobby`, undefined, A)).data;
  check(adm.players.every((p) => p.blocksUsed === 0 && !p.blockArmed), 'Neue Runde setzt Blocks zurück');

  section('Englische Meldungen');
  const nope = await req('GET', '/api/join/NOPE99', undefined, { headers: { 'X-Lang': 'en' } });
  check(nope.status === 404 && nope.data.error === 'Game not found – please check the code.', 'Englisch mit X-Lang: en');
  check((await req('GET', '/api/join/NOPE99')).data.error === 'Spiel nicht gefunden – Code prüfen.', 'sonst Deutsch');

  section('App & Seiten');
  let m = await req('GET', '/manifest.webmanifest');
  let man = m.data;
  check(m.ct.includes('application/manifest+json') && man.start_url === '/' && man.display === 'standalone', 'Manifest (Start /)');
  check(man.icons.some((i) => i.purpose === 'maskable') && man.icons.some((i) => i.sizes === '512x512'), 'Manifest-Icons inkl. maskable');
  man = (await req('GET', `/manifest.webmanifest?r=${tok.R2}`)).data;
  check(man.start_url === `/r/${tok.R2}` && man.id === '/play', 'Spieler-Manifest startet mit Wiederbeitritts-Link');
  man = (await req('GET', '/manifest.webmanifest?r=<script>')).data;
  check(man.start_url === '/', 'ungültiger Link → Start /');
  man = (await req('GET', '/manifest.webmanifest?app=admin')).data;
  check(man.start_url === '/admin' && man.id === '/admin', 'Admin-Manifest');
  for (const [url, type] of [['/sw.js', 'javascript'], ['/i18n.js', 'javascript'], ['/icons/icon-192.png', 'image/png'],
    ['/icons/apple-touch-icon.png', 'image/png'], ['/datenschutz', 'html'], ['/hilfe', 'html'], ['/print', 'html']]) {
    const r = await req('GET', url);
    check(r.status === 200 && r.ct.includes(type), `${url} ausgeliefert`);
  }

  section('Kartenkacheln');
  const cfg = (await req('GET', '/api/config')).data;
  check(cfg.tileProxy === true && cfg.tileUrl === '/tiles/{z}/{x}/{y}.png', 'Karte läuft über den Zwischenspeicher');
  const z = 15, x = lon2tile(13.3889, z), y = lat2tile(52.517, z);
  const before = tiles.hits;
  const t1 = await req('GET', `/tiles/${z}/${x}/${y}.png`);
  check(t1.status === 200 && t1.ct === 'image/png' && t1.data.length > 20 && tiles.hits === before + 1, 'Kachel in Berlin geholt');
  check(tiles.lastUserAgent?.startsWith('manhunt-web/'), 'eigene Kennung beim Kartenanbieter');
  const t2 = await req('GET', `/tiles/${z}/${x}/${y}.png`);
  check(t2.status === 200 && tiles.hits === before + 1, 'zweiter Abruf aus dem Zwischenspeicher');
  const far = await req('GET', `/tiles/${z}/${lon2tile(0, z)}/${lat2tile(0, z)}.png`);
  check(far.status === 404 && tiles.hits === before + 1, 'Kachel weit weg vom Spiel wird nicht geholt');
  check((await req('GET', '/tiles/25/1/1.png')).status === 404, 'ungültige Zoomstufe = 404');

  await req('DELETE', `/api/admin/rooms/${room.id}`, undefined, A);
}
