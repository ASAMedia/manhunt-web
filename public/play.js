import {
  $, api, el, store, fmtCountdown, fmtTime, distanceM, createMap, labeledMarker, meetingMarker, cssVar, getConfig,
  holdButton, isHolding, unlockAudio, playSound, SOUNDS, routeUrl, isTemporary, declutterLabels, TRANSPORT_ICON, fmtSeconds, rulesText, drawZone, zoneBounds, errorContext,
} from './common.js';
import { t, lang, applyI18n, langButton, langHeader } from './i18n.js';

applyI18n();

// Wiederbeitritts-Link /r/<token> (von der Spielleitung oder als Startadresse der installierten App)
const rejoin = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
if (rejoin) {
  store.set('mh_token', rejoin[1]);
  history.replaceState(null, '', '/play');
}

const token = store.get('mh_token');
const auth = { 'X-Player-Token': token, ...langHeader };

// Die installierte App startet mit dem eigenen Wiederbeitritts-Link – auf dem iPhone hat sie einen
// eigenen Speicher und wüsste sonst nicht, in welchem Spiel man ist.
if (token) document.querySelector('link[rel="manifest"]').href = `/manifest.webmanifest?r=${encodeURIComponent(token)}`;

const platform = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'other';
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let cfg = null;
let S = null;              // letzter Spielstand vom Server
let clockOffset = 0;       // Serverzeit - lokale Zeit
let prev = {};             // für Änderungserkennung (Rolle, Status, …)
let online = true;
let stopped = false;

let tracking = false;
let watchId = null;
let wakeLock = null;
let battery = null;
let lastPos = null;
let geoError = null;       // 'denied' | 'unavailable' | 'timeout'
let lastSentAt = 0;

let map = null;
const layers = {};
let centered = false;
let autoFit = null;        // zuletzt automatisch gewählter Ausschnitt, bis der Nutzer die Karte bewegt
let seenPingAt = Number(store.get('mh_seen_ping')) || 0;
let warnedFor = 0;         // für welchen Ping-Zeitpunkt die Vorwarnung schon kam
let finalWarnedFor = Number(store.get('mh_final_warned')) || 0; // für welches Spielende die Endspurt-Warnung schon kam
const FINAL_MS = 5 * 60e3; // Endspurt: 5 Minuten vor Spielende
const ageLabels = { pings: [], hunters: [] }; // Kartenschilder mit „vor X min“, werden jede Sekunde aktualisiert
let soundOn = store.get('mh_sound') !== 'off';
// Sonnenmodus: maximaler Kontrast, größere Schrift und Kartenbeschriftung (pro Gerät gemerkt)
let sunOn = store.get('mh_sun') === 'on';
const applyTheme = () => { if (sunOn) document.documentElement.dataset.theme = 'sun'; else delete document.documentElement.dataset.theme; };
applyTheme();

// Handy-Check
const check = { sound: store.get('mh_check_sound') || 'untested', asking: false, sentKey: '', overlay: false };
let installPrompt = null;
let mapSave = { state: 'idle', done: 0, total: 0, ok: 0 };

const now = () => Date.now() + clockOffset;
const ACTION_TIMEOUT = 10000; // Meldungen und Notruf: nach 10 s ohne Antwort gilt „kein Netz“
const sound = (name) => { if (soundOn) playSound(SOUNDS[name]); };
const roleLabel = (role) => (role ? t(`role.${role}`) : t('role.none'));
const transportLabel = (mode) => t(`transport.${mode}`);
const GEO_TEXT_DE = { denied: 'Standortzugriff verweigert', unavailable: 'Kein GPS-Signal', timeout: 'GPS antwortet nicht' };

// Funkloch-Puffer (siehe unten bei den Aktionen)
const QUEUEABLE = new Set(['/api/play/caught', '/api/play/transport', '/api/play/block', '/api/play/sos']);
let outbox = (() => {
  try {
    const o = JSON.parse(store.get('mh_outbox') || '[]');
    return Array.isArray(o) ? o.filter((x) => QUEUEABLE.has(x?.path)) : [];
  } catch { return []; }
})();
const saveOutbox = () => (outbox.length ? store.set('mh_outbox', JSON.stringify(outbox)) : store.del('mh_outbox'));
const pending = (path) => outbox.find((o) => o.path === path);
const outboxLabel = (o) => (o.path === '/api/play/transport' ? transportLabel(o.body.mode) : t(`outbox.${o.path.split('/').pop()}`));

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  render();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('#langSlot').append(langButton());

if (!token) {
  showGone(t('gone.none'));
} else {
  init();
}

async function init() {
  $('#startOverlay').classList.remove('hidden');
  $('#startBtn').addEventListener('click', startTracking);
  $('#sosSlot').replaceChildren(holdButton({
    text: 'SOS', holdText: t('sos.hold'), ms: 1500, cls: 'sos', title: t('sos.title'), onConfirm: triggerSos,
  }));
  navigator.getBattery?.().then((b) => { battery = b; }).catch(() => {});
  cfg = await getConfig();
  map = await createMap('map');
  for (const k of ['zone', 'meeting', 'pings', 'hunters', 'own', 'fx']) layers[k] = L.layerGroup().addTo(map);
  map.on('zoomend', scheduleDeclutter);
  // Das Bedienfeld unten ändert seine Höhe – Leaflet muss die neue Kartengröße kennen.
  // Solange niemand die Karte selbst bewegt hat, wird der automatische Ausschnitt neu berechnet.
  const container = map.getContainer();
  container.addEventListener('pointerdown', () => { autoFit = null; });
  container.addEventListener('wheel', () => { autoFit = null; }, { passive: true });
  new ResizeObserver(() => {
    map.invalidateSize({ pan: false });
    autoFit?.();
  }).observe(container);
  poll();
  setInterval(renderTimers, 1000);
  setInterval(() => maybeSend(), 1000);
  setInterval(flushOutbox, 5000);
  window.addEventListener('online', flushOutbox);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || stopped) return;
    if (tracking && !wakeLock) requestWakeLock();
    poll();
    maybeSend(true);
  });
}

// Beim Verlassen oder Entfernen: Zugangsschlüssel, Spielstände und Offline-Speicher (Seiten, Kartenbilder) löschen.
// Einstellungen wie Ton, Sprache und Sonnenmodus bleiben.
function clearGameData() {
  for (const k of ['mh_token', 'mh_seen_ping', 'mh_msg_seen', 'mh_map_saved', 'mh_map_count', 'mh_check_sound', 'mh_final_warned', 'mh_outbox']) store.del(k);
  outbox = [];
  if ('caches' in window) caches.keys().then((keys) => keys.filter((k) => k.startsWith('mh-')).forEach((k) => caches.delete(k))).catch(() => {});
}

function showGone(text) {
  stopped = true;
  clearGameData();
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  wakeLock?.release().catch(() => {});
  $('#startOverlay').classList.add('hidden');
  $('#timers').replaceChildren();
  $('#alerts').replaceChildren(el('div', { class: 'alert info', text }));
  $('#content').replaceChildren(el('a', { class: 'btn primary big', href: '/', text: t('gone.enterCode') }));
  $('#roleBadge').textContent = '–';
  $('#sosSlot').replaceChildren();
}

// ---------------------------------------------------------------------------
// Standort + Display anlassen
// ---------------------------------------------------------------------------

function startTracking() {
  if (!('geolocation' in navigator)) {
    $('#startErr').textContent = t('start.noGeo');
    return;
  }
  if (!window.isSecureContext) {
    $('#startErr').textContent = t('start.noHttps');
    return;
  }
  tracking = true;
  unlockAudio(); // der Tipp auf „Loslegen“ gibt den Ton frei (iOS braucht das)
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 30000,
  });
  requestWakeLock();
  $('#startOverlay').classList.add('hidden');
  render();
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; render(); });
  } catch { wakeLock = null; }
  render();
}

function onPosition(p) {
  const firstFix = !lastPos;
  lastPos = {
    lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now(),
    heading: p.coords.heading, speed: p.coords.speed, // Laufrichtung – liefert das GPS nur in Bewegung
  };
  geoError = null;
  drawOwn();
  // eigene Position mit in den Ping- bzw. Treffpunkt-Ausschnitt nehmen
  if (firstFix && (autoFit === fitToPing || autoFit === fitToMeeting)) autoFit();
  if (firstFix) render();
  maybeSend();
}

function onPositionError(e) {
  geoError = e.code === 1 ? 'denied' : e.code === 2 ? 'unavailable' : 'timeout';
  render();
}

// Akku sparen: nur senden, wenn es etwas Neues gibt – aber kurz vor jedem Ping häufig,
// damit die Jäger eine frische Position bekommen. Der Herzschlag hält die Signal-Warnung der Aufsicht ruhig.
function sendPolicy() {
  const room = S?.room;
  if (!room || room.status === 'lobby') return { heartbeat: 30000, minGap: 10000, minMove: 25 };
  if (room.status === 'running' && S.me.role === 'runner') {
    const left = room.nextPingAt - now();
    if (left > -3000 && left < 30000) return { heartbeat: 3000, minGap: 3000, minMove: 0 };
  }
  return { heartbeat: 20000, minGap: 5000, minMove: 15 };
}

let lastSentPos = null;
function maybeSend(force = false) {
  if (!tracking || stopped) return;
  const since = Date.now() - lastSentAt;
  const moved = !lastPos ? 0 : lastSentPos ? distanceM(lastPos, lastSentPos) : Infinity;
  const p = sendPolicy();
  if (force || since >= p.heartbeat || (since >= p.minGap && moved >= p.minMove)) sendPosition();
}

async function sendPosition() {
  lastSentAt = Date.now();
  // Fehlertexte gehen an die Spielleitung – die liest Deutsch
  const body = lastPos
    ? { lat: lastPos.lat, lng: lastPos.lng, acc: lastPos.acc, age: Date.now() - lastPos.t }
    : { error: GEO_TEXT_DE[geoError] || 'Noch kein Standort' };
  if (battery) { body.battery = battery.level; body.charging = battery.charging; }
  try {
    await api('POST', '/api/play/pos', body, auth);
    lastSentPos = lastPos;
    setOnline(true);
  } catch (e) {
    handleError(e);
  }
}

// ---------------------------------------------------------------------------
// Server-Abfrage
// ---------------------------------------------------------------------------

let pollTimer = null;
let stateVersion = 0; // steigt bei jeder eigenen Aktion – ältere Abfragen werden verworfen
async function poll() {
  clearTimeout(pollTimer);
  if (stopped) return;
  const v = stateVersion;
  try {
    const s = await api('GET', '/api/play/state', undefined, auth, { timeout: 15000 });
    if (v !== stateVersion) throw Object.assign(new Error('veraltet'), { stale: true });
    clockOffset = s.serverTime - Date.now();
    S = s;
    setOnline(true);
    detectChanges();
    render();
    flushOutbox(); // wieder Netz: Gespeichertes aus dem Funkloch nachsenden
  } catch (e) {
    if (!e.stale) handleError(e);
  }
  if (!stopped) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, pollDelay());
  }
}

// Akku sparen: Jäger im Spiel brauchen Pings und Mitjäger schnell, alle anderen seltener
function pollDelay() {
  if (!online) return 5000;
  if (document.visibilityState === 'hidden') return 15000;
  const room = S?.room;
  if (!room) return 3000;
  if (room.status === 'running') return S.me.role === 'hunter' ? 3000 : 5000;
  return room.status === 'ended' ? 10000 : 5000;
}

function handleError(e) {
  if (e.status === 401) {
    store.del('mh_token');
    showGone(t('gone.removed'));
  } else if (!e.status) {
    setOnline(false);
  }
}

function setOnline(v) {
  if (online === v) return;
  online = v;
  render();
}

// ---------------------------------------------------------------------------
// Benachrichtigungen
// ---------------------------------------------------------------------------

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* iOS kann nicht vibrieren */ }
}

function showBanner(id, text, { cls = '', sticky = false, onClose } = {}) {
  document.getElementById(`banner-${id}`)?.remove();
  const close = () => { node.remove(); onClose?.(); layoutBanners(); };
  const node = el('div', { class: `banner ${cls}`, id: `banner-${id}` },
    el('span', { text }),
    el('button', { class: 'btn sm', type: 'button', onclick: close, text: t('common.ok') }));
  $('#banners').append(node);
  if (!sticky) setTimeout(() => { node.remove(); layoutBanners(); }, 10000);
  layoutBanners();
}

// Höchstens zwei Banner gleichzeitig (die neuesten) – ältere klappen zu „+N weitere“ zusammen, damit die Karte frei bleibt
let bannersOpen = false;
function layoutBanners() {
  const box = $('#banners');
  const items = [...box.querySelectorAll('.banner')];
  if (items.length <= 2) bannersOpen = false;
  const hidden = bannersOpen ? 0 : Math.max(0, items.length - 2);
  items.forEach((b, i) => b.classList.toggle('stacked', i < hidden));
  let more = box.querySelector('.banner-more');
  if (items.length <= 2) { more?.remove(); return; }
  if (!more) {
    more = el('button', { class: 'banner-more', type: 'button', onclick: () => { bannersOpen = !bannersOpen; layoutBanners(); } });
    box.prepend(more);
  }
  more.textContent = bannersOpen ? t('banner.fewer') : t('banner.more', { n: hidden });
}

function detectChanges() {
  const { room, me } = S;
  if (prev.status && prev.status !== room.status) {
    if (room.status === 'running') {
      showBanner('status', t('banner.started'));
      // Live miterlebter Start: 3-2-1-Countdown (Ton und Vibration bei „Los!“), sonst nur Ton
      if (now() - room.startedAt < 15000) startCountdown();
      else { vibrate([300, 100, 300]); sound('start'); }
      setTimeout(() => maybeSend(true)); // Spielleitung sieht sofort alle Positionen
    }
    if (room.status === 'lobby') showBanner('status', t('banner.lobby'));
    if (room.status === 'ended') {
      // Spielende: alle zum Treffpunkt – Banner bleibt stehen, Karte zeigt Treffpunkt und eigene Position
      const mp = room.meetingPoint;
      showBanner('status', mp ? t('banner.endedMeeting', { label: mp.label }) : t('banner.ended'), { cls: 'message', sticky: true });
      vibrate([400, 150, 400]);
      sound('start');
      if (mp) setTimeout(fitToMeeting);
      // Ergebnis-Bildschirm, wenn das Ende gerade passiert ist (nicht beim späteren Öffnen der Seite)
      if (now() - (room.endedAt || 0) < 60000) setTimeout(showResultOverlay, 300);
    }
  }
  if (prev.role === 'runner' && me.role === 'hunter' && me.caughtAt) {
    showBanner('role', t('banner.caught'), { cls: 'hunter', sticky: true });
    vibrate([500]);
    sound('caught');
  } else if (prev.status && room.status === 'lobby' && prev.role !== me.role && me.role) {
    vibrate([200, 80, 200]);
    sound('message');
    if (guideSeen().has(me.role)) setTimeout(() => showRoleReveal(me.role, false));
  } else if (prev.role && prev.role !== me.role && me.role) {
    showBanner('role', t('banner.role', { role: roleLabel(me.role) }), { sticky: true });
  }
  const ackAt = me.emergency?.ackAt ?? null;
  if (prev.emergencyAck === null && ackAt) {
    showBanner('sosack', t('banner.sosAck'), { cls: 'message', sticky: true });
    vibrate([300, 100, 300]);
    sound('message');
  }
  const wasArmed = prev.blockArmed;

  // Spielleitung hat die Spielzeit geändert
  if (prev.status === 'running' && room.status === 'running' && prev.endsAt && room.endsAt !== prev.endsAt) {
    const diff = Math.round((room.endsAt - prev.endsAt) / 60000);
    if (diff) {
      showBanner('time', t(diff > 0 ? 'banner.timeLonger' : 'banner.timeShorter', { min: Math.abs(diff), time: fmtTime(room.endsAt) }), { cls: 'message' });
      vibrate([200, 100, 200]);
      sound('message');
    }
  }

  // Neuer Ping
  if (S.lastPingAt && S.lastPingAt > seenPingAt) {
    const fresh = now() - S.lastPingAt < 60000;
    seenPingAt = S.lastPingAt;
    store.set('mh_seen_ping', String(seenPingAt));
    if (fresh && room.status === 'running') {
      const kind = t(`ping.${S.lastPingKind || 'regular'}`);
      if (me.role === 'hunter') {
        showBanner('ping', t('banner.pingHunter', { kind }), { cls: 'hunter' });
        fitToPing();
      } else if (me.role === 'runner') {
        showBanner('ping', t(wasArmed && !me.blockArmed ? 'banner.pingBlocked' : 'banner.pingRunner', { kind }));
        fitToPing();
      }
      const blocked = wasArmed && !me.blockArmed;
      setTimeout(() => pingEffect(blocked), 80); // nach dem Neuzeichnen der Karte
      vibrate([200, 100, 200]);
      sound('ping');
    }
  }
  prev = { status: room.status, role: me.role, emergencyAck: ackAt, blockArmed: me.blockArmed, endsAt: room.endsAt };

  // Nachricht der Spielleitung
  const msg = room.message;
  if (msg && store.get('mh_msg_seen') !== msg.id && !document.getElementById('banner-msg')) {
    showBanner('msg', t('banner.message', { text: msg.text }), {
      cls: 'message', sticky: true, onClose: () => { store.set('mh_msg_seen', msg.id); render(); },
    });
    vibrate([400, 150, 400]);
    sound('message');
  }
  if (!msg) document.getElementById('banner-msg')?.remove();
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

function render() {
  if (!S || stopped) return;
  const { room, me } = S;
  errorContext.role = room.status === 'lobby' ? 'lobby' : me.role;
  $('#roomName').textContent = room.name;
  document.title = `Manhunt – ${room.name}`;
  const badge = $('#roleBadge');
  badge.className = `badge ${me.role || ''}`;
  badge.textContent = roleLabel(me.role);
  $('#meName').textContent = me.caughtAt ? `${me.name} · ${t('list.caughtAt', { time: fmtTime(me.caughtAt) })}` : me.name;

  renderTimers();
  renderAlerts();
  swapIfChanged($('#content'), buildContent());
  if (check.overlay) swapIfChanged($('#checkHost'), el('div', {}, checkCard()));
  drawMap();
  sendCheck();
  maybeShowGuide();
}

function timer(label, value, cls = '') {
  return el('div', { class: `timer ${cls}` }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }));
}

function resultText(room) {
  if (lang === 'de' && room.result?.reason) return room.result.reason;
  const w = room.result?.winner;
  if (w === 'hunters') return t('result.hunters');
  if (w === 'runners') {
    const left = S.runners.filter((r) => !r.caughtAt).map((r) => r.name);
    return t('result.runners', { names: left.join(', '), verb: t(left.length === 1 ? 'result.verbOne' : 'result.verbMany') });
  }
  return room.result ? t('result.stopped') : t('result.ended');
}

function renderTimers() {
  if (!S || stopped) return;
  const { room } = S;
  const now_ = now();
  const items = [];
  if (room.status === 'lobby') {
    items.push(el('div', { class: 'timer waiting' },
      el('span', { class: 'wait-pulse', 'aria-hidden': 'true' }),
      el('div', {}, el('div', { class: 'value', text: t('timer.waiting') }), el('div', { class: 'label', text: t('wait.sub') }))));
  } else if (room.status === 'running') {
    items.push(pingRing(room, now_));
    items.push(timer(t('timer.end'), fmtCountdown(room.endsAt - now_), room.endsAt - now_ <= FINAL_MS ? 'urgent' : ''));
    pingWarning(room, now_);
    finalWarning(room, now_);
  }
  // nach Spielende steht das Ergebnis als Karte im Bedienfeld
  $('#timers').replaceChildren(...items);
  updateAgeLabels();
}

// Nächster Ping als Fortschrittsring: voll direkt nach dem Ping, leer beim nächsten. Kurz vor dem Ping (Vorwarnzeit,
// mindestens 10 s) wird er gelb. Im Vorsprung zählt er den Vorsprung herunter – groß und mit einem Satz zur Rolle.
const SVG_NS = 'http://www.w3.org/2000/svg';
function pingRing(room, now_) {
  const head = now_ < room.huntStartsAt;
  const target = head ? room.huntStartsAt : room.nextPingAt;
  const total = (head ? room.headStartMin : room.pingIntervalMin) * 60e3;
  const left = Math.max(0, target - now_);
  const frac = total ? Math.min(1, left / total) : 0;
  const soon = !head && left <= Math.max(10000, (room.pingWarningSec || 0) * 1000);
  const r = 26, c = 2 * Math.PI * r;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, extra] of [['ring-bg', {}], ['ring-fg', { 'stroke-dasharray': c.toFixed(1), 'stroke-dashoffset': (c * (1 - frac)).toFixed(1) }]]) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ class: cls, cx: 32, cy: 32, r, ...extra })) circle.setAttribute(k, v);
    svg.append(circle);
  }
  const role = S.me.role;
  return el('div', { class: `timer ring-timer${soon ? ' soon' : ''}${head ? ' head' : ''}` }, svg,
    el('div', {},
      el('div', { class: 'label', text: head ? t('timer.headStart') : t('timer.nextPing') }),
      el('div', { class: 'value', text: fmtCountdown(left) }),
      head && role ? el('div', { class: 'hero-line', text: t(role === 'runner' ? 'hero.runner' : 'hero.hunter') }) : null));
}

// 3-2-1 beim live miterlebten Start – antippen überspringt
function startCountdown() {
  document.getElementById('countdown')?.remove();
  const role = S.me.role;
  const mins = S.room.headStartMin;
  const num = el('div', { class: 'cd-num' });
  const sub = el('div', {
    class: 'cd-sub',
    text: role === 'runner' ? t(mins ? 'countdown.runner' : 'countdown.runnerNow', { min: mins })
      : role === 'hunter' ? t(mins ? 'countdown.hunter' : 'countdown.hunterNow', { min: mins }) : t('countdown.other'),
  });
  const node = el('div', { class: `countdown ${role || ''}`, id: 'countdown', role: 'status' }, num, sub);
  const steps = ['3', '2', '1', t('countdown.go')];
  let i = 0;
  let timerId = null;
  const finish = () => { clearTimeout(timerId); node.remove(); };
  node.addEventListener('click', finish);
  const step = () => {
    num.textContent = steps[i];
    num.classList.remove('pop');
    void num.offsetWidth; // Animation neu starten
    num.classList.add('pop');
    if (i < 3) { sound('tick'); vibrate([60]); } else { sound('start'); vibrate([300, 100, 300]); }
    i++;
    timerId = setTimeout(i < steps.length ? step : finish, i < steps.length ? 800 : 1200);
  };
  document.body.append(node);
  step();
}

// Rollen-Karte: Vollbild in der Rollenfarbe, auf Wunsch mit der Kurzanleitung darunter
function showRoleReveal(role, withGuide) {
  const ov = $('#infoOverlay');
  if (!ov.classList.contains('hidden') && !withGuide) return;
  check.overlay = false;
  const close = () => {
    store.set('mh_guide_seen', [...new Set([...guideSeen(), role])].join(','));
    ov.classList.add('hidden');
  };
  ov.replaceChildren(el('div', { class: `card stack reveal-card ${role}` },
    el('div', { class: 'reveal-head' },
      el('div', { class: 'reveal-icon', 'aria-hidden': 'true', text: role === 'runner' ? '🏃' : '🔎' }),
      el('div', { class: 'reveal-kicker', text: t('reveal.kicker') }),
      el('h2', { text: t(`guide.${role}.title`) }),
      el('p', { text: t(`reveal.${role}`) })),
    withGuide ? guideSteps(role, false) : null,
    el('button', { class: 'btn primary big', type: 'button', onclick: close, text: t('guide.ok') }),
    withGuide ? el('button', { class: 'btn sm linkish', type: 'button', onclick: () => { close(); showRules(); }, text: t('guide.allRules') }) : null));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
}

// Ergebnis: Sieger, Bestenliste „am längsten frei“ und die eigene Bilanz
function resultInfo() {
  const { room, me } = S;
  const end = room.endedAt || now();
  const mins = (r) => Math.max(0, Math.round(((r.caughtAt || end) - room.startedAt) / 60000));
  const board = S.runners.map((r) => ({ name: r.name, min: mins(r), free: !r.caughtAt }))
    .sort((a, b) => b.min - a.min || a.name.localeCompare(b.name));
  const w = room.result?.winner;
  const mine = S.runners.find((r) => r.name === me.name);
  const own = mine ? t(mine.caughtAt ? 'end.youCaught' : 'end.youFree', { min: mins(mine) })
    : me.role === 'hunter' && board.length ? t('end.hunterCount', { n: board.filter((b) => !b.free).length, total: board.length }) : '';
  return { winner: w || 'stopped', title: t(w === 'hunters' ? 'end.hunters' : w === 'runners' ? 'end.runners' : 'end.stopped'), board, own };
}

function resultCard(big) {
  const r = resultInfo();
  return el('div', { class: `result-card ${r.winner}${big ? ' big' : ''}` },
    el('div', { class: 'result-icon', 'aria-hidden': 'true', text: r.winner === 'hunters' ? '🔎' : r.winner === 'runners' ? '🏃' : '🏁' }),
    el('h2', { text: r.title }),
    el('p', { class: 'small result-reason', text: resultText(S.room) }),
    r.own ? el('p', { class: 'result-own', text: r.own }) : null,
    r.board.length ? el('div', { class: 'result-board-title small', text: t('end.board') }) : null,
    r.board.length ? el('ol', { class: 'result-board' }, r.board.slice(0, big ? 5 : 3).map((b, i) => el('li', {},
      el('span', { class: 'rank', text: ['🥇', '🥈', '🥉'][i] || `${i + 1}.` }),
      el('span', { class: 'who', text: b.name }),
      el('span', { class: 'min', text: t(b.free ? 'end.freeMin' : 'end.min', { min: b.min }) })))) : null);
}

function showResultOverlay() {
  if (!S || S.room.status !== 'ended') return;
  const ov = $('#infoOverlay');
  check.overlay = false;
  const mp = S.room.meetingPoint;
  const close = () => { ov.classList.add('hidden'); if (mp) fitToMeeting(); };
  ov.replaceChildren(el('div', { class: 'card stack result-overlay' },
    resultCard(true),
    mp ? el('p', { class: 'small', style: 'text-align:center;margin:0', text: t('end.meeting', { label: mp.label }) }) : null,
    el('button', { class: 'btn primary big', type: 'button', onclick: close, text: mp ? t('end.toMeeting') : t('common.ok') })));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
}

// Endspurt: einmal pro Spiel 5 Minuten vor Schluss – nicht bei sehr kurzen Spielen und nicht in den letzten Sekunden
function finalWarning(room, now_) {
  const left = room.endsAt - now_;
  if (!room.endsAt || finalWarnedFor === room.endsAt || left > FINAL_MS || left <= 0) return;
  finalWarnedFor = room.endsAt;
  store.set('mh_final_warned', String(room.endsAt));
  if (room.endsAt - room.startedAt <= 2 * FINAL_MS || left < 30000) return;
  const min = Math.max(1, Math.round(left / 60000));
  const role = S.me.role;
  showBanner('final', t(role === 'runner' ? 'final.runner' : role === 'hunter' ? 'final.hunter' : 'final.other', { min }),
    { cls: role === 'hunter' ? 'hunter' : 'message' });
  vibrate([300, 100, 300, 100, 300]);
  sound('final');
}

// „vor 3 min“ statt Uhrzeit: zeigt auf einen Blick, wie alt ein Ping-Standort ist
function fmtAgo(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return t('age.now');
  if (m < 60) return t('age.min', { n: m });
  return t('age.hm', { h: Math.floor(m / 60), m: m % 60 });
}
const pingLabel = (name, at) => `${name} · ${fmtAgo(now() - at)}`;

function updateAgeLabels() {
  for (const l of [...ageLabels.pings, ...ageLabels.hunters]) {
    const text = pingLabel(l.name, l.at);
    if (text !== l.text) { l.text = text; l.m.setTooltipContent(text); }
  }
}

// Vorwarnung kurz vor dem nächsten regulären Ping (auch vor dem ersten Ping am Ende des Vorsprungs)
function pingWarning(room, now_) {
  const warnMs = (room.pingWarningSec || 0) * 1000;
  const left = room.nextPingAt - now_;
  if (!warnMs || !room.nextPingAt || warnedFor === room.nextPingAt || left <= 0 || left > warnMs) return;
  warnedFor = room.nextPingAt;
  // Nicht warnen, wenn die Seite erst mitten im Warnzeitraum geöffnet wurde und kaum Zeit bleibt
  if (left < 5000) return;
  const first = room.nextPingAt === room.huntStartsAt;
  const when = fmtSeconds(Math.round(left / 1000 / 5) * 5 || 5, lang);
  const role = S.me.role;
  const key = role === 'runner' ? 'warn.runner' : role === 'hunter' ? 'warn.hunter' : 'warn.other';
  const firstWord = first ? t('warn.first') : role === 'hunter' ? t('warn.next') : '';
  showBanner('warn', t(key, { when, first: firstWord }), { cls: role === 'hunter' ? 'hunter' : '' });
  vibrate([100, 80, 100]);
  sound('warn');
}

function renderAlerts() {
  const { room, me } = S;
  const a = [];
  if (!online) a.push(['danger', t('alert.offline')]);
  if (outbox.length) a.push(['info', t('outbox.pending', { list: outbox.map(outboxLabel).join(', ') })]);
  // Nach Spielende sind Standort-Hinweise nur noch Rauschen
  if (room.status === 'ended') return swapIfChanged($('#alerts'), el('div', { class: 'stack' },
    a.map(([cls, text]) => el('div', { class: `alert ${cls}`, text }))));
  if (me.outside && room.zone) a.unshift(room.status === 'lobby' ? ['info', t('alert.outsideLobby')] : ['danger', t('alert.outside')]);
  if (tracking && geoError) a.push(['danger', t('alert.geo', { error: t(`geo.${geoError}`) })]);
  if (tracking && lastPos && lastPos.acc > 100) a.push(['', t('alert.inaccurate', { acc: lastPos.acc })]);
  if (tracking && 'wakeLock' in navigator && !wakeLock) a.push(['', t('alert.wakeLock'), requestWakeLock]);
  if (tracking && !('wakeLock' in navigator)) a.push(['info', t('alert.autoLock')]);
  // Akkustand kennen nur Android-Browser (iPhones melden ihn nicht)
  if (battery && battery.level < 0.15 && !battery.charging) a.push(['danger', t('alert.battery', { p: Math.round(battery.level * 100) })]);
  swapIfChanged($('#alerts'), el('div', { class: 'stack' },
    a.map(([cls, text, onclick]) => el('div', { class: `alert ${cls}`, text, onclick, role: onclick ? 'button' : null }))));
}

// Nur neu aufbauen, wenn sich der Inhalt geändert hat – sonst gehen Taps während des Neuaufbaus verloren.
// Während ein Knopf gedrückt gehalten wird, gar nicht neu aufbauen.
function swapIfChanged(container, fresh) {
  if (!container || isHolding() || container.innerHTML === fresh.innerHTML) return;
  container.replaceChildren(...fresh.childNodes);
}

const telHref = (phone) => `tel:${phone.replace(/[^+0-9]/g, '')}`;

function buildContent() {
  const { room, me } = S;
  const now_ = now();
  const box = el('div');

  // Notruf läuft
  if (me.emergency) {
    const e = me.emergency;
    box.append(el('div', { class: 'alert danger stack' },
      el('strong', { text: t('sos.sentAt', { time: fmtTime(e.at) }) }),
      el('div', { text: e.ackAt ? t('sos.acked', { time: fmtTime(e.ackAt) }) : t('sos.waiting') }),
      room.emergencyPhone
        ? el('a', { class: 'btn danger solid big', href: telHref(room.emergencyPhone), text: t('sos.call', { phone: room.emergencyPhone }) })
        : null,
      el('div', { class: 'small', text: t('sos.112') }),
      el('button', { class: 'btn', type: 'button', onclick: cancelSos, text: t('sos.cancel') })));
  }

  // Nachricht der Spielleitung bleibt nach dem Wegklicken des Banners hier lesbar
  if (room.message && store.get('mh_msg_seen') === room.message.id) {
    box.append(el('div', { class: 'message-note' }, el('strong', { text: t('msg.pinned') }), ` ${room.message.text}`));
  }

  // Nach Spielende: alle zum Treffpunkt
  if (room.status === 'ended' && room.startedAt) box.append(resultCard(false));
  if (room.status === 'ended' && room.meetingPoint) box.append(meetingBlock(room.meetingPoint, true));

  // Handy-Check in der Lobby direkt sichtbar
  if (room.status === 'lobby' && tracking) box.append(checkCard());

  // Rollen-Hinweis
  const hint = roleHint(room, me, now_);
  if (hint) box.append(el('p', { text: hint }));

  // Aktionen
  const actions = el('div', { class: 'stack' });
  if (room.status === 'running' && me.role === 'runner') {
    // Im Funkloch gespeichert: nicht noch einmal anbieten
    if (pending('/api/play/caught')) actions.append(el('div', { class: 'alert info', text: t('outbox.caughtWaiting') }));
    else actions.append(el('button', { class: 'btn danger solid big', type: 'button', onclick: reportCaught, text: t('btn.caught') }));
    if (me.blockArmed) actions.append(el('div', { class: 'alert info', text: t('block.armed') }));
    else if (pending('/api/play/block')) actions.append(el('div', { class: 'alert info', text: t('outbox.blockWaiting') }));
    else if (me.blocksLeft > 0) {
      actions.append(el('button', { class: 'btn big', type: 'button', onclick: armBlock, text: t('block.button', { n: me.blocksLeft }) }));
    }
  }
  if (room.status === 'running' && me.role === 'hunter' && room.extraPingsLeft > 0 && now_ >= room.huntStartsAt) {
    actions.append(el('button', { class: 'btn primary big', type: 'button', onclick: extraPing, text: t('btn.extraPing', { n: room.extraPingsLeft }) }));
  }
  // Mister-X-Stil: Verkehrsmittel melden
  if (room.status === 'running' && me.role === 'runner' && room.transportReports) {
    const waiting = pending('/api/play/transport');
    const cur = waiting ? { mode: waiting.body.mode, at: waiting.body.at } : me.transport;
    actions.append(el('div', { class: 'transport-box' },
      el('div', {
        class: 'small',
        text: cur
          ? t('transport.reported', { icon: TRANSPORT_ICON[cur.mode], label: transportLabel(cur.mode), time: fmtTime(cur.at) })
          : t('transport.prompt'),
      }),
      el('div', { class: 'transport-buttons' }, Object.keys(TRANSPORT_ICON).map((mode) => el('button', {
        class: `btn ${cur?.mode === mode ? 'primary' : ''}`, type: 'button', onclick: () => reportTransport(mode),
        'aria-pressed': cur?.mode === mode ? 'true' : 'false',
      }, el('span', { 'aria-hidden': 'true', text: TRANSPORT_ICON[mode] }), ` ${transportLabel(mode)}`)))));
  }
  // Symbolleiste: seltene Funktionen klein, damit Karte und die großen Spielknöpfe Platz haben
  const tool = (icon, label, onclick, pressed) => el('button', {
    class: `tool${pressed ? ' on' : ''}`, type: 'button', onclick, title: label, 'aria-pressed': pressed == null ? null : String(pressed),
  }, el('span', { class: 'tool-icon', 'aria-hidden': 'true', text: icon }), el('span', { class: 'tool-label', text: label }));
  actions.append(el('div', { class: 'toolbar' },
    tool('🎯', t('tool.center'), centerOnMe),
    tool('📋', t('tool.rules'), showRules),
    tool(soundOn ? '🔔' : '🔕', t(soundOn ? 'tool.soundOn' : 'tool.soundOff'), toggleSound, soundOn),
    tool('☀️', t('tool.sun'), toggleSun, sunOn),
    room.status === 'lobby' ? tool('✏️', t('tool.rename'), rename) : tool('🩺', t('tool.check'), openCheck)));
  box.append(actions);

  if (room.meetingPoint && room.status !== 'ended') box.append(meetingBlock(room.meetingPoint, false));

  // Gejagte-Übersicht (Jäger sehen dazu gemeldete Verkehrsmittel und Blocks beim letzten Ping)
  if (room.status !== 'lobby' && S.runners.length) {
    const free = S.runners.filter((r) => !r.caughtAt).length;
    const blocked = new Set((S.pings?.at(-1)?.positions || []).filter((p) => p.blocked).map((p) => p.name));
    box.append(
      el('h3', { text: t('list.runners', { free, total: S.runners.length }) }),
      el('ul', { class: 'list' }, S.runners.map((r) => el('li', {},
        el('span', { class: r.caughtAt ? 'strike' : '', text: r.name }),
        el('span', {
          class: 'muted small',
          text: r.caughtAt ? t('list.caughtAt', { time: fmtTime(r.caughtAt) })
            : [
              blocked.has(r.name) ? `🛡 ${t('list.blocked')}` : null,
              r.transport ? t('transport.since', { icon: TRANSPORT_ICON[r.transport.mode], label: transportLabel(r.transport.mode), time: fmtTime(r.transport.at) }) : null,
            ].filter(Boolean).join(' · ') || t('list.free'),
        })))));
  }

  if (room.status === 'lobby' && S.lobby) {
    box.append(el('h3', { text: t('list.inRoom', { n: S.lobby.length }) }),
      el('div', { class: 'chips' }, S.lobby.map((n) => el('span', { class: `chip${n === me.name ? ' me' : ''}`, text: n }))));
  }

  if (room.zone) {
    box.append(el('p', {
      class: 'small muted',
      text: room.zone.points
        ? t(room.zoneFinalRadius ? 'zone.areaShrinking' : 'zone.area')
        : room.zoneFinalRadius
          ? t('zone.shrinking', { r: room.zone.radius, f: room.zoneFinalRadius })
          : t('zone.normal', { r: room.zone.radius }),
    }));
  }

  if (!me.emergency) {
    box.append(el('p', { class: 'small muted' },
      t('sos.hint'),
      room.emergencyPhone ? el('span', {}, t('sos.hintPhone'), el('a', { href: telHref(room.emergencyPhone), text: room.emergencyPhone })) : null));
  }

  box.append(el('p', { class: 'small muted footer-links' },
    el('a', { href: '/datenschutz', text: t('common.privacy') }), ' · ', langButton('btn sm linkish')));

  // Überzählige Handys (z. B. im Jäger-Team) melden sich ab – nur durch Gedrückthalten
  if (room.status === 'lobby') {
    box.append(el('div', { class: 'stack leave-box' },
      el('p', { class: 'small muted', text: t('leave.text') }),
      holdButton({ text: t('leave.button'), holdText: t('leave.hold'), cls: 'danger', title: t('leave.title'), onConfirm: leave })));
  }
  return box;
}

function meetingBlock(mp, prominent) {
  return el('div', { class: `meeting-box ${prominent ? 'prominent' : ''}` },
    el('div', {}, el('strong', { text: prominent ? t('meeting.all') : t('meeting.label') }), mp.label),
    el('div', { class: 'row' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => showMeeting(mp), text: t('meeting.show') }),
      el('a', { class: `btn sm ${prominent ? 'primary' : ''}`, href: routeUrl(mp.lat, mp.lng), target: '_blank', rel: 'noopener', text: t('meeting.route') })));
}

function roleHint(room, me, now_) {
  if (room.status === 'lobby') {
    if (!me.role) return t('hint.lobbyNone');
    return t(me.role === 'hunter' ? 'hint.lobbyHunter' : 'hint.lobbyRunner');
  }
  if (room.status === 'running') {
    if (!me.role) return t('hint.runningNone');
    const beforeHunt = now_ < room.huntStartsAt;
    if (me.role === 'runner') return beforeHunt ? t('hint.runnerHeadStart') : t('hint.runner', { min: room.pingIntervalMin });
    if (me.role === 'hunter') {
      if (beforeHunt) return t('hint.hunterHeadStart');
      return S.lastPingAt ? t('hint.hunterLastPing', { time: fmtTime(S.lastPingAt), age: fmtAgo(now_ - S.lastPingAt) }) : t('hint.hunterFirstPing');
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Handy-Check: GPS, Display-an, Ton, Akku, Vibration, App, Offline-Karte
// ---------------------------------------------------------------------------

function checkStatus() {
  const gps = geoError === 'denied' ? 'fail'
    : !lastPos ? (geoError ? 'fail' : null)
      : lastPos.acc <= 50 ? 'ok' : 'weak';
  return {
    gps,
    wakeLock: !('wakeLock' in navigator) ? 'unsupported' : wakeLock ? 'ok' : 'fail',
    sound: check.sound,
    vibrate: typeof navigator.vibrate === 'function',
    battery: battery ? battery.level : null,
    platform,
    installed: standalone,
  };
}

// Ergebnis an die Spielleitung melden – nur wenn sich etwas geändert hat
function sendCheck() {
  if (!tracking || !S) return;
  const c = checkStatus();
  if (!c.gps) return;
  const key = JSON.stringify({ ...c, battery: c.battery == null ? null : Math.round(c.battery * 10) });
  if (key === check.sentKey) return;
  check.sentKey = key;
  api('POST', '/api/play/check', c, auth).catch(() => { check.sentKey = ''; });
}

function checkCard() {
  const c = checkStatus();
  const allOk = (c.gps === 'ok' || c.gps === 'weak') && c.wakeLock === 'ok' && c.sound === 'ok';
  const tip = (ios, android) => (platform === 'ios' ? ios : platform === 'android' ? android : `${ios} ${android}`);
  const row = (state, icon, label, value, extra) => el('div', { class: `check-item ${state}` },
    el('span', { class: 'check-state', 'aria-hidden': 'true', text: { ok: '✓', warn: '!', fail: '✗', wait: '…', info: 'i' }[state] }),
    el('div', { class: 'check-body' },
      el('div', {}, el('strong', { text: `${icon} ${label}: ` }), el('span', { text: value })),
      extra));
  const small = (text) => el('div', { class: 'small muted', text });

  const gpsRow = row(
    c.gps === 'ok' ? 'ok' : c.gps === 'weak' ? 'warn' : c.gps === 'fail' ? 'fail' : 'wait',
    '📍', t('check.gps'),
    c.gps === 'ok' ? t('check.gpsOk', { acc: lastPos.acc }) : c.gps === 'weak' ? t('check.gpsWeak', { acc: lastPos.acc })
      : c.gps === 'fail' ? t('check.gpsFail') : t('check.gpsWait'),
    c.gps === 'fail' ? small(tip(t('check.gpsTipIos'), t('check.gpsTipAndroid'))) : null);

  const screenRow = row(c.wakeLock === 'ok' ? 'ok' : 'warn', '🔆', t('check.screen'),
    c.wakeLock === 'ok' ? t('check.screenOk') : t('check.screenFail'),
    c.wakeLock === 'ok' ? null : small(tip(t('check.screenTipIos'), t('check.screenTipAndroid'))));

  let soundExtra;
  if (check.asking) {
    soundExtra = el('div', { class: 'row' },
      el('span', { class: 'small', text: t('check.soundQuestion') }),
      el('button', { class: 'btn sm primary', type: 'button', onclick: () => soundAnswer(true), text: t('check.yes') }),
      el('button', { class: 'btn sm', type: 'button', onclick: () => soundAnswer(false), text: t('check.no') }));
  } else {
    soundExtra = el('div', { class: 'stack' },
      c.sound === 'fail' ? small(t('check.soundTip')) : null,
      c.sound !== 'ok' ? el('button', { class: 'btn sm', type: 'button', onclick: testSound, text: t('check.soundTest') }) : null);
  }
  const soundRow = row(c.sound === 'ok' ? 'ok' : c.sound === 'fail' ? 'fail' : 'wait', '🔊', t('check.sound'),
    t(c.sound === 'ok' ? 'check.soundOk' : c.sound === 'fail' ? 'check.soundFail' : 'check.soundUntested'), soundExtra);

  const pct = c.battery == null ? null : Math.round(c.battery * 100);
  const batteryRow = row(pct == null || pct < 50 ? 'warn' : 'ok', '🔋', t('check.battery'),
    pct == null ? t('check.batteryUnknown') : pct < 50 ? t('check.batteryLow', { p: pct }) : t('check.batteryOk', { p: pct }));

  const vibrateRow = row(c.vibrate ? 'ok' : 'info', '📳', t('check.vibrate'), c.vibrate ? t('check.vibrateOk') : t('check.vibrateNo'));

  let appExtra = null;
  if (!standalone) {
    appExtra = el('div', { class: 'stack' },
      small(t('check.appWhy')),
      installPrompt ? el('button', { class: 'btn sm primary', type: 'button', onclick: installApp, text: t('check.appInstall') })
        : small(platform === 'ios' ? t('check.appIos') : t('check.appOther')));
  }
  const appRow = row(standalone ? 'ok' : 'info', '📲', t('check.app'), standalone ? t('check.appInstalled') : '', appExtra);

  let mapRow = null;
  if (cfg?.tileProxy) {
    const saved = store.get('mh_map_saved') === mapSaveKey();
    const state = mapSave.state === 'saving' ? 'wait' : saved || mapSave.state === 'done' ? 'ok' : mapSave.state === 'fail' ? 'warn' : 'info';
    const value = mapSave.state === 'saving' ? t('check.mapSaving', { done: mapSave.done, total: mapSave.total })
      : mapSave.state === 'done' ? t('check.mapSaved', { n: mapSave.ok })
        : mapSave.state === 'fail' ? t('check.mapFail', { ok: mapSave.ok, total: mapSave.total })
          : saved ? t('check.mapSaved', { n: store.get('mh_map_count') || '' }) : '';
    mapRow = row(state, '🗺', t('check.map'), value, mapSave.state === 'saving' ? null : el('div', { class: 'stack' },
      small(t('check.mapWhy')),
      el('button', { class: 'btn sm', type: 'button', onclick: saveMap, text: t('check.mapSave') })));
  }

  return el('div', { class: 'card check-card stack' },
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h3', { style: 'margin:0', text: t('check.title') }),
      allOk ? el('span', { class: 'badge running', text: t('check.allOk') }) : null),
    allOk ? null : small(t('check.intro')),
    checkProgress(c),
    gpsRow, screenRow, soundRow, batteryRow, vibrateRow, appRow, mapRow);
}

function checkProgress(c) {
  const n = [(c.gps === 'ok' || c.gps === 'weak'), c.wakeLock === 'ok', c.sound === 'ok'].filter(Boolean).length;
  const bar = el('span', { class: 'check-bar-fill' });
  bar.style.width = `${Math.round((n / 3) * 100)}%`;
  return el('div', { class: `check-progress${n === 3 ? ' done' : ''}` },
    el('span', { class: 'check-bar', 'aria-hidden': 'true' }, bar),
    el('span', { class: 'small', text: t('check.progress', { n, total: 3 }) }));
}

function testSound() {
  unlockAudio();
  setTimeout(() => playSound(SOUNDS.start), 50);
  check.asking = true;
  render();
}

function soundAnswer(heard) {
  check.asking = false;
  check.sound = heard ? 'ok' : 'fail';
  store.set('mh_check_sound', check.sound);
  render();
}

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  render();
}

function openCheck() {
  const ov = $('#infoOverlay');
  check.overlay = true;
  const close = () => { check.overlay = false; ov.classList.add('hidden'); };
  ov.replaceChildren(el('div', { class: 'card stack check-overlay' },
    el('div', { id: 'checkHost' }, checkCard()),
    el('button', { class: 'btn primary', type: 'button', onclick: close, text: t('common.close') })));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
}

// --- Offline-Karte: Kacheln des Spielfelds (Zoom 13–16) vorab in den Speicher des Handys laden -----------
// Nur bis Zoom 16 – so erlaubt es die Nutzungsrichtlinie von OpenStreetMap. Sie kommen vom
// Zwischenspeicher dieses Servers, OpenStreetMap wird dadurch nicht mehrfach belastet.

const lon2tile = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function mapArea() {
  const z = S?.room.zone;
  if (z) return { lat: z.lat, lng: z.lng, radius: z.radius * 1.15 };
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng, radius: 1500 };
}

const mapSaveKey = () => {
  const a = mapArea();
  return `${a.lat.toFixed(3)},${a.lng.toFixed(3)},${Math.round(a.radius)}`;
};

function tileUrls() {
  const a = mapArea();
  const b = L.latLng(a.lat, a.lng).toBounds(a.radius * 2);
  const urls = [];
  for (let z = 13; z <= 16; z++) {
    for (let x = lon2tile(b.getWest(), z); x <= lon2tile(b.getEast(), z); x++) {
      for (let y = lat2tile(b.getNorth(), z); y <= lat2tile(b.getSouth(), z); y++) urls.push(`/tiles/${z}/${x}/${y}.png`);
    }
  }
  return urls.slice(0, 600);
}

async function saveMap() {
  if (mapSave.state === 'saving') return;
  const urls = tileUrls();
  mapSave = { state: 'saving', done: 0, total: urls.length, ok: 0 };
  render();
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try { if ((await fetch(url)).ok) mapSave.ok++; } catch { /* Funkloch */ }
      mapSave.done++;
      if (mapSave.done % 8 === 0) render();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  mapSave.state = mapSave.ok === urls.length ? 'done' : 'fail';
  if (mapSave.state === 'done') {
    store.set('mh_map_saved', mapSaveKey());
    store.set('mh_map_count', String(mapSave.ok));
  }
  render();
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

async function playerAction(path, body) {
  stateVersion++;
  try {
    S = await api('POST', path, body, auth, { timeout: ACTION_TIMEOUT });
    stateVersion++;
    detectChanges();
    render();
    return true;
  } catch (e) {
    if (e.status === 401) handleError(e);
    else if (isTemporary(e) && QUEUEABLE.has(path)) queueAction(path, body);
    else alert(isTemporary(e) ? t('action.offline') : e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Funkloch-Puffer: „Gefangen“, Verkehrsmittel, Block und Notruf gehen ohne Netz (U-Bahn) nicht verloren.
// Sie warten auf dem Handy (auch über ein Neuladen hinweg) und werden mit dem Zeitpunkt des Tipps nachgesendet.
// ---------------------------------------------------------------------------

function queueAction(path, body = {}) {
  const sos = path === '/api/play/sos';
  if (path === '/api/play/transport') outbox = outbox.filter((o) => o.path !== path); // nur die neueste Meldung zählt
  else if (pending(path)) return;
  // Runde merken: Was im Funkloch einer Runde getippt wurde, darf nicht in der nächsten ankommen
  // … und den Zugang: Wird das Handy später für jemand anderen genutzt, geht nichts unter falschem Namen raus
  const item = { path, body: { ...body, at: now() }, round: sos ? null : S?.room.startedAt ?? null, token };
  if (sos) outbox.unshift(item); else outbox.push(item); // Notruf zuerst
  saveOutbox();
  setOnline(false);
  if (!sos) showBanner('outbox', t('outbox.queued'));
  render();
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !outbox.length || stopped || !S) return;
  flushing = true;
  let sent = 0;
  try {
    // Einträge immer per Identität entfernen: Während eine Anfrage läuft, kann vorne ein Notruf dazukommen
    const drop = (item) => { outbox = outbox.filter((o) => o !== item); };
    while (outbox.length) {
      const item = outbox[0];
      if ((item.round && item.round !== S.room.startedAt) || (item.token && item.token !== token)) { drop(item); continue; }
      try {
        stateVersion++;
        S = await api('POST', item.path, item.body, auth, { timeout: ACTION_TIMEOUT });
        stateVersion++;
        drop(item);
        sent++;
        setOnline(true);
        detectChanges();
      } catch (e) {
        if (e.status === 401) { handleError(e); break; }
        if (isTemporary(e)) { setOnline(false); break; } // kein Netz oder Server startet neu – später erneut
        drop(item); // vom Server abgelehnt, z. B. Spiel vorbei oder schon erledigt
        if (item.path === '/api/play/sos') sosFailedAlert(e, false); // einen Notruf nie stillschweigend verwerfen
      }
    }
  } finally {
    flushing = false;
    saveOutbox();
    if (sent && !stopped) showBanner('outbox', t('outbox.sent'), { cls: 'message' });
    render();
  }
}

function reportCaught() {
  if (confirm(t('btn.caughtConfirm'))) playerAction('/api/play/caught');
}

function extraPing() {
  if (confirm(t('btn.extraPingConfirm', { n: S.room.extraPingsLeft - 1 }))) playerAction('/api/play/extra-ping');
}

function armBlock() {
  if (confirm(t('block.confirm', { n: S.me.blocksLeft - 1 }))) playerAction('/api/play/block');
}

async function rename() {
  const name = prompt(t('btn.renamePrompt'), S.me.name);
  if (name) playerAction('/api/play/rename', { name });
}

// Abgesichert durch 2 Sekunden Gedrückthalten – daher keine zusätzliche Rückfrage
async function leave() {
  try {
    await api('POST', '/api/play/leave', undefined, auth);
    store.del('mh_token');
    showGone(t('gone.left'));
  } catch (e) { alert(e.message); }
}

async function triggerSos() {
  vibrate([150]);
  if (!tracking) startTracking();
  maybeSend(true);
  stateVersion++;
  showBanner('sos', t('sos.sending'), { cls: 'hunter', sticky: true });
  try {
    S = await api('POST', '/api/play/sos', { at: now() }, auth, { timeout: ACTION_TIMEOUT });
    stateVersion++;
    detectChanges();
    render();
    showBanner('sos', t('banner.sosSent'), { cls: 'hunter' });
  } catch (e) {
    document.getElementById('banner-sos')?.remove();
    if (e.status === 401) return handleError(e);
    // Ohne Netz: trotzdem sofort anrufen lassen – und den Notruf nachsenden, sobald wieder Netz da ist
    const queued = isTemporary(e);
    if (queued) queueAction('/api/play/sos');
    sosFailedAlert(e, queued);
  }
}

function sosFailedAlert(e, queued) {
  const phone = S?.room.emergencyPhone;
  alert(t('sos.failed', { error: queued ? t('sos.noSignal') : e.message }) + (phone ? t('sos.failedCall', { phone }) : t('sos.failedNoPhone'))
    + (queued ? t('sos.queued') : '') + ` ${t('sos.112')}`);
}

function cancelSos() {
  if (confirm(t('sos.cancelConfirm'))) playerAction('/api/play/sos-cancel');
}

function reportTransport(mode) {
  playerAction('/api/play/transport', { mode });
}

function showRules() {
  const ov = $('#infoOverlay');
  const close = () => ov.classList.add('hidden');
  const key = guideKey();
  ov.replaceChildren(el('div', { class: 'card stack' },
    key ? guideSteps(key) : null,
    el('h2', { text: t('rules.title') }),
    el('div', { class: 'rules-text', text: rulesText(S.room, lang) }),
    el('button', { class: 'btn primary big', type: 'button', onclick: close, text: t('rules.ok') })));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Kurzanleitung: drei Schritte je Rolle, beim ersten Öffnen als Overlay (pro Gerät und Rolle gemerkt),
// danach jederzeit oben im Regel-Fenster
// ---------------------------------------------------------------------------

function guideKey() {
  const { room, me } = S;
  if (room.status === 'ended') return null;
  if (me.role === 'runner' || me.role === 'hunter') return me.role;
  return room.status === 'lobby' ? 'lobby' : null;
}

const guideSeen = () => new Set((store.get('mh_guide_seen') || '').split(',').filter(Boolean));

function guideSteps(key, withTitle = true) {
  // Spielfeld und Vorwarnung nur erwähnen, wenn es sie in diesem Raum gibt
  const vars = { zone: S.room.zone ? t('guide.zone') : '', warn: S.room.pingWarningSec ? t('guide.warn') : '' };
  return el('div', { class: 'guide stack' },
    withTitle ? el('h2', { text: t(`guide.${key}.title`) }) : null,
    el('ol', { class: 'guide-steps' }, [1, 2, 3].map((i) => el('li', { text: t(`guide.${key}.${i}`, vars) }))),
    el('p', { class: 'small', text: t('guide.sos') }));
}

let guideRunningChecked = false;
function maybeShowGuide() {
  if (!tracking || stopped) return;
  // Im laufenden Spiel nur beim ersten Anzeigen nach „Loslegen“ – nicht mitten in der Jagd (z. B. nach dem Fangen),
  // dort würde das Fenster Karte und SOS-Knopf verdecken
  if (S?.room.status === 'running') {
    if (guideRunningChecked) return;
    guideRunningChecked = true;
  }
  const key = guideKey();
  const ov = $('#infoOverlay');
  if (!key || guideSeen().has(key) || !ov.classList.contains('hidden') || isHolding()) return;
  if (key !== 'lobby') return showRoleReveal(key, true);
  const close = () => {
    store.set('mh_guide_seen', [...guideSeen(), key].join(','));
    ov.classList.add('hidden');
  };
  ov.replaceChildren(el('div', { class: 'card stack guide-card' },
    guideSteps(key),
    el('button', { class: 'btn primary big', type: 'button', onclick: close, text: t('guide.ok') }),
    el('button', { class: 'btn sm linkish', type: 'button', onclick: () => { close(); showRules(); }, text: t('guide.allRules') })));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
}

function toggleSound() {
  soundOn = !soundOn;
  store.set('mh_sound', soundOn ? 'on' : 'off');
  if (soundOn) { unlockAudio(); playSound(SOUNDS.ping); }
  render();
}

function toggleSun() {
  sunOn = !sunOn;
  store.set('mh_sun', sunOn ? 'on' : 'off');
  applyTheme();
  // Farben und Größen der Kartenpunkte hängen vom Modus ab – alles neu zeichnen
  pingsKey = null;
  ownStyleKey = '';
  render();
}

function showMeeting(mp) {
  autoFit = null;
  map.setView([mp.lat, mp.lng], 17);
}

function centerOnMe() {
  if (!lastPos) return;
  autoFit = null;
  map.setView([lastPos.lat, lastPos.lng], Math.max(map.getZoom(), 16));
}

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

let zoneKey = '';
let meetingKey = '';
let pingsKey = '';
function drawMap() {
  if (!map) return;
  const { room } = S;

  const mKey = JSON.stringify(room.meetingPoint);
  if (mKey !== meetingKey) {
    meetingKey = mKey;
    layers.meeting.clearLayers();
    if (room.meetingPoint) meetingMarker(room.meetingPoint).addTo(layers.meeting);
  }

  const key = JSON.stringify([room.zone, room.zoneFinalRadius]);
  if (key !== zoneKey) {
    zoneKey = key;
    drawZone(layers.zone, room.zone, room.zoneFinalRadius);
  }

  // Pings nur neu zeichnen, wenn ein neuer dazukommt (spart Akku bei jeder Abfrage)
  const pings = S.pings || [];
  const scale = sunOn ? 1.35 : 1;
  const hunterColor = cssVar('--hunter-map'), runnerColor = cssVar('--runner');
  const pKey = pings.map((p) => p.id).join();
  if (pKey !== pingsKey) {
    pingsKey = pKey;
    layers.pings.clearLayers();
    ageLabels.pings = [];
    // Spur pro Gejagtem über die letzten Pings (blockierte oder fehlende Positionen haben keine Koordinaten)
    const trails = {};
    pings.forEach((ping, i) => {
      const latest = i === pings.length - 1;
      for (const pos of ping.positions) {
        if (pos.lat == null) continue;
        (trails[pos.playerId] ??= []).push([pos.lat, pos.lng]);
        const label = latest ? pingLabel(pos.name, ping.at) : null;
        const m = labeledMarker([pos.lat, pos.lng], {
          color: runnerColor,
          radius: (latest ? 9 : 5) * scale,
          fill: latest ? 0.9 : 0.35,
          label,
        }).addTo(layers.pings);
        if (latest) ageLabels.pings.push({ m, name: pos.name, at: ping.at, text: label });
        else m.bindTooltip(() => pingLabel(pos.name, ping.at), { direction: 'top', offset: [0, -5 * scale], className: 'map-label small' });
      }
    });
    for (const pts of Object.values(trails)) {
      if (pts.length > 1) L.polyline(pts, { color: runnerColor, weight: 2 * scale, opacity: 0.5, dashArray: '4 6' }).addTo(layers.pings);
    }
  }

  layers.hunters.clearLayers();
  ageLabels.hunters = [];
  // Gejagte: Jäger-Positionen vom letzten Ping (gestrichelt, mit Alter – keine Live-Positionen)
  const snap = room.status === 'running' ? S.huntersAtPing : null;
  for (const h of snap?.hunters || []) {
    const label = pingLabel(h.name, snap.at);
    const m = labeledMarker([h.lat, h.lng], { color: hunterColor, radius: 8 * scale, fill: 0.75, dashed: true, label })
      .addTo(layers.hunters);
    ageLabels.hunters.push({ m, name: h.name, at: snap.at, text: label });
  }
  for (const h of room.status === 'running' ? S.hunters || [] : []) {
    const stale = now() - h.t > 120000;
    labeledMarker([h.lat, h.lng], { color: hunterColor, radius: 7 * scale, fill: stale ? 0.3 : 0.9, label: h.name, className: stale ? 'old' : '' })
      .addTo(layers.hunters);
  }
  drawOwn();
  initialView();
  scheduleDeclutter();
}

// Kartenschilder entzerren: wichtigere Schilder zuerst (Gejagte beim Ping, dann Jäger, dann Treffpunkt);
// der eigene Punkt wird nie verdeckt
let declutterQueued = false;
function scheduleDeclutter() {
  if (declutterQueued) return;
  declutterQueued = true;
  requestAnimationFrame(() => {
    declutterQueued = false;
    if (map) declutterLabels([layers.pings, layers.hunters, layers.meeting], [ownDot?.getElement()?.querySelector('.me-dot')], scheduleDeclutter);
  });
}

// Ping-Moment sichtbar machen: Radar-Ringe über den neuen Positionen (bei Gejagten auch über dem eigenen Punkt –
// „jetzt sehen dich die Jäger“, außer der Block hat gegriffen)
function pingEffect(blocked) {
  if (!map || !S) return;
  const pts = [];
  if (S.me.role === 'hunter') {
    for (const p of S.pings?.at(-1)?.positions || []) if (p.lat != null) pts.push([p.lat, p.lng, cssVar('--runner')]);
  } else if (S.me.role === 'runner') {
    for (const h of S.huntersAtPing?.hunters || []) pts.push([h.lat, h.lng, cssVar('--hunter-map')]);
    if (lastPos && !blocked) pts.push([lastPos.lat, lastPos.lng, cssVar('--runner')]);
  }
  for (const [lat, lng, c] of pts) {
    const ring = `<span class="ping-ring" style="--c:${c}"></span><span class="ping-ring r2" style="--c:${c}"></span>`;
    const m = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'ping-fx', html: ring, iconSize: [20, 20], iconAnchor: [10, 10] }),
      interactive: false, keyboard: false,
    }).addTo(layers.fx);
    setTimeout(() => layers.fx.removeLayer(m), 5200);
  }
}

// Erster Kartenausschnitt: Jäger sehen den letzten Ping, sonst das Spielfeld, sonst sich selbst
function initialView() {
  if (centered || !map || !S) return;
  if (S.room.status === 'ended' && S.room.meetingPoint) return fitToMeeting();
  if (S.me.role === 'hunter' && S.pings?.some((p) => p.positions.some((x) => x.lat != null))) return fitToPing();
  if (S.me.role === 'runner' && S.huntersAtPing?.hunters.length) return fitToPing();
  let fit = null;
  if (S.room.zone) {
    const z = S.room.zone;
    fit = () => { map.invalidateSize({ pan: false }); map.fitBounds(zoneBounds(z)); };
  } else if (lastPos) {
    const { lat, lng } = lastPos;
    fit = () => { map.invalidateSize({ pan: false }); map.setView([lat, lng], 16); };
  }
  if (!fit) return;
  fit();
  autoFit = fit;
  centered = true;
}

// Eigene Position: Punkt mit weißem Rand und Pfeil in Laufrichtung – ohne Schild, das spart Platz auf der Karte.
// Das GPS meldet sich bis zu jede Sekunde – die Marker werden nur verschoben, nicht neu gebaut.
let ownDot = null;
let ownAcc = null;
let ownStyleKey = '';
function drawOwn() {
  if (!map || !lastPos) return;
  const role = S?.me.role === 'hunter' || S?.me.role === 'runner' ? S.me.role : '';
  const color = role === 'hunter' ? cssVar('--hunter-map') : role === 'runner' ? cssVar('--runner') : '#666';
  const styleKey = `${role}|${sunOn}`;
  const ll = [lastPos.lat, lastPos.lng];
  if (styleKey !== ownStyleKey) {
    ownStyleKey = styleKey;
    layers.own.clearLayers();
    ownAcc = L.circle(ll, { radius: lastPos.acc, color, weight: 1, fillOpacity: 0.08, interactive: false });
    ownDot = L.marker(ll, {
      icon: L.divIcon({
        className: 'me-icon', iconSize: [24, 24], iconAnchor: [12, 12],
        html: `<div class="me-marker ${role} no-heading"><div class="me-halo"></div><div class="me-dir"></div><div class="me-dot"></div></div>`,
      }),
      title: t('map.you'), alt: t('map.you'), keyboard: false, zIndexOffset: 1000,
    }).addTo(layers.own);
  }
  ownDot.setLatLng(ll);
  const icon = ownDot.getElement()?.querySelector('.me-marker');
  const moving = Number.isFinite(lastPos.heading) && lastPos.speed > 0.6;
  icon?.classList.toggle('no-heading', !moving);
  if (moving) icon?.style.setProperty('--heading', `${Math.round(lastPos.heading)}deg`);
  ownAcc.setLatLng(ll).setRadius(lastPos.acc);
  if (lastPos.acc >= 500) layers.own.removeLayer(ownAcc);
  else if (!layers.own.hasLayer(ownAcc)) ownAcc.addTo(layers.own).bringToBack();
  initialView();
}

// Karte auf den letzten Ping einpassen: Jäger sehen die Gejagten, Gejagte die Jäger – plus die eigene Position
function fitToPing() {
  if (!map || !S) return;
  const latest = S.pings?.at(-1);
  const pts = [
    ...(latest?.positions || []).filter((p) => p.lat != null).map((p) => [p.lat, p.lng]),
    ...(S.huntersAtPing?.hunters || []).map((h) => [h.lat, h.lng]),
  ];
  if (lastPos) pts.push([lastPos.lat, lastPos.lng]);
  if (!pts.length) return;
  // Leaflet merkt sich die Kartengröße – vor dem Einpassen die aktuelle Größe erzwingen
  map.invalidateSize({ pan: false });
  map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 16 });
  autoFit = fitToPing;
  centered = true;
}

// Nach Spielende: Treffpunkt und eigene Position zusammen zeigen
function fitToMeeting() {
  const mp = S?.room.meetingPoint;
  if (!map || !mp) return;
  const pts = [[mp.lat, mp.lng]];
  if (lastPos) pts.push([lastPos.lat, lastPos.lng]);
  map.invalidateSize({ pan: false });
  map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 17 });
  autoFit = fitToMeeting;
  centered = true;
}
