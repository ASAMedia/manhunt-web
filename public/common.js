// Gemeinsame Hilfen für alle Seiten

// `timeout` (ms): Bei hängender Verbindung (Tunnel, schwaches Netz) abbrechen – gilt dann wie „kein Netz“
export async function api(method, url, body, headers = {}, { timeout = 0 } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'manhunt', ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const ctrl = timeout ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl?.signal });
    const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    if (!res.ok) {
      const err = new Error(data?.error || `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Vorübergehende Fehler: kein Netz, Zeitüberschreitung, Server startet gerade neu (502/503/504) oder ist überlastet
export const isTemporary = (e) => !e.status || e.status >= 500 || e.status === 408 || e.status === 429;

// ---------------------------------------------------------------------------
// Fehlerberichte: Skriptfehler auf Handys gehen an den Server (Log + Liste im Admin-Bereich).
// Ohne Namen, Standort oder Spieler-Token; höchstens 5 pro Seitenaufruf.
// ---------------------------------------------------------------------------

export const errorContext = { role: null }; // die Seiten tragen hier ihre Rolle ein
let reportsLeft = 5;
const stripOrigin = (s) => String(s || '').split(location.origin).join('');
// harmlose Browser-Meldungen und Funklöcher sind keine Programmfehler
const IGNORED = /ResizeObserver loop|^Script error\.?$|Failed to fetch|NetworkError|Load failed|network connection was lost|AbortError/i;

function reportError(message, source, line, col, stack) {
  if (!message || IGNORED.test(message) || reportsLeft <= 0) return;
  reportsLeft--;
  const body = {
    message: String(message).slice(0, 300),
    source: stripOrigin(source).slice(0, 120),
    line, col,
    stack: stripOrigin(stack).slice(0, 1000),
    page: location.pathname,
    role: errorContext.role,
    lang: document.documentElement.lang,
  };
  fetch('/api/client-error', {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
}

window.addEventListener('error', (e) => {
  if (e.error || e.message) reportError(e.message, e.filename, e.lineno, e.colno, e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r?.status) return; // Antworten des Servers (z. B. „Das Spiel läuft nicht.“) sind kein Programmfehler
  reportError(r?.message || String(r), '', null, null, r?.stack);
});

// DOM-Baukasten: Texte immer über textContent, nie als HTML
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel) => document.querySelector(sel);

// localStorage kann im privaten Modus fehlen – dann nur im Speicher halten
const memoryStore = {};
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return memoryStore[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { memoryStore[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch { delete memoryStore[k]; } },
};

const pad = (n) => String(n).padStart(2, '0');

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  return `vor ${Math.floor(m / 60)} h ${m % 60} min`;
}

export const fmtTime = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

export const ROLE_LABEL = { hunter: 'Jäger', runner: 'Gejagt' };
export const TRANSPORT = { U: 'U-Bahn', S: 'S-Bahn', Bus: 'Bus', Tram: 'Tram', Fuss: 'zu Fuß' };
export const TRANSPORT_ICON = { U: '🚇', S: '🚆', Bus: '🚌', Tram: '🚊', Fuss: '🚶' };

export function fmtSeconds(sec, lang = 'de') {
  if (lang === 'en') return sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? '' : 's'}` : `${sec} seconds`;
  return sec % 60 === 0 ? `${sec / 60} ${sec === 60 ? 'Minute' : 'Minuten'}` : `${sec} Sekunden`;
}

// Telefonnummern nie mitten in der Nummer umbrechen
export const noBreak = (s) => String(s).replace(/ /g, ' ');

// Standardregeln aus den Einstellungen – gilt, solange die Spielleitung keinen eigenen Text hinterlegt
export function defaultRules(s, lang = 'de') {
  if (lang === 'en') return defaultRulesEn(s);
  const lines = [
    'So läuft das Spiel',
    s.headStartMin > 0
      ? `• Die Gejagten bekommen ${s.headStartMin} Minuten Vorsprung. Danach sehen die Jäger alle ${s.pingIntervalMin} Minuten, wo die Gejagten gerade sind (Ping) – und die Gejagten, wo die Jäger in diesem Moment sind. Dazwischen sieht niemand die andere Seite.`
      : `• Ab Spielbeginn sehen die Jäger alle ${s.pingIntervalMin} Minuten, wo die Gejagten gerade sind (Ping) – und die Gejagten, wo die Jäger in diesem Moment sind. Dazwischen sieht niemand die andere Seite.`,
  ];
  if (s.pingWarningSec) lines.push(`• ${fmtSeconds(s.pingWarningSec)} vor jedem Ping kommt eine Vorwarnung.`);
  lines.push('• Gefangen ist, wer von einem Jäger berührt wird. Dann auf „Ich wurde gefangen“ tippen – ab jetzt jagst du mit.');
  lines.push(`• Die Jäger gewinnen, wenn alle gefangen sind. Sind nach ${s.durationMin} Minuten noch Gejagte frei, gewinnen die Gejagten.`);
  if (s.zone) lines.push(`• Bleibt im Spielfeld (gestrichelte Linie auf der Karte).${s.shrinkEnabled ? ' Es wird im Laufe des Spiels kleiner.' : ''}`);
  if (s.transportReports) lines.push('• Gejagte melden beim Einsteigen, womit sie fahren (U-Bahn, S-Bahn, Bus, Tram), und beim Aussteigen „zu Fuß“. Die Jäger sehen nur das Verkehrsmittel, nicht die Linie.');
  if (s.blocksPerRunner) lines.push(`• Jeder Gejagte darf ${s.blocksPerRunner === 1 ? 'einmal' : `${s.blocksPerRunner}-mal`} den nächsten Ping blockieren – dann sehen die Jäger ihn bei diesem Ping nicht.`);
  lines.push('', 'Sicherheit');
  lines.push('• Immer als Gruppe zusammenbleiben. Nicht rennen auf Straßen, Bahnsteigen und Treppen. Keine Gleise betreten, keine Geschäfte oder Privatgelände.');
  lines.push('• Die Seite offen und das Display an lassen, Powerbank mitnehmen. Seite aus Versehen geschlossen? Den QR-Code noch einmal scannen – du bist sofort wieder in deinem Spiel.');
  lines.push(`• Notfall: SOS-Knopf oben rechts 1,5 Sekunden gedrückt halten${s.emergencyPhone ? ` oder die Spielleitung anrufen: ${noBreak(s.emergencyPhone)}` : ''}. Bei Lebensgefahr: 112.`);
  if (s.meetingPoint) lines.push(`• Treffpunkt: ${s.meetingPoint.label}`);
  return lines.join('\n');
}

function defaultRulesEn(s) {
  const lines = [
    'How the game works',
    s.headStartMin > 0
      ? `• Runners get a ${s.headStartMin}-minute head start. After that, every ${s.pingIntervalMin} minutes (ping) the hunters see where the runners are – and the runners see where the hunters are at that moment. In between, nobody sees the other side.`
      : `• From the start, every ${s.pingIntervalMin} minutes (ping) the hunters see where the runners are – and the runners see where the hunters are at that moment. In between, nobody sees the other side.`,
  ];
  if (s.pingWarningSec) lines.push(`• You get a warning ${fmtSeconds(s.pingWarningSec, 'en')} before every ping.`);
  lines.push('• You are caught when a hunter touches you. Then tap “I was caught” – from then on you hunt too.');
  lines.push(`• The hunters win if everyone is caught. If runners are still free after ${s.durationMin} minutes, the runners win.`);
  if (s.zone) lines.push(`• Stay inside the play area (dashed line on the map).${s.shrinkEnabled ? ' It gets smaller during the game.' : ''}`);
  if (s.transportReports) lines.push('• Runners report how they travel when boarding (U-Bahn, S-Bahn, bus, tram) and “on foot” when getting off. Hunters only see the type, not the line.');
  if (s.blocksPerRunner) lines.push(`• Each runner may block the next ping ${s.blocksPerRunner === 1 ? 'once' : `${s.blocksPerRunner} times`} – the hunters then don’t see them at that ping.`);
  lines.push('', 'Safety');
  lines.push('• Always stay together as a group. Don’t run on streets, platforms or stairs. Never step onto tracks, don’t enter shops or private property.');
  lines.push('• Keep the page open and the screen on, bring a power bank. Closed the page by accident? Scan the QR code again – you are straight back in your game.');
  lines.push(`• Emergency: press and hold the SOS button (top right) for 1.5 seconds${s.emergencyPhone ? ` or call the game master: ${noBreak(s.emergencyPhone)}` : ''}. If life is in danger: 112.`);
  if (s.meetingPoint) lines.push(`• Meeting point: ${s.meetingPoint.label}`);
  return lines.join('\n');
}

// Eigener Regeltext der Spielleitung hat Vorrang (bleibt in der Sprache, in der er geschrieben wurde)
export const rulesText = (s, lang = 'de') => s.rules?.trim() || defaultRules(s, lang);

// Service Worker: App-Installation, App-Hülle offline, Kartenkacheln für Funklöcher
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* ohne Offline-Funktionen weiter */ });
}
export const STATUS_LABEL = { lobby: 'Lobby', running: 'Läuft', ended: 'Beendet' };

export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

let configPromise;
export const getConfig = () => (configPromise ??= api('GET', '/api/config'));

export async function createMap(id) {
  const cfg = await getConfig();
  const map = L.map(id, { zoomControl: true, attributionControl: true }).setView(cfg.mapCenter, 14);
  // ab Zoom 19 vergrößert Leaflet die Kacheln von Zoom 18 (mehr liefert der Kachel-Zwischenspeicher nicht)
  L.tileLayer(cfg.tileUrl, { attribution: cfg.tileAttribution, maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
  return map;
}

// Punkt mit dauerhaftem Namensschild
export function labeledMarker(latlng, { color, label, radius = 8, fill = 0.9, dashed = false, className = '' }) {
  const m = L.circleMarker(latlng, {
    radius, color, weight: 2, fillColor: color, fillOpacity: fill, dashArray: dashed ? '3 3' : null,
  });
  if (label) m.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -radius], className: `map-label ${className}` });
  return m;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Kartenschilder entzerren: Schilder in der Reihenfolge der Gruppen (wichtigste zuerst) platzieren. Würde ein Schild
// ein anderes (oder einen der `avoid`-Punkte) verdecken, weicht es auf eine andere Seite aus; passt keine, wird es
// ausgeblendet – Antippen des Punkts zeigt es kurz an, danach wird neu sortiert (`again`).
const LABEL_SIDES = ['top', 'right', 'left', 'bottom'];
const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
let peekTimer = null;
export function declutterLabels(groups, avoid = [], again = () => {}) {
  const placed = avoid.filter(Boolean).map((e) => e.getBoundingClientRect());
  for (const group of groups) {
    group.eachLayer((m) => {
      const tip = m.getTooltip?.();
      const node = tip?.options.permanent && tip.getElement();
      if (!node) return;
      node.classList.remove('label-hidden');
      const r = m.getRadius?.() ?? 8;
      const fits = LABEL_SIDES.some((side) => {
        tip.options.direction = side;
        tip.options.offset = side === 'top' ? [0, -r] : side === 'bottom' ? [0, r] : side === 'right' ? [r, 0] : [-r, 0];
        tip.update();
        const box = node.getBoundingClientRect();
        if (placed.some((p) => overlaps(p, box))) return false;
        placed.push(box);
        return true;
      });
      if (fits) return;
      tip.options.direction = 'top';
      tip.options.offset = [0, -r];
      tip.update();
      node.classList.add('label-hidden');
      if (!m.peekBound) {
        m.peekBound = true;
        m.on('click', () => {
          m.getTooltip()?.getElement()?.classList.remove('label-hidden');
          clearTimeout(peekTimer);
          peekTimer = setTimeout(again, 4000);
        });
      }
    });
  }
}

export const meetingMarker = (mp) => labeledMarker([mp.lat, mp.lng], {
  color: cssVar('--ok'), radius: 10, label: `🏁 ${mp.label}`, className: 'meeting',
});

// Spielfeld: Kreis {lat,lng,radius} oder Fläche {lat,lng,radius,points} (lat/lng = Mitte, radius = Umkreis).
// Eine Fläche schrumpft, indem alle Ecken gleichmäßig Richtung Mitte wandern.
export function scaleZone(zone, radius) {
  if (!zone.points) return { ...zone, radius };
  const f = radius / zone.radius;
  return { ...zone, radius, points: zone.points.map(([a, b]) => [zone.lat + (a - zone.lat) * f, zone.lng + (b - zone.lng) * f]) };
}

export const zoneBounds = (zone) => (zone.points ? L.latLngBounds(zone.points) : L.latLng(zone.lat, zone.lng).toBounds(zone.radius * 2));

function zoneShape(zone, opts) {
  return zone.points ? L.polygon(zone.points, opts) : L.circle([zone.lat, zone.lng], { radius: zone.radius, ...opts });
}

// Spielfeld zeichnen: aktuelles Feld, beim Schrumpfen zusätzlich das End-Feld (fein gestrichelt)
export function drawZone(layer, zone, finalRadius, { dashed = '8 6', opacity = 0.04 } = {}) {
  layer.clearLayers();
  if (!zone) return;
  const color = cssVar('--primary');
  zoneShape(zone, { color, weight: 2, dashArray: dashed, fillOpacity: opacity, interactive: false }).addTo(layer);
  if (finalRadius) {
    zoneShape(scaleZone(zone, finalRadius), { color, weight: 1.5, dashArray: '2 5', fill: false, interactive: false }).addTo(layer);
  }
}

// Fußweg-Route in der Karten-App des Handys (Google Maps öffnet auf iOS und Android die App)
export const routeUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;

// ---------------------------------------------------------------------------
// Gedrückt-halten-Knopf: löst erst nach `ms` Halten aus, Loslassen/Wegziehen bricht ab
// ---------------------------------------------------------------------------

let holding = 0;
export const isHolding = () => holding > 0; // während des Haltens nichts neu zeichnen

export function holdButton({ text, holdText = 'Weiter halten …', ms = 2000, cls = '', title, onConfirm }) {
  const label = el('span', { class: 'hold-label', text });
  const btn = el('button', { class: `btn hold ${cls}`, type: 'button', title: title || `${text} – gedrückt halten` },
    el('span', { class: 'hold-fill', 'aria-hidden': 'true' }), label);
  let timer = null;
  let start = 0;

  const draw = () => {
    if (!timer) return;
    btn.style.setProperty('--p', Math.min(1, (Date.now() - start) / ms));
    requestAnimationFrame(draw);
  };
  const reset = () => {
    if (timer) holding--;
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
    btn.style.setProperty('--p', 0);
    btn.style.width = '';
    btn.style.height = '';
    label.textContent = text;
  };
  const begin = (e) => {
    if (timer || (e.button ?? 0) > 0) return;
    e.preventDefault();
    holding++;
    start = Date.now();
    // Größe festhalten: Der kürzere Text „Weiter halten …“ würde den Knopf schmaler machen – der Mauszeiger
    // stünde dann daneben, der Browser meldet „verlassen“ und das Halten bräche sofort ab
    const r = btn.getBoundingClientRect();
    btn.style.width = `${r.width}px`;
    btn.style.height = `${r.height}px`;
    btn.classList.add('holding');
    label.textContent = holdText;
    timer = setTimeout(() => { reset(); onConfirm(); }, ms);
    draw();
  };

  btn.addEventListener('pointerdown', begin);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(ev, reset);
  btn.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) begin(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') reset(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
}

// ---------------------------------------------------------------------------
// Töne (Web Audio). Browser erlauben Ton erst nach einer Berührung der Seite.
// ---------------------------------------------------------------------------

let audioCtx = null;

export function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') return audioCtx.resume().catch(() => {});
  } catch { /* kein Web Audio */ }
  return Promise.resolve();
}
// Bei Touch gibt erst das Loslassen den Ton frei (pointerup/touchend), mit der Maus schon das Drücken
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true });

// iPhone (Safari ab iOS 17): Töne auch bei eingeschaltetem Stummschalter abspielen – nur für Alarme der Spielleitung
export function audioIgnoresSilentSwitch() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* älteres iOS */ }
}

export const audioReady = () => audioCtx?.state === 'running';

// [Frequenz Hz, Dauer ms, Pause ms]
export const SOUNDS = {
  ping: [[880, 140, 70], [1320, 220]],
  start: [[660, 120, 60], [880, 120, 60], [1320, 260]],
  caught: [[392, 220, 60], [262, 420]],
  message: [[988, 110, 70], [988, 110, 70], [988, 240]],
  alarm: [[1400, 240, 60], [900, 240, 60], [1400, 240, 60], [900, 240]],
  warn: [[520, 200, 120], [520, 200]],
  final: [[784, 160, 80], [784, 160, 80], [784, 160, 80], [1175, 420]],
  tick: [[880, 90]],
};

export function playSound(pattern) {
  if (!audioReady()) return false;
  let t = audioCtx.currentTime + 0.02;
  for (const [freq, dur, pause = 0] of pattern) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur / 1000 + 0.02);
    t += (dur + pause) / 1000;
  }
  return true;
}
