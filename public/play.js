import {
  $, api, el, store, fmtCountdown, fmtTime, ROLE_LABEL, distanceM, createMap, labeledMarker, meetingMarker, cssVar,
  holdButton, isHolding, unlockAudio, playSound, SOUNDS, routeUrl, TRANSPORT, TRANSPORT_ICON, fmtSeconds, rulesText,
  drawZone,
} from './common.js';

// Wiederbeitritts-Link /r/<token> (von der Spielleitung, z. B. nach Handywechsel)
const rejoin = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
if (rejoin) {
  store.set('mh_token', rejoin[1]);
  history.replaceState(null, '', '/play');
}

const token = store.get('mh_token');
const auth = { 'X-Player-Token': token };

let S = null;              // letzter Spielstand vom Server
let clockOffset = 0;       // Serverzeit - lokale Zeit
let prev = {};             // für Änderungserkennung (Rolle, Status)
let online = true;
let stopped = false;

let tracking = false;
let watchId = null;
let wakeLock = null;
let battery = null;
let lastPos = null;
let geoError = null;
let lastSentAt = 0;

let map = null;
const layers = {};
let centered = false;
let autoFit = null;        // zuletzt automatisch gewählter Ausschnitt, bis der Nutzer die Karte bewegt
let seenPingAt = Number(store.get('mh_seen_ping')) || 0;
let warnedFor = 0;         // für welchen Ping-Zeitpunkt die Vorwarnung schon kam
let soundOn = store.get('mh_sound') !== 'off';

const now = () => Date.now() + clockOffset;
const sound = (name) => { if (soundOn) playSound(SOUNDS[name]); };

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (!token) {
  showGone('Du bist in keinem Spiel angemeldet.');
} else {
  init();
}

async function init() {
  $('#startOverlay').classList.remove('hidden');
  $('#startBtn').addEventListener('click', startTracking);
  $('#sosSlot').replaceChildren(holdButton({
    text: 'SOS', holdText: 'halten', ms: 1500, cls: 'sos',
    title: 'Notruf an die Spielleitung – 1,5 Sekunden gedrückt halten', onConfirm: triggerSos,
  }));
  navigator.getBattery?.().then((b) => { battery = b; }).catch(() => {});
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
  setInterval(() => maybeSend(), 2000);
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
  $('#content').replaceChildren(el('a', { class: 'btn primary big', href: '/', text: 'Spielcode eingeben' }));
  $('#roleBadge').textContent = '–';
  $('#sosSlot').replaceChildren();
}

// ---------------------------------------------------------------------------
// Standort + Display anlassen
// ---------------------------------------------------------------------------

function startTracking() {
  if (!('geolocation' in navigator)) {
    $('#startErr').textContent = 'Dieses Gerät/dieser Browser kann keinen Standort bestimmen.';
    return;
  }
  if (!window.isSecureContext) {
    $('#startErr').textContent = 'Standort geht nur über eine https://-Adresse. Bitte der Spielleitung melden.';
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
  maybeSend();
}

function onPositionError(e) {
  geoError = e.code === 1 ? 'Standortzugriff verweigert' : e.code === 2 ? 'Kein GPS-Signal' : 'GPS antwortet nicht';
  render();
}

let lastSentPos = null;
function maybeSend(force = false) {
  if (!tracking || stopped) return;
  const since = Date.now() - lastSentAt;
  const moved = lastPos && lastSentPos ? distanceM(lastPos, lastSentPos) : Infinity;
  if (force || since > 10000 || (since > 3000 && moved > 10)) sendPosition();
}

async function sendPosition() {
  lastSentAt = Date.now();
  const body = lastPos
    ? { lat: lastPos.lat, lng: lastPos.lng, acc: lastPos.acc, age: Date.now() - lastPos.t }
    : { error: geoError || 'Noch kein Standort' };
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
  if (!stopped) pollTimer = setTimeout(poll, 3000);
}

function handleError(e) {
  if (e.status === 401) {
    store.del('mh_token');
    showGone('Du bist nicht mehr in diesem Spiel (entfernt oder Raum gelöscht).');
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
    el('button', { class: 'btn sm', type: 'button', onclick: close, text: 'OK' }));
  $('#banners').append(node);
  if (!sticky) setTimeout(() => node.remove(), 10000);
}

function detectChanges() {
  const { room, me } = S;
  if (prev.status && prev.status !== room.status) {
    if (room.status === 'running') { showBanner('status', 'Das Spiel hat begonnen!'); vibrate([300, 100, 300]); sound('start'); }
    if (room.status === 'lobby') showBanner('status', 'Neue Runde – zurück in der Lobby.');
    if (room.status === 'ended') sound('start');
  }
  if (prev.role === 'runner' && me.role === 'hunter' && me.caughtAt) {
    showBanner('role', 'Du wurdest gefangen – ab jetzt bist du Jäger!', { cls: 'hunter', sticky: true });
    vibrate([500]);
    sound('caught');
  } else if (prev.role && prev.role !== me.role && me.role) {
    showBanner('role', `Deine Rolle: ${ROLE_LABEL[me.role]}`, { sticky: true });
  }
  const ackAt = me.emergency?.ackAt ?? null;
  if (prev.emergencyAck === null && ackAt) {
    showBanner('sosack', 'Die Spielleitung hat deinen Notruf gesehen und kümmert sich.', { cls: 'message', sticky: true });
    vibrate([300, 100, 300]);
    sound('message');
  }
  prev = { status: room.status, role: me.role, emergencyAck: ackAt };

  // Neuer Ping
  if (S.lastPingAt && S.lastPingAt > seenPingAt) {
    const fresh = now() - S.lastPingAt < 60000;
    seenPingAt = S.lastPingAt;
    store.set('mh_seen_ping', String(seenPingAt));
    if (fresh && room.status === 'running') {
      const kind = { regular: 'Ping', extra: 'Extra-Ping', admin: 'Sofort-Ping der Spielleitung' }[S.lastPingKind] || 'Ping';
      if (me.role === 'hunter') {
        showBanner('ping', `${kind}! Die Standorte der Gejagten sind auf der Karte.`, { cls: 'hunter' });
        fitToPing();
      } else if (me.role === 'runner') {
        showBanner('ping', `${kind}! Die Jäger sehen jetzt deinen Standort.`);
      }
      vibrate([200, 100, 200]);
      sound('ping');
    }
  }

  // Nachricht der Spielleitung
  const msg = room.message;
  if (msg && store.get('mh_msg_seen') !== msg.id && !document.getElementById('banner-msg')) {
    showBanner('msg', `Spielleitung: ${msg.text}`, {
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
  $('#roomName').textContent = room.name;
  document.title = `Manhunt – ${room.name}`;
  const badge = $('#roleBadge');
  badge.className = `badge ${me.role || ''}`;
  badge.textContent = me.role ? ROLE_LABEL[me.role] : 'Keine Rolle';
  $('#meName').textContent = me.caughtAt ? `${me.name} · gefangen ${fmtTime(me.caughtAt)}` : me.name;

  renderTimers();
  renderAlerts();
  swapIfChanged($('#content'), buildContent());
  drawMap();
}

function timer(label, value) {
  return el('div', { class: 'timer' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }));
}

function renderTimers() {
  if (!S || stopped) return;
  const { room } = S;
  const t = now();
  const items = [];
  if (room.status === 'lobby') {
    items.push(timer('Status', 'Warte auf Start'));
  } else if (room.status === 'running') {
    if (t < room.huntStartsAt) items.push(timer('Vorsprung', fmtCountdown(room.huntStartsAt - t)));
    else items.push(timer('Nächster Ping', fmtCountdown(room.nextPingAt - t)));
    items.push(timer('Spielende', fmtCountdown(room.endsAt - t)));
    pingWarning(room, t);
  } else {
    items.push(el('div', { class: 'alert result', text: room.result?.reason || 'Das Spiel ist beendet.' }));
  }
  $('#timers').replaceChildren(...items);
}

// Vorwarnung kurz vor dem nächsten regulären Ping (auch vor dem ersten Ping am Ende des Vorsprungs)
function pingWarning(room, t) {
  const warnMs = (room.pingWarningSec || 0) * 1000;
  const left = room.nextPingAt - t;
  if (!warnMs || !room.nextPingAt || warnedFor === room.nextPingAt || left <= 0 || left > warnMs) return;
  warnedFor = room.nextPingAt;
  // Nicht warnen, wenn die Seite erst mitten im Warnzeitraum geöffnet wurde und kaum Zeit bleibt
  if (left < 5000) return;
  const first = room.nextPingAt === room.huntStartsAt;
  const when = fmtSeconds(Math.round(left / 1000 / 5) * 5 || 5);
  const role = S.me.role;
  const text = role === 'runner'
    ? `In ${when} kommt der ${first ? 'erste ' : ''}Ping – ab in Deckung!`
    : role === 'hunter'
      ? `In ${when} kommt der ${first ? 'erste ' : 'nächste '}Ping.`
      : `In ${when} kommt ein Ping.`;
  showBanner('warn', text, { cls: role === 'hunter' ? 'hunter' : '' });
  vibrate([100, 80, 100]);
  sound('warn');
}

function renderAlerts() {
  const { room, me } = S;
  const a = [];
  if (!online) a.push(['danger', 'Keine Verbindung zum Server – versuche es weiter …']);
  // Nach Spielende sind Standort-Hinweise nur noch Rauschen
  if (room.status === 'ended') return swapIfChanged($('#alerts'), el('div', { class: 'stack' },
    a.map(([cls, text]) => el('div', { class: `alert ${cls}`, text }))));
  if (me.outside && room.zone) a.unshift(['danger', 'Du bist außerhalb des Spielfelds! Geh sofort zurück.']);
  if (tracking && geoError) a.push(['danger', `${geoError}. Standort in den Browser-Einstellungen erlauben.`]);
  if (tracking && lastPos && lastPos.acc > 100) a.push(['', `GPS ungenau (±${lastPos.acc} m) – geh kurz ins Freie.`]);
  if (tracking && 'wakeLock' in navigator && !wakeLock) a.push(['', 'Das Display kann ausgehen – dann stoppt dein Standort. Hier tippen, damit es anbleibt.', requestWakeLock]);
  if (tracking && !('wakeLock' in navigator)) a.push(['info', 'Stell die automatische Bildschirmsperre für die Spieldauer aus.']);
  swapIfChanged($('#alerts'), el('div', { class: 'stack' },
    a.map(([cls, text, onclick]) => el('div', { class: `alert ${cls}`, text, onclick, role: onclick ? 'button' : null }))));
}

// Nur neu aufbauen, wenn sich der Inhalt geändert hat – sonst gehen Taps während des Neuaufbaus verloren.
// Während ein Knopf gedrückt gehalten wird, gar nicht neu aufbauen.
function swapIfChanged(container, fresh) {
  if (isHolding() || container.innerHTML === fresh.innerHTML) return;
  container.replaceChildren(...fresh.childNodes);
}

const telHref = (phone) => `tel:${phone.replace(/[^+0-9]/g, '')}`;

function buildContent() {
  const { room, me } = S;
  const t = now();
  const box = el('div');

  // Notruf läuft
  if (me.emergency) {
    const e = me.emergency;
    box.append(el('div', { class: 'alert danger stack' },
      el('strong', { text: `Notruf gesendet um ${fmtTime(e.at)} Uhr.` }),
      el('div', {
        text: e.ackAt
          ? `✔ Die Spielleitung hat ihn um ${fmtTime(e.ackAt)} Uhr gesehen und kümmert sich.`
          : 'Die Spielleitung ist alarmiert und sieht deinen Standort. Bleib möglichst, wo du bist.',
      }),
      room.emergencyPhone
        ? el('a', { class: 'btn danger solid big', href: telHref(room.emergencyPhone), text: `Spielleitung anrufen: ${room.emergencyPhone}` })
        : null,
      el('div', { class: 'small', text: 'Bei Lebensgefahr sofort 112 anrufen.' }),
      el('button', { class: 'btn', type: 'button', onclick: cancelSos, text: 'Entwarnung – alles in Ordnung' })));
  }

  // Nach Spielende: alle zum Treffpunkt
  if (room.status === 'ended' && room.meetingPoint) box.append(meetingBlock(room.meetingPoint, true));

  // Rollen-Hinweis
  const hint = roleHint(room, me, t);
  if (hint) box.append(el('p', { text: hint }));

  // Aktionen
  const actions = el('div', { class: 'stack' });
  if (room.status === 'running' && me.role === 'runner') {
    actions.append(el('button', { class: 'btn danger solid big', type: 'button', onclick: reportCaught, text: 'Ich wurde gefangen' }));
  }
  if (room.status === 'running' && me.role === 'hunter' && room.extraPingsLeft > 0 && t >= room.huntStartsAt) {
    actions.append(el('button', { class: 'btn primary big', type: 'button', onclick: extraPing, text: `Extra-Ping auslösen (${room.extraPingsLeft} übrig)` }));
  }
  // Mister-X-Stil: Verkehrsmittel melden
  if (room.status === 'running' && me.role === 'runner' && room.transportReports) {
    const cur = me.transport;
    actions.append(el('div', { class: 'transport-box' },
      el('div', { class: 'small', text: cur ? `Gemeldet: ${TRANSPORT_ICON[cur.mode]} ${TRANSPORT[cur.mode]} (${fmtTime(cur.at)} Uhr)` : 'Beim Einsteigen melden, womit du fährst:' }),
      el('div', { class: 'transport-buttons' }, Object.entries(TRANSPORT).map(([mode, label]) => el('button', {
        class: `btn ${cur?.mode === mode ? 'primary' : ''}`, type: 'button', onclick: () => reportTransport(mode),
        'aria-pressed': cur?.mode === mode ? 'true' : 'false',
      }, el('span', { 'aria-hidden': 'true', text: TRANSPORT_ICON[mode] }), ` ${label}`)))));
  }
  const row = el('div', { class: 'row' },
    el('button', { class: 'btn', type: 'button', onclick: centerOnMe, text: 'Auf mich zentrieren' }),
    el('button', { class: 'btn', type: 'button', onclick: showRules, text: '📋 Regeln' }),
    el('button', { class: 'btn', type: 'button', onclick: toggleSound, text: soundOn ? '🔔 Ton an' : '🔕 Ton aus' }));
  if (room.status === 'lobby') row.append(el('button', { class: 'btn', type: 'button', onclick: rename, text: 'Namen ändern' }));
  actions.append(row);
  box.append(actions);

  if (room.meetingPoint && room.status !== 'ended') box.append(meetingBlock(room.meetingPoint, false));

  // Gejagte-Übersicht
  if (room.status !== 'lobby' && S.runners.length) {
    const free = S.runners.filter((r) => !r.caughtAt).length;
    box.append(
      el('h3', { text: `Gejagte: ${free} von ${S.runners.length} noch frei` }),
      el('ul', { class: 'list' }, S.runners.map((r) => el('li', {},
        el('span', { class: r.caughtAt ? 'strike' : '', text: r.name }),
        el('span', {
          class: 'muted small',
          text: r.caughtAt ? `gefangen ${fmtTime(r.caughtAt)}`
            : r.transport ? `${TRANSPORT_ICON[r.transport.mode]} ${TRANSPORT[r.transport.mode]} seit ${fmtTime(r.transport.at)}`
              : 'frei',
        })))));
  }

  if (room.status === 'lobby' && S.lobby) {
    box.append(el('h3', { text: `Im Raum (${S.lobby.length})` }), el('p', { class: 'small muted', text: S.lobby.join(', ') }));
  }

  if (room.zone) {
    box.append(el('p', {
      class: 'small muted',
      text: room.zoneFinalRadius
        ? `Spielfeld schrumpft: jetzt ${room.zone.radius} m Radius, am Ende ${room.zoneFinalRadius} m (innerer Kreis).`
        : `Spielfeld: Kreis mit ${room.zone.radius} m Radius (gestrichelt auf der Karte).`,
    }));
  }

  if (!me.emergency) {
    box.append(el('p', { class: 'small muted' },
      'Notfall? Den roten SOS-Knopf oben rechts 1,5 Sekunden gedrückt halten.',
      room.emergencyPhone ? el('span', {}, ' Spielleitung: ', el('a', { href: telHref(room.emergencyPhone), text: room.emergencyPhone })) : null));
  }

  // Überzählige Handys (z. B. im Jäger-Team) melden sich ab – nur durch Gedrückthalten
  if (room.status === 'lobby') {
    box.append(el('div', { class: 'stack leave-box' },
      el('p', { class: 'small muted', text: 'Dieses Handy wird nicht gebraucht, weil euer Team ein anderes nutzt? Dann hier abmelden:' }),
      holdButton({
        text: 'Spiel verlassen (2 Sek. gedrückt halten)', holdText: 'Weiter halten …', cls: 'danger',
        title: 'Spiel verlassen – 2 Sekunden gedrückt halten', onConfirm: leave,
      })));
  }
  return box;
}

function meetingBlock(mp, prominent) {
  return el('div', { class: `meeting-box ${prominent ? 'prominent' : ''}` },
    el('div', {}, el('strong', { text: prominent ? 'Alle zum Treffpunkt: ' : 'Treffpunkt: ' }), mp.label),
    el('div', { class: 'row' },
      el('button', { class: 'btn sm', type: 'button', onclick: () => showMeeting(mp), text: 'Auf Karte zeigen' }),
      el('a', { class: `btn sm ${prominent ? 'primary' : ''}`, href: routeUrl(mp.lat, mp.lng), target: '_blank', rel: 'noopener', text: 'Route (Fußweg) ↗' })));
}

function roleHint(room, me, t) {
  if (room.status === 'lobby') {
    if (!me.role) return 'Die Spielleitung verteilt gleich die Rollen.';
    if (me.role === 'hunter') return 'Du bist Jäger. Pro Jäger-Team reicht ein Handy: Das Team-Handy gibt sich über „Namen ändern“ einen Teamnamen, alle anderen im Team melden sich ganz unten mit „Spiel verlassen“ ab.';
    return 'Du bist Gejagt. Halte das Handy geladen und die Seite geöffnet.';
  }
  if (room.status === 'running') {
    if (!me.role) return 'Das Spiel läuft schon – die Spielleitung gibt dir gleich eine Rolle.';
    const beforeHunt = t < room.huntStartsAt;
    if (me.role === 'runner') {
      return beforeHunt
        ? 'Lauf los! Die Jäger starten nach dem Vorsprung.'
        : `Die Jäger sehen deinen Standort bei jedem Ping (alle ${room.pingIntervalMin} min). Wenn du gefangen wirst: Knopf drücken – dann wirst du Jäger.`;
    }
    if (me.role === 'hunter') {
      if (beforeHunt) return 'Noch warten – der Vorsprung läuft.';
      return S.lastPingAt ? `Letzter Ping: ${fmtTime(S.lastPingAt)} Uhr.` : 'Gleich kommt der erste Ping.';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

async function reportCaught() {
  if (!confirm('Wurdest du wirklich gefangen? Du wirst dann zum Jäger.')) return;
  try { S = await api('POST', '/api/play/caught', undefined, auth); detectChanges(); render(); } catch (e) { alert(e.message); }
}

async function extraPing() {
  if (!confirm(`Extra-Ping auslösen? Danach sind noch ${S.room.extraPingsLeft - 1} übrig – für alle Jäger-Teams zusammen.`)) return;
  try { S = await api('POST', '/api/play/extra-ping', undefined, auth); detectChanges(); render(); } catch (e) { alert(e.message); }
}

async function rename() {
  const name = prompt('Neuer Name (z. B. Teamname):', S.me.name);
  if (!name) return;
  try { S = await api('POST', '/api/play/rename', { name }, auth); render(); } catch (e) { alert(e.message); }
}

// Abgesichert durch 2 Sekunden Gedrückthalten – daher keine zusätzliche Rückfrage
async function leave() {
  try {
    await api('POST', '/api/play/leave', undefined, auth);
    store.del('mh_token');
    showGone('Du hast das Spiel verlassen.');
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
    showBanner('sos', 'Notruf gesendet – die Spielleitung ist alarmiert.', { cls: 'hunter' });
  } catch (e) {
    const phone = S?.room.emergencyPhone;
    alert(`Notruf konnte nicht gesendet werden (${e.message}).${phone ? ` Ruf die Spielleitung an: ${phone}` : ' Ruf die Spielleitung direkt an!'} Bei Lebensgefahr: 112`);
  }
}

async function cancelSos() {
  if (!confirm('Entwarnung geben? Die Spielleitung sieht dann, dass alles in Ordnung ist.')) return;
  try { S = await api('POST', '/api/play/sos-cancel', undefined, auth); detectChanges(); render(); } catch (e) { alert(e.message); }
}

async function reportTransport(mode) {
  try { S = await api('POST', '/api/play/transport', { mode }, auth); render(); } catch (e) { alert(e.message); }
}

function showRules() {
  const ov = $('#infoOverlay');
  const close = () => ov.classList.add('hidden');
  ov.replaceChildren(el('div', { class: 'card stack' },
    el('h2', { text: 'Regeln' }),
    el('div', { class: 'rules-text', text: rulesText(S.room) }),
    el('button', { class: 'btn primary big', type: 'button', onclick: close, text: 'Verstanden' })));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.classList.remove('hidden');
}

function toggleSound() {
  soundOn = !soundOn;
  store.set('mh_sound', soundOn ? 'on' : 'off');
  if (soundOn) { unlockAudio(); playSound(SOUNDS.ping); }
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

  layers.pings.clearLayers();
  const pings = S.pings || [];
  const hunterColor = cssVar('--hunter'), runnerColor = cssVar('--runner');
  // Spur pro Gejagtem über die letzten Pings
  const trails = {};
  pings.forEach((ping, i) => {
    const latest = i === pings.length - 1;
    for (const pos of ping.positions) {
      if (pos.missing) continue;
      (trails[pos.playerId] ??= []).push([pos.lat, pos.lng]);
      labeledMarker([pos.lat, pos.lng], {
        color: runnerColor,
        radius: latest ? 9 : 5,
        fill: latest ? 0.9 : 0.35,
        label: latest ? `${pos.name} · ${fmtTime(ping.at)}` : null,
      }).addTo(layers.pings);
    }
  });
  for (const pts of Object.values(trails)) {
    if (pts.length > 1) L.polyline(pts, { color: runnerColor, weight: 2, opacity: 0.5, dashArray: '4 6' }).addTo(layers.pings);
  }

  layers.hunters.clearLayers();
  for (const h of room.status === 'running' ? S.hunters || [] : []) {
    const stale = now() - h.t > 120000;
    labeledMarker([h.lat, h.lng], { color: hunterColor, radius: 7, fill: stale ? 0.3 : 0.9, label: h.name, className: stale ? 'old' : '' })
      .addTo(layers.hunters);
  }
  drawOwn();
  initialView();
}

// Erster Kartenausschnitt: Jäger sehen den letzten Ping, sonst das Spielfeld, sonst sich selbst
function initialView() {
  if (centered || !map || !S) return;
  if (S.me.role === 'hunter' && S.pings?.length) return fitToPing();
  let fit = null;
  if (S.room.zone) {
    const z = S.room.zone;
    fit = () => { map.invalidateSize({ pan: false }); map.fitBounds(L.latLng(z.lat, z.lng).toBounds(z.radius * 2)); };
  } else if (lastPos) {
    const { lat, lng } = lastPos;
    fit = () => { map.invalidateSize({ pan: false }); map.setView([lat, lng], 16); };
  }
  if (!fit) return;
  fit();
  autoFit = fit;
  centered = true;
}

function drawOwn() {
  if (!map || !lastPos) return;
  layers.own.clearLayers();
  const color = S?.me.role === 'hunter' ? cssVar('--hunter') : S?.me.role === 'runner' ? cssVar('--runner') : '#666';
  if (lastPos.acc < 500) L.circle([lastPos.lat, lastPos.lng], { radius: lastPos.acc, color, weight: 1, fillOpacity: 0.08 }).addTo(layers.own);
  L.circleMarker([lastPos.lat, lastPos.lng], { radius: 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
    .bindTooltip('Du', { permanent: true, direction: 'right', offset: [10, 0], className: 'map-label' })
    .addTo(layers.own);
  initialView();
}

function fitToPing() {
  const latest = S?.pings?.at(-1);
  if (!map || !latest) return;
  const pts = latest.positions.filter((p) => !p.missing).map((p) => [p.lat, p.lng]);
  if (lastPos) pts.push([lastPos.lat, lastPos.lng]);
  if (!pts.length) return;
  // Leaflet merkt sich die Kartengröße – vor dem Einpassen die aktuelle Größe erzwingen
  map.invalidateSize({ pan: false });
  map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 16 });
  autoFit = fitToPing;
  centered = true;
}
