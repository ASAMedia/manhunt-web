// Spielfeld als Fläche, Akku-Warnung, Ping-Replay
import { client, sleep } from './lib.mjs';

export default async function flaecheAkkuReplay({ base, adminPass, supPass, check, section }) {
  const req = client(base);
  const A = { admin: true };
  const SUP = { as: 'sup' };
  await req('POST', '/api/admin/login', { password: adminPass });
  await req('POST', '/api/admin/login', { password: supPass }, SUP);

  section('Spielfeld als Fläche');
  const room = (await req('POST', '/api/admin/rooms', { name: 'Fläche' }, A)).data;
  const rect = [[52.52, 13.40], [52.52, 13.42], [52.51, 13.42], [52.51, 13.40]];
  const setZone = (zone, extra = {}) => req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { zone, ...extra } }, A);
  const r = await setZone({ points: rect, lat: 1, lng: 1, radius: 5 });
  const z = r.data.settings.zone;
  check(r.status === 200 && z.points.length === 4, 'Fläche mit 4 Ecken gespeichert', r.data);
  check(Math.abs(z.lat - 52.515) < 1e-9 && Math.abs(z.lng - 13.41) < 1e-9 && z.radius > 800 && z.radius < 950,
    'Mitte und Umkreis rechnet der Server selbst aus (Angaben des Browsers ignoriert)', z);
  check((await setZone({ points: rect.slice(0, 2) })).status === 400, 'weniger als 3 Ecken = 400');
  check((await setZone({ points: [[52.5, 13.4], [52.5, 13.4], [52.5, 13.4]] })).data.error === 'Die Fläche ist zu klein.', 'winzige Fläche abgelehnt');
  check((await setZone({ points: [[52.5, 13.4], [95, 13.4], [52.6, 13.5]] })).status === 400, 'ungültige Koordinate = 400');
  check((await setZone({ points: [[52.5, 13.4], [52.5, 15.4], [53.5, 13.5]] })).status === 400, 'riesige Fläche abgelehnt');
  check((await setZone({ points: rect }, { shrinkEnabled: true, shrinkFinalRadius: 2000 })).data.error?.includes('Fläche'),
    'End-Radius größer als die Fläche wird erklärt');
  await setZone({ points: rect }, { shrinkEnabled: true, shrinkFinalRadius: 400, headStartMin: 0, durationMin: 5, pingIntervalMin: 1 });

  const tok = {};
  for (const n of ['Innen', 'Aussen', 'Jaeger']) tok[n] = (await req('POST', `/api/join/${room.code}`, { name: n })).data.token;
  let adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  const pid = (n) => adm.players.find((p) => p.name === n).id;
  for (const [n, role] of [['Innen', 'runner'], ['Aussen', 'runner'], ['Jaeger', 'hunter']]) {
    await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid(n)}`, { role }, A);
  }
  // „Aussen“ steht im Umkreis der Fläche, aber oberhalb der oberen Kante – also außerhalb
  await req('POST', '/api/play/pos', { lat: 52.515, lng: 13.41, acc: 10 }, { token: tok.Innen });
  await req('POST', '/api/play/pos', { lat: 52.5215, lng: 13.41, acc: 10 }, { token: tok.Aussen });
  await req('POST', '/api/play/pos', { lat: 52.512, lng: 13.405, acc: 10 }, { token: tok.Jaeger });
  await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, A);
  const inner = (await req('GET', '/api/play/state', undefined, { token: tok.Innen })).data;
  const outer = (await req('GET', '/api/play/state', undefined, { token: tok.Aussen })).data;
  check(inner.me.outside === false && outer.me.outside === true, 'Punkt-in-Fläche: innen / außerhalb (obwohl im Umkreis)', [inner.me, outer.me]);
  check(inner.room.zone.points?.length === 4 && inner.room.zoneFinalRadius === 400, 'Handy bekommt Fläche und End-Größe');
  await sleep(1500);
  const later = (await req('GET', '/api/play/state', undefined, { token: tok.Innen })).data.room.zone;
  const spanNow = later.points[0][0] - later.points[2][0];
  check(later.radius < z.radius && spanNow < 0.01 && spanNow > 0.009, 'schrumpfende Fläche: Ecken wandern Richtung Mitte', later);
  const al = (await req('GET', '/api/admin/alerts', undefined, SUP)).data;
  check(al.warnings.some((w) => w.type === 'zone' && w.name === 'Aussen'), 'Warnung „außerhalb“ auch bei Flächen');

  section('Akku-Warnung');
  const battery = async (level, charging = false) => {
    await req('POST', '/api/play/pos', { lat: 52.515, lng: 13.41, acc: 10, battery: level, charging }, { token: tok.Innen });
    return (await req('GET', '/api/admin/alerts', undefined, SUP)).data.warnings.find((w) => w.type === 'battery' && w.name === 'Innen');
  };
  check(!(await battery(0.5)), 'bei 50 % keine Warnung');
  const low = await battery(0.12);
  check(low && low.battery === 0.12 && !low.acked, 'unter 15 %: Warnung mit Akkustand', low);
  check(!!(await battery(0.17)), 'bei 17 % bleibt sie (erst ab 20 % Entwarnung)');
  await req('POST', `/api/admin/rooms/${room.id}/players/${low.playerId}/ack`, { type: 'battery' }, SUP);
  check((await battery(0.16)).acked === true, 'quittiert bleibt quittiert');
  check(!(await battery(0.22)), 'ab 20 % verschwindet die Warnung');
  check(!(await battery(0.1, true)), 'beim Laden keine Warnung');
  const again = await battery(0.1);
  check(again && !again.acked, 'neuer Vorfall = neue Warnung');

  section('Ping-Replay');
  check((await req('GET', `/api/admin/rooms/${room.id}/replay`)).status === 401, 'Replay nur angemeldet');
  await sleep(200);
  await req('POST', '/api/play/block', undefined, { token: tok.Aussen });
  await req('POST', `/api/admin/rooms/${room.id}/ping`, undefined, A);
  const during = await req('GET', `/api/admin/rooms/${room.id}/replay`, undefined, SUP);
  check(during.status === 409 && during.data.error.includes('Spielende'), 'Replay erst nach Spielende', during);
  await req('PATCH', `/api/admin/rooms/${room.id}/players/${pid('Innen')}`, { caught: true }, A);
  await req('POST', `/api/admin/rooms/${room.id}/end`, undefined, A);
  const endedView = (await req('GET', '/api/play/state', undefined, { token: tok.Jaeger })).data;
  check(endedView.pings === undefined && endedView.hunters === undefined && endedView.lastPingAt === null,
    'nach Spielende bekommen Handys keine Pings und keine Standorte mehr', endedView);
  let rep = (await req('GET', `/api/admin/rooms/${room.id}/replay`, undefined, SUP)).data;
  const lastPing = rep.pings.at(-1);
  check(rep.pings.length >= 2 && rep.runners.length === 2, 'Aufsicht bekommt alle Pings und die Gejagten', { n: rep.pings.length, runners: rep.runners });
  check(lastPing.positions.find((p) => p.name === 'Aussen').blocked === true && lastPing.positions.find((p) => p.name === 'Aussen').lat === undefined,
    'blockierter Ping bleibt auch im Replay ohne Standort');
  check(lastPing.positions.find((p) => p.name === 'Innen').lat === 52.515 && rep.zone.points && rep.shrinkFinalRadius === 400, 'Standorte, Fläche und End-Größe im Replay');
  check(!JSON.stringify(rep).includes('Jaeger') || !rep.pings.some((p) => p.positions.some((x) => x.name === 'Jaeger')), 'keine Jäger-Standorte im Replay');

  // Spielfeld nach der Runde ändern – das Replay zeigt trotzdem das Spielfeld der Runde
  await req('PATCH', `/api/admin/rooms/${room.id}`, { settings: { shrinkEnabled: false, zone: { lat: 52.6, lng: 13.5, radius: 500 } } }, A);
  check((await req('GET', `/api/admin/rooms/${room.id}/replay`, undefined, A)).data.zone.points?.length === 4, 'Replay zeigt das Spielfeld der Runde');
  await req('POST', `/api/admin/rooms/${room.id}/lobby`, undefined, A);
  adm = (await req('GET', `/api/admin/rooms/${room.id}`, undefined, A)).data;
  check(adm.status === 'lobby' && adm.pings.length === 0 && adm.replayPings >= 2, 'Nach „Neue Runde“: Karte leer, Replay noch da');
  const lobbyView = (await req('GET', '/api/play/state', undefined, { token: tok.Jaeger })).data;
  check(lobbyView.pings === undefined && lobbyView.lastPingAt === null, 'Handys sehen in der Lobby keine alten Pings');
  rep = (await req('GET', `/api/admin/rooms/${room.id}/replay`, undefined, A)).data;
  check(rep.status === 'lobby' && rep.roundNo === 1 && rep.endedAt && rep.runners.find((x) => x.name === 'Innen')?.caughtAt,
    'Replay in der Lobby: Runde, Spielende und Fangzeiten aus der Auswertung', rep.runners);
  await req('POST', `/api/admin/rooms/${room.id}/start`, undefined, A);
  rep = (await req('GET', `/api/admin/rooms/${room.id}/replay`, undefined, A));
  check(rep.status === 409, 'während der neuen Runde kein Replay (auch nicht der alten)');
  const empty = (await req('POST', '/api/admin/rooms', { name: 'Leer' }, A)).data;
  check((await req('GET', `/api/admin/rooms/${empty.id}/replay`, undefined, A)).status === 404, 'Raum ohne Pings = 404');
  const page = await req('GET', '/replay');
  check(page.status === 200 && page.ct.includes('html'), '/replay ausgeliefert');
  await req('DELETE', `/api/admin/rooms/${room.id}`, undefined, A);
  await req('DELETE', `/api/admin/rooms/${empty.id}`, undefined, A);
}
