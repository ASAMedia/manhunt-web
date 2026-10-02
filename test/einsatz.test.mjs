// Einsatz-Verbesserungen: Display-Sperre der Spielleitung (laufende Spiele), Endspurt-Zeiten, Übersetzungen
import fs from 'node:fs';
import path from 'node:path';
import { client, ROOT } from './lib.mjs';

export default async function einsatz({ base, adminPass, supPass, check, section }) {
  const req = client(base);
  const A = { admin: true };
  const SUP = { as: 'sup' };
  const xff = { headers: { 'X-Forwarded-For': '203.0.113.60' } };
  await req('POST', '/api/admin/login', { password: adminPass }, xff);
  await req('POST', '/api/admin/login', { password: supPass }, { ...SUP, ...xff });

  section('Alarm-Absicherung: laufende Spiele');
  const running = async (who = A) => (await req('GET', '/api/admin/alerts', undefined, who)).data.running;
  const before = await running();
  check(Number.isInteger(before), 'Alarmliste meldet die Zahl laufender Spiele', before);
  const room = (await req('POST', '/api/admin/rooms', { name: 'Einsatz' }, A)).data;
  await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { headStartMin: 0, durationMin: 30, pingIntervalMin: 5 } }, A);
  const tok = (await req('POST', `/api/join/${room.code}`, { name: 'Gina' })).data.token;
  await req('POST', `/api/join/${room.code}`, { name: 'Jan' });
  await req('POST', `/api/admin/rooms/${room.id}/draw`, { runners: 1 }, A);
  const players = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data.players;
  // Gina soll die Gejagte sein
  if (players.find((p) => p.name === 'Gina').role !== 'runner') {
    for (const p of players) await req('PATCH', `/api/admin/rooms/${room.id}/players/${p.id}`, { role: p.name === 'Gina' ? 'runner' : 'hunter' }, A);
  }
  const started = await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, A);
  check(started.status === 200, 'Spiel startet', started.data);
  check(await running() === before + 1, 'Spiel gestartet → ein laufendes Spiel mehr');
  check(await running(SUP) === before + 1, 'Aufsicht sieht die Zahl ebenfalls (Display bleibt auch bei ihr an)');

  section('Endspurt: Zeiten fürs Handy');
  const st = (await req('GET', '/api/play/state', undefined, { token: tok })).data;
  check(st.room.startedAt > 0 && st.room.endsAt - st.room.startedAt === 30 * 60e3, 'Handy kennt Start und Ende (für die 5-Minuten-Warnung)', st.room);
  await req('POST', `/api/admin/rooms/${room.id}/end`, undefined, A);
  check(await running() === before, 'Spiel beendet → Zahl wieder wie vorher');
  const ended = (await req('GET', '/api/play/state', undefined, { token: tok })).data;
  check(ended.room.status === 'ended' && ended.huntersAtPing === undefined, 'Nach Spielende: keine Jäger-Standorte mehr auf dem Handy');

  section('Übersetzungen der neuen Texte');
  const src = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  const [dePart, enPart] = src.split(/\n {2}en: \{/);
  const keysOf = (part) => new Set([...part.matchAll(/^ {4}'([\w.]+)':/gm)].map((m) => m[1]));
  const de = keysOf(dePart), en = keysOf(enPart);
  const play = fs.readFileSync(path.join(ROOT, 'public/play.js'), 'utf8');
  const used = new Set([...play.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]));
  for (const g of ['lobby', 'runner', 'hunter']) for (const k of ['title', '1', '2', '3']) used.add(`guide.${g}.${k}`);
  for (const k of ['final.runner', 'final.hunter', 'final.other']) used.add(k);
  const missing = [...used].filter((k) => !de.has(k) || !en.has(k));
  check(missing.length === 0, `alle ${used.size} Texte der Spielerseite gibt es auf Deutsch und Englisch`, missing);
  const onlyDe = [...de].filter((k) => !en.has(k));
  check(onlyDe.length === 0, 'keine Texte nur auf Deutsch', onlyDe);
}
