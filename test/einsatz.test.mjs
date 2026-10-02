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
  const tok = (await req('POST', `/api/join/${room.code}`, { name: 'Gina' }, xff)).data.token;
  await req('POST', `/api/join/${room.code}`, { name: 'Jan' }, xff);
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

  section('Spielzeit verlängern und verkürzen');
  const mk = async (name, settings) => {
    const r = (await req('POST', '/api/admin/rooms', { name }, A)).data;
    await req('PATCH', `/api/admin/rooms/${r.id}`, { settings: { headStartMin: 0, durationMin: 30, pingIntervalMin: 5, ...settings } }, A);
    const t = {};
    for (const n of ['Runa', 'Jens']) t[n] = (await req('POST', `/api/join/${r.code}`, { name: n }, xff)).data.token;
    const ps = (await req('GET', `/api/admin/rooms/${r.id}`, undefined, A)).data.players;
    for (const p of ps) await req('PATCH', `/api/admin/rooms/${r.id}/players/${p.id}`, { role: p.name === 'Runa' ? 'runner' : 'hunter' }, A);
    return { r, t };
  };
  const { r: tr, t: tt } = await mk('Zeit', { zone: { lat: 52.52, lng: 13.40, radius: 1000 }, shrinkEnabled: true, shrinkFinalRadius: 200 });
  check((await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: 10 }, A)).status === 409, 'Lobby: Spielzeit ändern geht nicht');
  await req('POST', `/api/admin/rooms/${tr.id}/start`, undefined, A);
  const t0 = (await req('GET', `/api/admin/rooms/${tr.id}`, undefined, A)).data;
  const plus = await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: 10 }, A);
  check(plus.status === 200 && plus.data.endsAt - t0.endsAt === 10 * 60e3 && plus.data.extraMin === 10, '+10 min: Ende 10 Minuten später', plus.data);
  check(Math.abs(plus.data.zone.radius - t0.zone.radius) <= 5, 'schrumpfendes Spielfeld springt dabei nicht', { vorher: t0.zone.radius, nachher: plus.data.zone.radius });
  check(plus.data.events.some((e) => e.text.includes('um 10 Minuten verlängert')), 'Verlauf: Verlängerung vermerkt');
  const pv = (await req('GET', '/api/play/state', undefined, { token: tt.Runa })).data;
  check(pv.room.endsAt === plus.data.endsAt && pv.room.durationMin === 40, 'Handy kennt neues Ende und Dauer (für Regeln)', pv.room);
  check((await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: 10 }, SUP)).status === 403, 'Aufsicht darf die Spielzeit nicht ändern');
  check((await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: 0 }, A)).status === 400, '0 Minuten → abgelehnt');
  const minus = await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: -10 }, A);
  check(minus.status === 200 && minus.data.endsAt === t0.endsAt && minus.data.extraMin === 0, '−10 min: wieder das ursprüngliche Ende');
  const tooShort = await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: -30 }, A);
  check(tooShort.status === 409 && /weniger als eine Minute/.test(tooShort.data.error), 'zu weit kürzen → verständliche Ablehnung', tooShort.data);
  await req('POST', `/api/admin/rooms/${tr.id}/time`, { minutes: 10 }, A);
  await req('POST', `/api/admin/rooms/${tr.id}/end`, undefined, A);
  const ended2 = (await req('GET', `/api/admin/rooms/${tr.id}`, undefined, A)).data;
  check(ended2.rounds.at(-1).settings.durationMin === 40 && ended2.rounds.at(-1).settings.extraMin === 10, 'Auswertung: tatsächliche Dauer mit Verlängerung');
  check(ended2.settings.durationMin === 30, 'Einstellung bleibt 30 min (Verlängerung gilt nur für diese Runde)');
  await req('POST', `/api/admin/rooms/${tr.id}/lobby`, undefined, A);
  await req('POST', `/api/admin/rooms/${tr.id}/start`, undefined, A);
  const r2 = (await req('GET', `/api/admin/rooms/${tr.id}`, undefined, A)).data;
  check(r2.endsAt - r2.startedAt === 30 * 60e3 && r2.extraMin === 0, 'neue Runde: wieder die eingestellte Dauer');

  section('Funkloch: nachgesendete Meldungen');
  const { r: fr, t: ft } = await mk('Funkloch', { transportReports: true });
  await req('POST', `/api/admin/rooms/${fr.id}/start`, undefined, A);
  const started2 = (await req('GET', `/api/admin/rooms/${fr.id}`, undefined, A)).data.startedAt;
  await new Promise((r) => setTimeout(r, 1500));
  await req('POST', '/api/play/transport', { mode: 'U', at: started2 + 1200 }, { token: ft.Runa });
  await req('POST', '/api/play/transport', { mode: 'Bus', at: started2 + 400 }, { token: ft.Runa });
  const me = (await req('GET', '/api/play/state', undefined, { token: ft.Runa })).data.me;
  check(me.transport.mode === 'U' && me.transport.at === started2 + 1200, 'Verkehrsmittel mit Zeitpunkt; ältere Meldung überholt keine neuere', me.transport);
  const sos = await req('POST', '/api/play/sos', { at: Date.now() - 10 * 60e3 }, { token: ft.Jens });
  const al2 = (await req('GET', '/api/admin/alerts', undefined, A)).data.emergencies.find((e) => e.roomId === fr.id);
  check(sos.status === 200 && al2 && Math.abs(al2.at - (Date.now() - 10 * 60e3)) < 5000, 'Notruf aus dem Funkloch: Zeitpunkt des Tipps', al2);
  const ev = (await req('GET', `/api/admin/rooms/${fr.id}`, undefined, A)).data.events;
  check(ev.some((e) => e.text.includes('im Funkloch ausgelöst')), 'Verlauf: Notruf als nachgesendet markiert');
  const caught = await req('POST', '/api/play/caught', { at: Date.now() - 20 * 60e3 }, { token: ft.Runa });
  check(caught.status === 200 && caught.data.me.caughtAt === started2, 'Gefangen: Zeitpunkt nie vor Spielbeginn', { caughtAt: caught.data.me.caughtAt, started2 });
  check((await req('POST', '/api/play/caught', { at: Date.now() }, { token: ft.Runa })).status === 409, 'doppelt nachgesendet → abgelehnt (Handy verwirft es)');
  const { r: fr2, t: ft2 } = await mk('Funkloch 2', {});
  await req('POST', `/api/admin/rooms/${fr2.id}/start`, undefined, A);
  const future = await req('POST', '/api/play/caught', { at: Date.now() + 3600e3 }, { token: ft2.Runa });
  check(future.status === 200 && future.data.me.caughtAt <= Date.now(), 'Zeitpunkt in der Zukunft → Ankunftszeit', future.data);

  section('Übersetzungen der neuen Texte');
  const src = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  const [dePart, enPart] = src.split(/\n {2}en: \{/);
  const keysOf = (part) => new Set([...part.matchAll(/^ {4}'([\w.]+)':/gm)].map((m) => m[1]));
  const de = keysOf(dePart), en = keysOf(enPart);
  const play = fs.readFileSync(path.join(ROOT, 'public/play.js'), 'utf8');
  const used = new Set([...play.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]));
  for (const g of ['lobby', 'runner', 'hunter']) for (const k of ['title', '1', '2', '3']) used.add(`guide.${g}.${k}`);
  for (const k of ['final.runner', 'final.hunter', 'final.other', 'outbox.caught', 'outbox.block', 'outbox.sos']) used.add(k);
  const missing = [...used].filter((k) => !de.has(k) || !en.has(k));
  check(missing.length === 0, `alle ${used.size} Texte der Spielerseite gibt es auf Deutsch und Englisch`, missing);
  const onlyDe = [...de].filter((k) => !en.has(k));
  check(onlyDe.length === 0, 'keine Texte nur auf Deutsch', onlyDe);
}
