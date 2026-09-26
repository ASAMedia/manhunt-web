// Gemeinsame Hilfen für alle Seiten

export async function api(method, url, body, headers = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'manhunt', ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

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

export const fmtSeconds = (sec) => (sec % 60 === 0
  ? `${sec / 60} ${sec === 60 ? 'Minute' : 'Minuten'}`
  : `${sec} Sekunden`);

// Standardregeln aus den Einstellungen – gilt, solange die Spielleitung keinen eigenen Text hinterlegt
export function defaultRules(s) {
  const lines = [
    'So läuft das Spiel',
    s.headStartMin > 0
      ? `• Die Gejagten bekommen ${s.headStartMin} Minuten Vorsprung. Danach sehen die Jäger alle ${s.pingIntervalMin} Minuten, wo die Gejagten gerade sind (Ping). Die Jäger sind für Gejagte nie sichtbar.`
      : `• Die Jäger sehen ab Spielbeginn alle ${s.pingIntervalMin} Minuten, wo die Gejagten gerade sind (Ping). Die Jäger sind für Gejagte nie sichtbar.`,
  ];
  if (s.pingWarningSec) lines.push(`• ${fmtSeconds(s.pingWarningSec)} vor jedem Ping kommt eine Vorwarnung.`);
  lines.push('• Gefangen ist, wer von einem Jäger berührt wird. Dann auf „Ich wurde gefangen“ tippen – ab jetzt jagst du mit.');
  lines.push(`• Die Jäger gewinnen, wenn alle gefangen sind. Sind nach ${s.durationMin} Minuten noch Gejagte frei, gewinnen die Gejagten.`);
  if (s.zone) lines.push(`• Bleibt im Spielfeld (gestrichelter Kreis auf der Karte).${s.shrinkEnabled ? ' Es wird im Laufe des Spiels kleiner.' : ''}`);
  if (s.transportReports) lines.push('• Gejagte melden beim Einsteigen, womit sie fahren (U-Bahn, S-Bahn, Bus, Tram), und beim Aussteigen „zu Fuß“. Die Jäger sehen nur das Verkehrsmittel, nicht die Linie.');
  lines.push('', 'Sicherheit');
  lines.push('• Immer als Gruppe zusammenbleiben. Nicht rennen auf Straßen, Bahnsteigen und Treppen. Keine Gleise betreten, keine Geschäfte oder Privatgelände.');
  lines.push('• Die Seite offen und das Display an lassen, Powerbank mitnehmen.');
  lines.push(`• Notfall: SOS-Knopf oben rechts 1,5 Sekunden gedrückt halten${s.emergencyPhone ? ` oder die Spielleitung anrufen: ${s.emergencyPhone}` : ''}. Bei Lebensgefahr: 112.`);
  if (s.meetingPoint) lines.push(`• Treffpunkt: ${s.meetingPoint.label}`);
  return lines.join('\n');
}

export const rulesText = (s) => s.rules?.trim() || defaultRules(s);
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
  L.tileLayer(cfg.tileUrl, { attribution: cfg.tileAttribution, maxZoom: 19 }).addTo(map);
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

export const meetingMarker = (mp) => labeledMarker([mp.lat, mp.lng], {
  color: cssVar('--ok'), radius: 10, label: `🏁 ${mp.label}`, className: 'meeting',
});

// Spielfeld zeichnen: aktueller Kreis, beim Schrumpfen zusätzlich der End-Kreis (fein gestrichelt)
export function drawZone(layer, zone, finalRadius, { dashed = '8 6', opacity = 0.04 } = {}) {
  layer.clearLayers();
  if (!zone) return;
  const color = cssVar('--primary');
  L.circle([zone.lat, zone.lng], { radius: zone.radius, color, weight: 2, dashArray: dashed, fillOpacity: opacity, interactive: false }).addTo(layer);
  if (finalRadius) {
    L.circle([zone.lat, zone.lng], { radius: finalRadius, color, weight: 1.5, dashArray: '2 5', fill: false, interactive: false }).addTo(layer);
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
    label.textContent = text;
  };
  const begin = (e) => {
    if (timer || (e.button ?? 0) > 0) return;
    e.preventDefault();
    holding++;
    start = Date.now();
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
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* kein Web Audio */ }
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true });

export const audioReady = () => audioCtx?.state === 'running';

// [Frequenz Hz, Dauer ms, Pause ms]
export const SOUNDS = {
  ping: [[880, 140, 70], [1320, 220]],
  start: [[660, 120, 60], [880, 120, 60], [1320, 260]],
  caught: [[392, 220, 60], [262, 420]],
  message: [[988, 110, 70], [988, 110, 70], [988, 240]],
  alarm: [[1400, 240, 60], [900, 240, 60], [1400, 240, 60], [900, 240]],
  warn: [[520, 200, 120], [520, 200]],
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
