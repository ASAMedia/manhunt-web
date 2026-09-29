import {
  $, api, el, fmtTime, createMap, labeledMarker, meetingMarker, drawZone, scaleZone, zoneBounds, errorContext,
} from './common.js';

// Ping-Replay für den Beamer: die Pings einer Runde als Zeitraffer.
// Schritt 0 = Spielstart, Schritt i = nach dem i-ten Ping, letzter Schritt = Spielende.

errorContext.role = 'admin';
const roomId = location.hash.slice(1);

// gut unterscheidbare Farben für die Gejagten (auch auf dem Beamer)
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0fa3b1', '#f032e6', '#9a6324', '#808000', '#000075', '#e6a100', '#469990'];
const KIND = { regular: 'Ping', extra: 'Extra-Ping', admin: 'Sofort-Ping der Spielleitung' };

let D = null;        // Daten vom Server
let map = null;
const layers = {};
let steps = [];      // [{ t, ping, index }]
let step = 0;
let autoFit = true;
let timer = null;
const color = {};

function message(text, link) {
  $('#rMsg').replaceChildren(el('div', { class: 'card stack' },
    el('p', { text }),
    link ? el('a', { class: 'btn primary', href: link.href, text: link.text }) : null));
  $('#rMsg').classList.remove('hidden');
}

async function boot() {
  if (!roomId) return message('Kein Raum angegeben – das Replay aus dem Admin-Bereich öffnen.', { href: '/admin', text: 'Zum Admin-Bereich' });
  try {
    D = await api('GET', `/api/admin/rooms/${encodeURIComponent(roomId)}/replay`);
  } catch (e) {
    if (e.status === 401) return message('Bitte zuerst als Spielleitung oder Aufsicht anmelden.', { href: '/admin', text: 'Anmelden' });
    return message(e.message, { href: '/admin', text: 'Zurück' });
  }
  document.title = `Ping-Replay – ${D.name}`;
  $('#rTitle').textContent = `Ping-Replay · ${D.name}`;
  $('#rSub').textContent = `Runde ${D.roundNo ?? ''} · ${fmtTime(D.startedAt)}${D.endedAt ? `–${fmtTime(D.endedAt)} Uhr` : ' Uhr, läuft noch'} · ${D.pings.length} Pings`;

  // Farben in der Reihenfolge der Gejagten (plus Namen, die nur in Pings vorkommen)
  const names = [...D.runners.map((r) => r.name)];
  for (const p of D.pings) for (const x of p.positions) if (!names.includes(x.name)) names.push(x.name);
  names.forEach((n, i) => { color[n] = COLORS[i % COLORS.length]; });

  steps = [{ t: D.startedAt, index: 0 }, ...D.pings.map((ping, i) => ({ t: ping.at, ping, index: i + 1 }))];
  if (D.endedAt) steps.push({ t: D.endedAt, end: true, index: D.pings.length });

  map = await createMap('replayMap');
  for (const k of ['zone', 'meeting', 'trails', 'points']) layers[k] = L.layerGroup().addTo(map);
  if (D.meetingPoint) meetingMarker(D.meetingPoint).addTo(layers.meeting);
  // Solange niemand die Karte bewegt, bleibt alles im Bild – auch bei Vollbild oder anderer Fenstergröße
  const box = map.getContainer();
  box.addEventListener('pointerdown', () => { autoFit = false; });
  box.addEventListener('wheel', () => { autoFit = false; }, { passive: true });
  new ResizeObserver(() => {
    map.invalidateSize({ pan: false });
    if (autoFit) fitAll();
  }).observe(box);
  fitAll();

  $('#rSlider').max = String(steps.length - 1);
  show(0);
}

function fitAll() {
  const pts = D.pings.flatMap((p) => p.positions.filter((x) => x.lat != null).map((x) => [x.lat, x.lng]));
  if (D.meetingPoint) pts.push([D.meetingPoint.lat, D.meetingPoint.lng]);
  let b = pts.length ? L.latLngBounds(pts) : null;
  if (D.zone) b = b ? b.extend(zoneBounds(D.zone)) : zoneBounds(D.zone);
  if (b) map.fitBounds(b.pad(0.08), { maxZoom: 17, animate: false });
}

// Spielfeld zum Zeitpunkt t (schrumpft ggf. vom Ende des Vorsprungs bis zum Spielende)
function zoneAt(t) {
  if (!D.zone) return null;
  if (!D.shrinkFinalRadius) return D.zone;
  const f = Math.min(1, Math.max(0, (t - D.huntStartsAt) / (D.endsAt - D.huntStartsAt)));
  return scaleZone(D.zone, Math.round(D.zone.radius - (D.zone.radius - D.shrinkFinalRadius) * f));
}

function show(i) {
  step = Math.max(0, Math.min(steps.length - 1, i));
  const s = steps[step];
  $('#rSlider').value = String(step);
  $('#rTime').textContent = `${fmtTime(s.t)} Uhr`;
  $('#rStep').textContent = s.end ? 'Spielende' : s.ping ? `${KIND[s.ping.kind] || 'Ping'} ${s.index} von ${D.pings.length}` : 'Spielstart';

  drawZone(layers.zone, zoneAt(s.t), D.shrinkFinalRadius, { opacity: 0.05 });

  // bisherige Pings je Gejagtem
  const seen = D.pings.slice(0, s.index);
  const current = s.ping || null;
  const byName = {};
  for (const p of seen) for (const x of p.positions) if (x.lat != null) (byName[x.name] ??= []).push({ ...x, at: p.at });

  layers.trails.clearLayers();
  layers.points.clearLayers();
  const status = {};
  for (const name of Object.keys(color)) {
    const runner = D.runners.find((r) => r.name === name);
    const caught = runner?.caughtAt && runner.caughtAt <= s.t;
    const pts = byName[name] || [];
    const inCurrent = current?.positions.find((x) => x.name === name);
    status[name] = caught ? `gefangen ${fmtTime(runner.caughtAt)}`
      : inCurrent?.blocked ? '🛡 blockiert' : inCurrent?.missing ? 'kein Signal' : pts.length ? 'frei' : '–';
    if (!pts.length) continue;
    const c = color[name];
    if (pts.length > 1) {
      L.polyline(pts.map((p) => [p.lat, p.lng]), { color: c, weight: 3, opacity: caught ? 0.3 : 0.7, dashArray: '6 8', interactive: false }).addTo(layers.trails);
    }
    pts.slice(0, -1).forEach((p) => L.circleMarker([p.lat, p.lng], {
      radius: 5, color: c, weight: 1, fillColor: c, fillOpacity: caught ? 0.25 : 0.55, interactive: false,
    }).addTo(layers.trails));
    const last = pts.at(-1);
    const fresh = inCurrent && inCurrent.lat != null;
    const label = caught ? `✖ ${name} · gefangen ${fmtTime(runner.caughtAt)}`
      : inCurrent?.blocked ? `🛡 ${name} · blockiert` : `${name} · ${fmtTime(last.at)}`;
    labeledMarker([last.lat, last.lng], {
      color: c, radius: fresh ? 12 : 9, fill: caught ? 0.3 : 0.95, label, dashed: !!inCurrent?.blocked, className: caught ? 'old' : '',
    }).addTo(layers.points);
  }

  // Seitenleiste: wer ist wie unterwegs, dazu Ping-Art und Spielende
  $('#rLegend').replaceChildren(...Object.keys(color).map((name) => el('li', { class: status[name].startsWith('gefangen') ? 'is-caught' : '' },
    el('span', { class: 'swatch', style: `background:${color[name]}` }),
    el('span', { class: 'name', text: name }),
    el('span', { class: 'state', text: status[name] }))));
  const banner = s.end ? (D.result?.reason || 'Spielende')
    : current?.kind === 'extra' ? `Extra-Ping von ${current.by || 'einem Jäger-Team'}`
      : current?.kind === 'admin' ? 'Sofort-Ping der Spielleitung' : '';
  $('#rBanner').textContent = banner;
  $('#rBanner').classList.toggle('hidden', !banner);
  $('#rBanner').classList.toggle('end', !!s.end);
}

function play() {
  if (timer) return pause();
  if (step >= steps.length - 1) show(0);
  $('#rPlay').textContent = '⏸ Pause';
  const tick = () => {
    if (step >= steps.length - 1) return pause();
    show(step + 1);
    timer = setTimeout(tick, Number($('#rSpeed').value));
  };
  timer = setTimeout(tick, 400);
}

function pause() {
  clearTimeout(timer);
  timer = null;
  $('#rPlay').textContent = '▶ Abspielen';
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

$('#rPlay').addEventListener('click', play);
$('#rFirst').addEventListener('click', () => { pause(); show(0); });
$('#rPrev').addEventListener('click', () => { pause(); show(step - 1); });
$('#rNext').addEventListener('click', () => { pause(); show(step + 1); });
$('#rSlider').addEventListener('input', (e) => { pause(); show(Number(e.target.value)); });
$('#rFit').addEventListener('click', () => { autoFit = true; fitAll(); });
$('#rFull').addEventListener('click', fullscreen);
document.addEventListener('fullscreenchange', () => setTimeout(() => map?.invalidateSize(), 100));
document.addEventListener('keydown', (e) => {
  if (!D || e.target.closest?.('input, select, button')) return;
  if (e.key === ' ') { e.preventDefault(); play(); }
  else if (e.key === 'ArrowRight') { pause(); show(step + 1); }
  else if (e.key === 'ArrowLeft') { pause(); show(step - 1); }
  else if (e.key === 'Home') { pause(); show(0); }
  else if (e.key === 'End') { pause(); show(steps.length - 1); }
  else if (e.key === 'f' || e.key === 'F') fullscreen();
});

boot();
