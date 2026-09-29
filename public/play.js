import {
  $, api, el, store, fmtCountdown, fmtTime, distanceM, createMap, labeledMarker, meetingMarker, cssVar, getConfig,
  holdButton, isHolding, unlockAudio, playSound, SOUNDS, routeUrl, TRANSPORT_ICON, fmtSeconds, rulesText, drawZone, zoneBounds, errorContext,
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
const sound = (name) => { if (soundOn) playSound(SOUNDS[name]); };
const roleLabel = (role) => (role ? t(`role.${role}`) : t('role.none'));
const transportLabel = (mode) => t(`transport.${mode}`);
const GEO_TEXT_DE = { denied: 'Standortzugriff verweigert', unavailable: 'Kein GPS-Signal', timeout: 'GPS antwortet nicht' };

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
  for (const k of ['zone', 'meeting', 'pings', 'hunters', 'own']) layers[k] = L.layerGroup().addTo(map);
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || stopped) return;
    if (tracking && !wakeLock) requestWakeLock();
    poll();
    maybeSend(true);
  });
}

function showGone(text) {
  stopped = true;
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
  lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now() };
  geoError = null;
  drawOwn();
  if (firstFix && autoFit === fitToPing) fitToPing(); // eigene Position mit in den Ping-Ausschnitt nehmen
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
async function poll() {
  clearTimeout(pollTimer);
  if (stopped) return;
  try {
    const s = await api('GET', '/api/play/state', undefined, auth);
    clockOffset = s.serverTime - Date.now();
    S = s;
    setOnline(true);
    detectChanges();
    render();
  } catch (e) {
    handleError(e);
  }
  if (!stopped) pollTimer = setTimeout(poll, pollDelay());
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
  const close = () => { node.remove(); onClose?.(); };
  const node = el('div', { class: `banner ${cls}`, id: `banner-${id}` },
    el('span', { text }),
    el('button', { class: 'btn sm', type: 'button', onclick: close, text: t('common.ok') }));
  $('#banners').append(node);
  if (!sticky) setTimeout(() => node.remove(), 10000);
}

function detectChanges() {
  const { room, me } = S;
  if (prev.status && prev.status !== room.status) {
    if (room.status === 'running') {
      showBanner('status', t('banner.started'));
      vibrate([300, 100, 300]);
      sound('start');
      setTimeout(() => maybeSend(true)); // Spielleitung sieht sofort alle Positionen
    }
    if (room.status === 'lobby') showBanner('status', t('banner.lobby'));
    if (room.status === 'ended') sound('start');
  }
  if (prev.role === 'runner' && me.role === 'hunter' && me.caughtAt) {
    showBanner('role', t('banner.caught'), { cls: 'hunter', sticky: true });
    vibrate([500]);
    sound('caught');
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
      }
      vibrate([200, 100, 200]);
      sound('ping');
    }
  }
  prev = { status: room.status, role: me.role, emergencyAck: ackAt, blockArmed: me.blockArmed };

  // Nachricht der Spielleitung
  const msg = room.message;
  if (msg && store.get('mh_msg_seen') !== msg.id && !document.getElementById('banner-msg')) {
    showBanner('msg', t('banner.message', { text: msg.text }), {
      cls: 'message', sticky: true, onClose: () => store.set('mh_msg_seen', msg.id),
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
}

function timer(label, value) {
  return el('div', { class: 'timer' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }));
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
    items.push(timer(t('timer.status'), t('timer.waiting')));
  } else if (room.status === 'running') {
    if (now_ < room.huntStartsAt) items.push(timer(t('timer.headStart'), fmtCountdown(room.huntStartsAt - now_)));
    else items.push(timer(t('timer.nextPing'), fmtCountdown(room.nextPingAt - now_)));
    items.push(timer(t('timer.end'), fmtCountdown(room.endsAt - now_)));
    pingWarning(room, now_);
  } else {
    items.push(el('div', { class: 'alert result', text: resultText(room) }));
  }
  $('#timers').replaceChildren(...items);
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
  // Nach Spielende sind Standort-Hinweise nur noch Rauschen
  if (room.status === 'ended') return swapIfChanged($('#alerts'), el('div', { class: 'stack' },
    a.map(([cls, text]) => el('div', { class: `alert ${cls}`, text }))));
  if (me.outside && room.zone) a.unshift(['danger', t('alert.outside')]);
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

  // Nach Spielende: alle zum Treffpunkt
  if (room.status === 'ended' && room.meetingPoint) box.append(meetingBlock(room.meetingPoint, true));

  // Handy-Check in der Lobby direkt sichtbar
  if (room.status === 'lobby' && tracking) box.append(checkCard());

  // Rollen-Hinweis
  const hint = roleHint(room, me, now_);
  if (hint) box.append(el('p', { text: hint }));

  // Aktionen
  const actions = el('div', { class: 'stack' });
  if (room.status === 'running' && me.role === 'runner') {
    actions.append(el('button', { class: 'btn danger solid big', type: 'button', onclick: reportCaught, text: t('btn.caught') }));
    if (me.blockArmed) actions.append(el('div', { class: 'alert info', text: t('block.armed') }));
    else if (me.blocksLeft > 0) {
      actions.append(el('button', { class: 'btn big', type: 'button', onclick: armBlock, text: t('block.button', { n: me.blocksLeft }) }));
    }
  }
  if (room.status === 'running' && me.role === 'hunter' && room.extraPingsLeft > 0 && now_ >= room.huntStartsAt) {
    actions.append(el('button', { class: 'btn primary big', type: 'button', onclick: extraPing, text: t('btn.extraPing', { n: room.extraPingsLeft }) }));
  }
  // Mister-X-Stil: Verkehrsmittel melden
  if (room.status === 'running' && me.role === 'runner' && room.transportReports) {
    const cur = me.transport;
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
  const row = el('div', { class: 'row' },
    el('button', { class: 'btn', type: 'button', onclick: centerOnMe, text: t('btn.center') }),
    el('button', { class: 'btn', type: 'button', onclick: showRules, text: t('btn.rules') }),
    el('button', { class: 'btn', type: 'button', onclick: toggleSound, text: soundOn ? t('btn.soundOn') : t('btn.soundOff') }),
    el('button', { class: `btn ${sunOn ? 'primary' : ''}`, type: 'button', onclick: toggleSun, 'aria-pressed': String(sunOn), text: t('btn.sun') }));
  if (room.status !== 'lobby') row.append(el('button', { class: 'btn', type: 'button', onclick: openCheck, text: t('btn.check') }));
  if (room.status === 'lobby') row.append(el('button', { class: 'btn', type: 'button', onclick: rename, text: t('btn.rename') }));
  actions.append(row);
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
    box.append(el('h3', { text: t('list.inRoom', { n: S.lobby.length }) }), el('p', { class: 'small muted', text: S.lobby.join(', ') }));
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
      return S.lastPingAt ? t('hint.hunterLastPing', { time: fmtTime(S.lastPingAt) }) : t('hint.hunterFirstPing');
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
    gpsRow, screenRow, soundRow, batteryRow, vibrateRow, appRow, mapRow);
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
  try {
    S = await api('POST', path, body, auth);
    detectChanges();
    render();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
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
  try {
    S = await api('POST', '/api/play/sos', undefined, auth);
    detectChanges();
    render();
    showBanner('sos', t('banner.sosSent'), { cls: 'hunter' });
  } catch (e) {
    const phone = S?.room.emergencyPhone;
    alert(t('sos.failed', { error: e.message }) + (phone ? t('sos.failedCall', { phone }) : t('sos.failedNoPhone')) + ` ${t('sos.112')}`);
  }
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
  ov.replaceChildren(el('div', { class: 'card stack' },
    el('h2', { text: t('rules.title') }),
    el('div', { class: 'rules-text', text: rulesText(S.room, lang) }),
    el('button', { class: 'btn primary big', type: 'button', onclick: close, text: t('rules.ok') })));
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
  const hunterColor = cssVar('--hunter'), runnerColor = cssVar('--runner');
  const pKey = pings.map((p) => p.id).join();
  if (pKey !== pingsKey) {
    pingsKey = pKey;
    layers.pings.clearLayers();
    // Spur pro Gejagtem über die letzten Pings (blockierte oder fehlende Positionen haben keine Koordinaten)
    const trails = {};
    pings.forEach((ping, i) => {
      const latest = i === pings.length - 1;
      for (const pos of ping.positions) {
        if (pos.lat == null) continue;
        (trails[pos.playerId] ??= []).push([pos.lat, pos.lng]);
        labeledMarker([pos.lat, pos.lng], {
          color: runnerColor,
          radius: (latest ? 9 : 5) * scale,
          fill: latest ? 0.9 : 0.35,
          label: latest ? `${pos.name} · ${fmtTime(ping.at)}` : null,
        }).addTo(layers.pings);
      }
    });
    for (const pts of Object.values(trails)) {
      if (pts.length > 1) L.polyline(pts, { color: runnerColor, weight: 2 * scale, opacity: 0.5, dashArray: '4 6' }).addTo(layers.pings);
    }
  }

  layers.hunters.clearLayers();
  for (const h of room.status === 'running' ? S.hunters || [] : []) {
    const stale = now() - h.t > 120000;
    labeledMarker([h.lat, h.lng], { color: hunterColor, radius: 7 * scale, fill: stale ? 0.3 : 0.9, label: h.name, className: stale ? 'old' : '' })
      .addTo(layers.hunters);
  }
  drawOwn();
  initialView();
}

// Erster Kartenausschnitt: Jäger sehen den letzten Ping, sonst das Spielfeld, sonst sich selbst
function initialView() {
  if (centered || !map || !S) return;
  if (S.me.role === 'hunter' && S.pings?.some((p) => p.positions.some((x) => x.lat != null))) return fitToPing();
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

// Eigene Position: Das GPS meldet sich bis zu jede Sekunde – die Marker werden nur verschoben, nicht neu gebaut
let ownDot = null;
let ownAcc = null;
let ownStyleKey = '';
function drawOwn() {
  if (!map || !lastPos) return;
  const color = S?.me.role === 'hunter' ? cssVar('--hunter') : S?.me.role === 'runner' ? cssVar('--runner') : '#666';
  const styleKey = `${color}|${sunOn}`;
  if (styleKey !== ownStyleKey) {
    ownStyleKey = styleKey;
    layers.own.clearLayers();
    ownAcc = L.circle([lastPos.lat, lastPos.lng], { radius: lastPos.acc, color, weight: 1, fillOpacity: 0.08 });
    ownDot = L.circleMarker([lastPos.lat, lastPos.lng], { radius: sunOn ? 12 : 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
      .bindTooltip(t('map.you'), { permanent: true, direction: 'right', offset: [10, 0], className: 'map-label' })
      .addTo(layers.own);
  }
  const ll = [lastPos.lat, lastPos.lng];
  ownDot.setLatLng(ll);
  ownAcc.setLatLng(ll).setRadius(lastPos.acc);
  if (lastPos.acc >= 500) layers.own.removeLayer(ownAcc);
  else if (!layers.own.hasLayer(ownAcc)) ownAcc.addTo(layers.own).bringToBack();
  initialView();
}

function fitToPing() {
  const latest = S?.pings?.at(-1);
  if (!map || !latest) return;
  const pts = latest.positions.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
  if (lastPos) pts.push([lastPos.lat, lastPos.lng]);
  if (!pts.length) return;
  // Leaflet merkt sich die Kartengröße – vor dem Einpassen die aktuelle Größe erzwingen
  map.invalidateSize({ pan: false });
  map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 16 });
  autoFit = fitToPing;
  centered = true;
}
