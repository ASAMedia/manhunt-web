import {
  $, api, el, store, fmtCountdown, fmtAge, fmtTime, ROLE_LABEL, STATUS_LABEL, getConfig, createMap, labeledMarker, meetingMarker,
  cssVar, holdButton, isHolding, playSound, audioReady, unlockAudio, audioIgnoresSilentSwitch, SOUNDS, routeUrl, TRANSPORT, TRANSPORT_ICON, defaultRules, rulesText,
  drawZone, zoneBounds, errorContext, declutterLabels,
} from './common.js';

errorContext.role = 'admin';
audioIgnoresSilentSwitch(); // Notfall-Alarm soll auch bei stummgeschaltetem iPhone zu hören sein

let cfg;
let R = null;             // aktueller Raum (Admin-Sicht)
let roomId = null;
let clockOffset = 0;
let pollTimer = null;
let loggedIn = false;
let role = 'admin';       // 'admin' = Spielleitung, 'supervisor' = Aufsicht (nur ansehen, Notfälle, Nachrichten)
// Konto-Art: 'admin' (alle Räume, Konten) · 'manager' (Lehrkräfte-Konto, eigene Räume) · 'supervisor' (Aufsicht-Passwort)
// · 'roomsup' (Aufsicht-Link eines Raums)
let account = { kind: 'admin', name: 'Admin' };
const isAdmin = () => role === 'admin';
const isSuper = () => account.kind === 'admin';

function applyRole(r, acc) {
  role = r || 'admin';
  account = acc || { kind: role === 'admin' ? 'admin' : 'supervisor', name: role === 'admin' ? 'Admin' : 'Aufsicht' };
  document.body.classList.toggle('role-supervisor', role === 'supervisor');
  for (const k of ['admin', 'manager', 'supervisor', 'roomsup']) document.body.classList.toggle(`kind-${k}`, account.kind === k);
  $('#whoami').textContent = account.kind === 'manager' ? account.name : '';
}

let map = null;
const layers = {};
let picking = null;       // 'zone' | 'polygon' | 'meeting' | null – was ein Klick auf die Karte setzt
let pendingZone;          // Kreis {lat,lng} | Fläche {points} | null – Spielfeld im Formular
let drawPoints = [];      // Ecken, während eine Fläche gezeichnet wird
let pendingMeeting;       // {lat,lng} | null – Treffpunkt im Formular
let settingsDirty = false;
let fitted = false;
let pendingFocus = null;  // nach Raumwechsel auf diesen Punkt zoomen (Notfall „Auf Karte“)

let alerts = { emergencies: [], warnings: [], running: 0 }; // offene Notfälle + Warnungen aller Räume
let alertTimer = null;
let lastAlarmAt = 0;
let lastWarnAt = 0;
const knownAlerts = new Set();
// Verbindung zur Alarmliste: zwei Fehlschläge in Folge oder eine hängende Abfrage = Alarme kommen nicht an
let alertFails = 0;
let alertInFlightSince = 0;
let lostSince = 0;
let wakeLock = null;
let wakeLockPending = false;

// Einsatz-Ansicht: im laufenden Spiel auf dem Handy nur Karte, Warnungen, Zähler und die wichtigsten Knöpfe
const narrow = matchMedia('(max-width: 760px)');
let viewPref = null;      // null = automatisch (Handy), sonst 'mission' | 'full'

const now = () => Date.now() + clockOffset;
const baseUrl = () => cfg.publicUrl || location.origin;
const fmtDate = (ts) => new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

// ---------------------------------------------------------------------------
// Grundgerüst
// ---------------------------------------------------------------------------

function toast(text, isError = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}

function show(view) {
  for (const v of ['loginView', 'listView', 'roomView']) $(`#${v}`).classList.toggle('hidden', v !== view);
  $('#adminWrap').classList.toggle('hidden', view === 'loginView');
}

// Nur neu aufbauen, wenn sich etwas geändert hat – sonst gehen Klicks während des Neuaufbaus verloren
function swapIfChanged(container, ...nodes) {
  const fresh = el('div', {}, ...nodes);
  if (isHolding() || container.innerHTML === fresh.innerHTML) return;
  container.replaceChildren(...fresh.childNodes);
}

async function boot() {
  cfg = await getConfig();
  $('#appFooter').textContent = `Manhunt ${cfg.version || ''}${cfg.build ? ` · Build ${cfg.build}` : ''}`;
  const s = await api('GET', '/api/admin/session');
  // Aufsicht-Link (/admin#aufsicht=<schlüssel>): dieses Gerät als Aufsicht für genau einen Raum anmelden
  const sup = location.hash.match(/^#aufsicht=([\w-]{16,})$/);
  if (sup) {
    history.replaceState(null, '', '/admin'); // Schlüssel nicht in der Adresszeile stehen lassen
    const keep = s.admin && s.role === 'admin'
      && !confirm('Du bist schon als Spielleitung angemeldet. Trotzdem mit dem Aufsicht-Link fortfahren? Du wirst dabei abgemeldet.');
    if (!keep) {
      try {
        const r = await api('POST', '/api/admin/sup-login', { token: sup[1] });
        applyRole(r.role, r.account);
        history.replaceState(null, '', `/admin#room=${r.roomId}`);
        return route();
      } catch (e) {
        showLogin();
        $('#loginErr').textContent = e.message;
        return;
      }
    }
  }
  if (s.admin) { applyRole(s.role, s.account); route(); } else showLogin();
}

function showLogin() {
  loggedIn = false;
  clearTimeout(pollTimer);
  clearTimeout(alertTimer);
  alertFails = 0;
  lostSince = 0;
  updateWakeLock();
  renderGuard();
  show('loginView');
  $('#password').focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const s = await api('POST', '/api/admin/login', { email: $('#email').value.trim() || undefined, password: $('#password').value });
    $('#password').value = '';
    applyRole(s.role, s.account);
    route();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout').catch(() => {});
  showLogin();
});

window.addEventListener('hashchange', route);

function route() {
  if (!loggedIn) {
    loggedIn = true;
    pollAlerts();
  }
  clearTimeout(pollTimer);
  const m = location.hash.match(/^#room=([\w-]+)$/);
  if (m) openRoom(m[1]);
  else openList();
}

function handleError(e) {
  if (e.status === 401) return showLogin();
  toast(e.status ? e.message : 'Keine Verbindung zum Server – bitte erneut versuchen.', true);
}

// Regelmäßige Abfragen: Funklöcher nicht jedes Mal als Meldung zeigen – dafür gibt es das Verbindungs-Banner
function handlePollError(e) {
  if (e.status) handleError(e);
}

function updateTitle() {
  const base = roomId && R ? `Spielleitung – ${R.name}` : 'Manhunt – Spielleitung';
  const sos = alerts.emergencies.some((a) => !a.ackAt);
  const warn = alerts.warnings.some((w) => !w.acked);
  document.title = sos ? `🚨 NOTFALL · ${base}` : warn ? `⚠ Warnung · ${base}` : base;
}

// ---------------------------------------------------------------------------
// Notfälle (alle Räume)
// ---------------------------------------------------------------------------

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
})]);

let alertPolling = false;
async function pollAlerts() {
  clearTimeout(alertTimer);
  if (!loggedIn || alertPolling) return;
  alertPolling = true;
  alertInFlightSince = Date.now();
  try {
    const a = await withTimeout(api('GET', '/api/admin/alerts'), 20000);
    // z. B. eine Fehlerseite des Proxys statt JSON: zählt als Fehlschlag, nicht als „keine Alarme“
    if (!Array.isArray(a?.emergencies) || !Array.isArray(a?.warnings)) throw new Error('Ungültige Antwort');
    alerts = a;
    alertFails = 0;
    renderPendingBadge();
  } catch (e) {
    if (e.status === 401) { alertPolling = false; alertInFlightSince = 0; return showLogin(); }
    alertFails++;
  }
  alertPolling = false;
  alertInFlightSince = 0;
  try {
    renderAlertBar();
    updateWakeLock();
  } finally {
    // Die Alarm-Abfrage darf nie stehen bleiben – auch nicht nach einem Fehler beim Anzeigen
    if (loggedIn) alertTimer = setTimeout(pollAlerts, alertFails ? 2000 : 4000);
  }
}

const connectionLost = () => loggedIn && (alertFails >= 2 || (alertInFlightSince && Date.now() - alertInFlightSince > 12000));

// Display anlassen, solange irgendwo ein Spiel läuft – sonst verpasst das Handy in der Tasche den Alarm
async function updateWakeLock() {
  const want = loggedIn && alerts.running > 0 && document.visibilityState === 'visible';
  if (want && !wakeLock && !wakeLockPending && 'wakeLock' in navigator) {
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!loggedIn || !(alerts.running > 0)) lock.release().catch(() => {}); // inzwischen abgemeldet oder Spiel vorbei
      else {
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; renderGuard(); });
      }
    } catch { wakeLock = null; }
    wakeLockPending = false;
  } else if (!want && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
  }
  renderGuard();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !loggedIn) return;
  // Eine Abfrage von vor dem Sperren gilt nicht als hängend – ihr bleiben ab jetzt wieder 12 s (kein Fehlalarm beim Entsperren)
  if (alertInFlightSince) alertInFlightSince = Date.now();
  pollAlerts(); // nach dem Aufwecken sofort nachsehen, nicht erst nach dem nächsten Takt
  updateWakeLock();
});
// manche Browser geben die Display-Sperre nur nach einer Berührung frei
document.addEventListener('pointerdown', () => { if (loggedIn && alerts.running > 0 && !wakeLock) updateWakeLock(); }, { capture: true });

// Absicherungs-Zeile: nur während ein Spiel läuft
function renderGuard() {
  const line = $('#guardLine');
  const lost = connectionLost();
  if (lost && !lostSince) {
    lostSince = Date.now();
    playSound(SOUNDS.warn);
    renderAlertBar();
  } else if (!lost && lostSince) {
    lostSince = 0;
    renderAlertBar();
  }
  const visible = loggedIn && alerts.running > 0;
  line.classList.toggle('hidden', !visible);
  if (!visible) return;
  const sound = audioReady();
  const display = wakeLock ? ['ok', 'bleibt an']
    : 'wakeLock' in navigator ? ['warn', 'kann ausgehen – einmal auf die Seite tippen']
      : ['warn', 'automatische Sperre des Handys ausschalten'];
  const item = (state, label, value) => el('span', { class: `guard-item ${state}` },
    el('span', { 'aria-hidden': 'true', text: state === 'ok' ? '✓' : '!' }), ` ${label}: `, el('strong', { text: value }));
  swapIfChanged(line,
    item(sound ? 'ok' : 'warn', '🔊 Alarmton', sound ? 'bereit' : 'blockiert – einmal auf die Seite tippen'),
    item(display[0], '🔆 Display', display[1]),
    el('button', { class: 'btn sm', type: 'button', onclick: testAlarm, text: 'Alarmton testen' }));
}
setInterval(renderGuard, 1000);

async function testAlarm() {
  await withTimeout(unlockAudio(), 800).catch(() => {});
  if (playSound(SOUNDS.alarm)) toast('So klingt ein Notfall. Zu leise? Lautstärke hoch, Stummschaltung aus.');
  else toast('Ton ist blockiert – Lautstärke und Stummschaltung prüfen, dann erneut tippen.', true);
  renderGuard();
}
$('#alarmTest').addEventListener('click', testAlarm);

const WARN_TEXT = { signal: 'Kein Signal', zone: 'Außerhalb des Spielfelds', join: 'Neu beigetreten', battery: 'Akku fast leer' };

function renderAlertBar() {
  const bar = $('#alertBar');
  const { emergencies } = alerts;
  const warnings = alerts.warnings.filter((w) => !w.acked); // quittierte Warnungen nur noch in der Geräte-Liste
  const unacked = emergencies.filter((a) => !a.ackAt);
  const lost = loggedIn && lostSince > 0;
  bar.classList.toggle('hidden', !emergencies.length && !warnings.length && !lost);

  // Alarmton bei neuem Notfall sofort, danach alle 10 s, bis er als „gesehen“ markiert ist.
  // Warnungen: leiserer Ton bei neuer Warnung, danach alle 30 s, bis sie quittiert sind.
  const keys = [...emergencies.map((a) => a.id), ...warnings.map((w) => `${w.playerId}.${w.type}.${w.key}`)];
  const isNew = keys.some((k) => !knownAlerts.has(k));
  for (const k of keys) knownAlerts.add(k);
  const t = Date.now();
  if (unacked.length && (isNew || t - lastAlarmAt > 10000)) {
    lastAlarmAt = t;
    playSound(SOUNDS.alarm);
  } else if (!unacked.length && warnings.length && (isNew || t - lastWarnAt > 30000)) {
    lastWarnAt = t;
    playSound(SOUNDS.warn);
  }
  updateTitle();

  // Warnungen pro Raum und Art bündeln – sonst füllen z. B. zu Spielbeginn viele „kein Signal“ den Bildschirm
  const groups = new Map();
  for (const w of warnings) {
    const k = `${w.roomId}|${w.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const warnItems = [...groups.values()].map((list) => (list.length === 1 ? warnItem(list[0]) : warnGroupItem(list)));

  swapIfChanged(bar, lost ? el('div', { class: 'alert-item sos unacked offline' },
    el('div', {},
      el('strong', { text: '📶 Keine Verbindung zum Server – Alarme kommen nicht an!' }),
      el('div', {
        class: 'small',
        text: `Seit ${fmtTime(lostSince)} Uhr. WLAN/Mobilfunk prüfen – die Seite versucht es weiter. Bis dahin Notfall-Telefon im Blick behalten; Angezeigtes kann veraltet sein.`,
      }))) : null,
  emergencies.map((a) => el('div', { class: `alert-item sos ${a.ackAt ? 'acked' : 'unacked'}` },
    el('div', {},
      el('strong', { text: `🚨 NOTFALL: ${a.name}` }),
      el('span', { text: ` · ${a.roomName} · seit ${fmtTime(a.at)} Uhr${a.receivedAt ? ` (im Funkloch ausgelöst, angekommen ${fmtTime(a.receivedAt)} Uhr)` : ''}${a.ackAt ? ` · gesehen ${fmtTime(a.ackAt)}` : ''}` }),
      el('div', {
        class: 'small',
        text: a.pos ? `Standort von ${fmtTime(a.pos.t)} Uhr, ±${a.pos.acc ?? '?'} m` : 'Kein Standort bekannt – anrufen!',
      })),
    el('div', { class: 'row' },
      a.pos ? el('button', { class: 'btn sm', type: 'button', onclick: () => focusAlert(a), text: 'Auf Karte' }) : null,
      a.pos ? el('a', { class: 'btn sm', href: routeUrl(a.pos.lat, a.pos.lng), target: '_blank', rel: 'noopener', text: 'Route ↗' }) : null,
      a.ackAt ? null : el('button', { class: 'btn sm', type: 'button', onclick: () => emergencyAction(a, { ack: true }), text: 'Gesehen' }),
      el('button', {
        class: 'btn sm', type: 'button', text: 'Erledigt',
        onclick: () => { if (confirm(`Notfall von ${a.name} als erledigt markieren?`)) emergencyAction(a, { resolve: true }); },
      })))),
  warnItems,
  // im laufenden Spiel steht das schon in der Absicherungs-Zeile darunter
  (unacked.length || warnings.length) && !audioReady() && !alerts.running
    ? el('div', { class: 'alert-item info small', text: 'Alarmton ist blockiert – einmal irgendwo auf die Seite klicken.' })
    : null);
}

function warnItem(w) {
  return el('div', { class: 'alert-item warn' },
    el('div', {},
      el('strong', { text: `⚠ ${WARN_TEXT[w.type]}: ${w.name}` }),
      el('span', { text: ` · ${w.roomName}` }),
      el('div', {
        class: 'small warn-detail', // in der Einsatz-Ansicht ausgeblendet
        text: w.type === 'signal'
          ? (w.key ? `Letztes Signal ${fmtTime(w.since)} Uhr – Display aus, Akku leer oder Funkloch?` : 'Hat seit Spielstart noch nie gesendet')
          : w.type === 'join' ? `Um ${fmtTime(w.since)} Uhr nach dem Verteilen der Rollen beigetreten und automatisch Jäger – kennst du das Gerät? Sonst entfernen.`
            : w.type === 'battery' ? `Akku ${w.battery != null ? Math.round(w.battery * 100) : '?'} % – Powerbank anschließen lassen, sonst ist das Gerät bald weg.`
            : `Seit ${fmtTime(w.since)} Uhr außerhalb`,
      })),
    el('div', { class: 'row' },
      w.pos ? el('button', { class: 'btn sm', type: 'button', onclick: () => focusAlert(w), text: 'Auf Karte' }) : null,
      el('button', { class: 'btn sm', type: 'button', onclick: () => ackWarnings([w]), text: 'OK', title: 'Quittieren – meldet sich erst wieder bei einem neuen Vorfall' })));
}

function warnGroupItem(list) {
  const { roomId: rid, roomName, type } = list[0];
  return el('div', { class: 'alert-item warn' },
    el('div', {},
      el('strong', { text: `⚠ ${WARN_TEXT[type]}: ${list.length} Geräte` }),
      el('span', { text: ` · ${roomName}` }),
      el('div', { class: 'small', text: list.map((w) => w.name).join(', ') })),
    el('div', { class: 'row' },
      rid !== roomId ? el('button', { class: 'btn sm', type: 'button', onclick: () => { location.hash = `room=${rid}`; }, text: 'Zum Raum' }) : null,
      el('button', { class: 'btn sm', type: 'button', onclick: () => ackWarnings(list), text: 'Alle OK', title: 'Alle quittieren – melden sich erst bei einem neuen Vorfall wieder' })));
}

async function ackWarnings(list) {
  bumpRoom();
  try {
    await Promise.all(list.map((w) => api('POST', `/api/admin/rooms/${w.roomId}/players/${w.playerId}/ack`, { type: w.type })));
    await pollAlerts();
    if (list.some((w) => w.roomId === roomId)) loadRoom();
  } catch (e) { handleError(e); }
}
const ackWarning = (w) => ackWarnings([w]);

async function emergencyAction(a, body) {
  bumpRoom();
  try {
    await api('PATCH', `/api/admin/rooms/${a.roomId}/emergencies/${a.id}`, body);
    await pollAlerts();
    if (roomId === a.roomId) loadRoom();
  } catch (e) { handleError(e); }
}

function focusAlert(a) {
  if (roomId === a.roomId && map) {
    map.setView([a.pos.lat, a.pos.lng], 17);
    $('#adminMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    pendingFocus = [a.pos.lat, a.pos.lng];
    location.hash = `room=${a.roomId}`;
  }
}

// ---------------------------------------------------------------------------
// Raumliste
// ---------------------------------------------------------------------------

async function openList() {
  roomId = null;
  document.body.classList.remove('mission', 'tabs');
  show('listView');
  updateTitle();
  loadSetupCheck();
  await loadList();
}

async function loadList() {
  clearTimeout(pollTimer);
  try {
    const rooms = await api('GET', '/api/admin/rooms');
    $('#noRooms').classList.toggle('hidden', rooms.length > 0);
    renderCopySelect(rooms);
    if (isSuper()) loadClientErrors();
    // Admin: alle Räume oder nur die eigenen; fremde Räume zeigen ihren Inhaber
    for (const b of document.querySelectorAll('#roomFilter [data-filter]')) b.classList.toggle('primary', b.dataset.filter === roomFilter);
    const shown = isSuper() && roomFilter === 'mine' ? rooms.filter((r) => r.own) : rooms;
    $('#noRooms').classList.toggle('hidden', shown.length > 0);
    // Raumkarten: Farbstreifen je Status (Notfall rot), große Zahlen, Hinweise als Abzeichen
    const stat = (n, label, cls = '') => el('div', { class: `room-stat ${cls}` }, el('strong', { text: String(n) }), el('span', { text: label }));
    swapIfChanged($('#roomGrid'), shown.map((r) => el('button', {
      class: `card room-card status-${r.status}${r.emergencies ? ' has-sos' : ''}`, type: 'button', onclick: () => { location.hash = `room=${r.id}`; },
    },
    el('div', { class: 'room-card-head' },
      el('strong', { class: 'room-name', text: r.name }),
      el('span', { class: `badge ${r.status === 'running' ? 'running' : ''}`, text: STATUS_LABEL[r.status] })),
    isSuper() && !r.own ? el('div', { class: 'room-owner small', text: `👤 ${r.ownerName}` }) : null,
    r.emergencies || r.warnings || r.bots || !r.joinOpen ? el('div', { class: 'row room-badges' },
      r.emergencies ? el('span', { class: 'badge danger', text: '🚨 Notfall' }) : null,
      r.warnings ? el('span', { class: 'badge warn', text: `⚠ ${r.warnings} ${r.warnings === 1 ? 'Warnung' : 'Warnungen'}` }) : null,
      r.bots ? el('span', { class: 'badge', text: 'Probespiel' }) : null,
      r.joinOpen ? null : el('span', { class: 'badge', text: 'Beitritt geschlossen' })) : null,
    el('div', { class: 'room-stats' }, stat(r.players, 'Geräte'), stat(r.runners, 'Gejagte', 'runner'), stat(r.hunters, 'Jäger', 'hunter')),
    el('div', { class: 'small muted' }, 'Code ', el('span', { class: 'code', text: r.code }), ` · erstellt ${fmtDate(r.createdAt)}`),
    r.autoDeleteAt ? el('div', { class: 'small muted', text: `Wird am ${fmtDate(r.autoDeleteAt)} automatisch gelöscht` }) : null,
    )));
  } catch (e) {
    if (e.status === 401) return showLogin();
    handlePollError(e); // nach einem Funkloch weiter abfragen
  }
  if (!roomId && loggedIn) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadList, 5000);
  }
}

// Admin: Filter „Alle Räume / Meine Räume“ (pro Gerät gemerkt)
let roomFilter = store.get('mh_room_filter') === 'mine' ? 'mine' : 'all';
for (const b of document.querySelectorAll('#roomFilter [data-filter]')) {
  b.addEventListener('click', () => { roomFilter = b.dataset.filter; store.set('mh_room_filter', roomFilter); loadList(); });
}

$('#newRoomForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const copyFrom = $('#copyFrom').value || undefined;
    const room = await api('POST', '/api/admin/rooms', { name: $('#newRoomName').value, copyFrom });
    $('#newRoomName').value = '';
    $('#copyFrom').value = '';
    location.hash = `room=${room.id}`;
  } catch (err) { handleError(err); }
});

// Auswahl „Einstellungen übernehmen von …“ – nur neu füllen, wenn sich die Räume geändert haben
function renderCopySelect(rooms) {
  const sel = $('#copyFrom');
  if (document.activeElement === sel) return;
  const current = sel.value;
  const opts = [el('option', { value: '', text: 'Neue Einstellungen' }),
    ...rooms.map((r) => el('option', { value: r.id, text: `Wie „${r.name}“` }))];
  swapIfChanged(sel, opts);
  sel.value = rooms.some((r) => r.id === current) ? current : '';
}

async function copyRoom() {
  const name = prompt('Name des neuen Raums? Spielfeld, Treffpunkt, Regeln und alle Einstellungen werden übernommen – Geräte und Verlauf nicht.', `${R.name} (Kopie)`.slice(0, 40));
  if (name === null) return;
  try {
    const room = await api('POST', '/api/admin/rooms', { name, copyFrom: roomId });
    toast(`Raum „${room.name}“ angelegt`);
    location.hash = `room=${room.id}`;
  } catch (e) { handleError(e); }
}

// ---------------------------------------------------------------------------
// Einrichtungs-Check (nur Spielleitung)
// ---------------------------------------------------------------------------

const CHECK_ICON = { ok: '✓', warn: '!', info: 'i' };

async function loadSetupCheck() {
  const box = $('#setupCheck');
  if (!isSuper()) { box.classList.add('hidden'); return; }
  let data;
  try { data = await api('GET', '/api/admin/setup-check'); } catch { return; }
  const checks = [...data.checks];
  if (!window.isSecureContext) {
    checks.unshift({ status: 'warn', title: 'Sichere Verbindung', text: 'Dieser Browser hält die Seite nicht für sicher (kein HTTPS) – Standort, App-Installation und Offline-Karte funktionieren so auf Handys nicht.' });
  }
  const skew = Math.round((data.serverTime - Date.now()) / 1000);
  if (Math.abs(skew) > 60) {
    checks.unshift({ status: 'warn', title: 'Uhrzeit', text: `Die Uhr des Servers weicht um ${Math.abs(skew)} Sekunden von diesem Gerät ab – Countdowns wirken dann verschoben. Zeitabgleich (NTP) auf dem Server prüfen.` });
  }
  const open = checks.filter((c) => c.status === 'warn').length;
  $('#setupTitle').textContent = open ? `Einrichtung: ${open} ${open === 1 ? 'Punkt' : 'Punkte'} offen` : 'Einrichtung: bereit für den Einsatz ✓';
  box.classList.remove('hidden');
  box.classList.toggle('has-warn', open > 0);
  if (open && !box.dataset.touched) box.open = true;
  $('#setupList').replaceChildren(...checks.map((c) => el('li', { class: `setup-item ${c.status}` },
    el('span', { class: 'setup-icon', 'aria-hidden': 'true', text: CHECK_ICON[c.status] }),
    el('div', {}, el('strong', { text: c.title }), el('div', { class: 'small muted', text: c.text })))));
}

$('#setupRecheck').addEventListener('click', () => loadSetupCheck());
$('#setupCheck summary').addEventListener('click', () => { $('#setupCheck').dataset.touched = '1'; });

// ---------------------------------------------------------------------------
// Fehlerberichte von Handys
// ---------------------------------------------------------------------------

async function loadClientErrors() {
  let list;
  try { list = await api('GET', '/api/admin/client-errors'); } catch { return; }
  const box = $('#clientErrors');
  box.classList.toggle('hidden', !list.length);
  const total = list.reduce((n, r) => n + r.count, 0);
  $('#clientErrorsTitle').textContent = `Fehlerberichte von Handys (${total})`;
  // aufgeklappte Details bleiben beim Aktualisieren offen
  const ul = $('#clientErrorList');
  const openKeys = new Set([...ul.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  const keyOf = (r) => `${r.message}|${r.source}|${r.line}|${r.agent}`;
  swapIfChanged(ul, list.map((r) => el('li', { class: 'stack' },
    el('div', {},
      el('strong', { text: r.message }),
      el('div', {
        class: 'small muted',
        text: [
          `${fmtTime(r.lastAt)} Uhr${r.count > 1 ? ` · ${r.count}×` : ''}`,
          r.agent, r.page, r.role && { hunter: 'Jäger', runner: 'Gejagt', lobby: 'Lobby', admin: 'Spielleitung' }[r.role],
          r.source ? `${r.source}:${r.line ?? '?'}` : null,
        ].filter(Boolean).join(' · '),
      })),
    r.stack ? el('details', { 'data-key': keyOf(r), open: openKeys.has(keyOf(r)) }, el('summary', { class: 'small', text: 'Details' }), el('pre', { class: 'small', text: r.stack })) : null)));
}

$('#clearClientErrors').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/admin/client-errors');
    loadClientErrors();
  } catch (e) { handleError(e); }
});

// ---------------------------------------------------------------------------
// Raumdetail
// ---------------------------------------------------------------------------

async function openRoom(id) {
  const switched = id !== roomId;
  roomId = id;
  if (switched) {
    R = null;
    viewPref = null;
    fitted = false;
    settingsDirty = false;
    pendingZone = undefined;
    pendingMeeting = undefined;
    setPicking(null);
  }
  show('roomView');
  if (!map) {
    map = await createMap('adminMap');
    for (const k of ['zone', 'preview', 'meeting', 'pings', 'players']) layers[k] = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
    map.on('zoomend', scheduleDeclutter);
  }
  map.invalidateSize();
  await loadRoom();
}

// Zählt Aktionen mit: Eine Abfrage, während der eine Aktion lief (z. B. Gerät entfernt), bringt einen älteren
// Stand – sie wird verworfen, sonst taucht das entfernte Gerät für ein paar Sekunden wieder auf.
let roomVersion = 0;
const bumpRoom = () => { roomVersion++; };

async function loadRoom() {
  clearTimeout(pollTimer);
  const id = roomId;
  const v = roomVersion;
  try {
    const room = await api('GET', `/api/admin/rooms/${id}`);
    if (id !== roomId) return;
    if (v === roomVersion) setRoom(room);
  } catch (e) {
    if (e.status === 404) { toast('Raum nicht gefunden', true); location.hash = ''; return; }
    if (e.status === 401) return showLogin();
    handlePollError(e);
  }
  if (roomId === id && loggedIn) {
    clearTimeout(pollTimer); // nie zwei Abfrage-Schleifen gleichzeitig
    pollTimer = setTimeout(loadRoom, 3000);
  }
}

function setRoom(room) {
  if (R && R.status !== 'running' && room.status === 'running') viewPref = null; // neue Runde: wieder automatisch
  R = room;
  clockOffset = room.serverTime - Date.now();
  renderRoom();
}

const missionActive = () => !!R && R.status === 'running' && (viewPref === 'mission' || (viewPref === null && narrow.matches));

// Reiter am Desktop: Spiel · Geräte · Einstellungen · Auswertung – die Karte bleibt rechts sichtbar.
// Am Handy (CSS) und in der Einsatz-Ansicht steht alles untereinander.
const TABS = ['spiel', 'geraete', 'einstellungen', 'auswertung'];
let roomTab = TABS.includes(store.get('mh_admin_tab')) ? store.get('mh_admin_tab') : 'spiel';
function setTab(name) {
  if (!TABS.includes(name) || (name === 'einstellungen' && !isAdmin())) name = 'spiel';
  roomTab = name;
  store.set('mh_admin_tab', name);
  for (const b of document.querySelectorAll('.room-tab')) {
    b.classList.toggle('on', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const c of document.querySelectorAll('.room-layout .col.main > [data-tab]')) c.classList.toggle('tab-on', c.dataset.tab === name);
}
for (const b of document.querySelectorAll('.room-tab')) b.addEventListener('click', () => setTab(b.dataset.tab));

function renderView() {
  const mission = missionActive();
  document.body.classList.toggle('mission', mission);
  document.body.classList.toggle('tabs', !mission);
  setTab(roomTab);
  const btn = $('#viewToggle');
  btn.classList.toggle('hidden', R?.status !== 'running');
  btn.textContent = mission ? 'Alles anzeigen' : 'Einsatz-Ansicht';
  btn.title = mission ? 'Einstellungen, Einladen, Verlauf und Auswertung wieder einblenden'
    : 'Nur Karte, Warnungen, Zähler und die wichtigsten Knöpfe – für das Handy unterwegs';
}

$('#viewToggle').addEventListener('click', () => {
  viewPref = missionActive() ? 'full' : 'mission';
  renderRoom();
  window.scrollTo({ top: 0 });
});
narrow.addEventListener('change', () => { if (R && !$('#roomView').classList.contains('hidden')) renderRoom(); });

// Aktion ausführen und Raum mit der Antwort neu zeichnen
async function act(method, path, body) {
  bumpRoom();
  try {
    const room = await api(method, `/api/admin/rooms/${roomId}${path}`, body);
    bumpRoom(); // auch Abfragen, die während der Aktion gestartet sind, verwerfen
    setRoom(room);
    return true;
  } catch (e) {
    handleError(e);
    return false;
  }
}

function renderRoom() {
  renderView();
  $('#rName').textContent = R.name;
  updateTitle();
  const st = $('#rStatus');
  st.className = `badge ${R.status === 'running' ? 'running' : ''}`;
  st.textContent = STATUS_LABEL[R.status];
  // Admin in einem fremden Raum: zeigen, wem er gehört (Alarme gehen an diese Lehrkraft, nicht an den Admin)
  const foreign = isSuper() && R.ownerId !== 'admin';
  $('#rOwner').classList.toggle('hidden', !foreign);
  $('#rOwner').textContent = foreign ? `Raum von ${R.ownerName}` : '';
  $('#rOwner').title = foreign ? 'Notfälle und Warnungen dieses Raums bekommt die Lehrkraft, nicht der Admin' : '';
  if (isSuper()) renderOwnerSelect();
  // Den Aufsicht-Link eines fremden Raums verwaltet die Lehrkraft (der Admin sieht ihn nicht)
  $('#supLinkBtn').classList.toggle('hidden', foreign);
  renderTimers();
  renderControls();
  renderInvite();
  renderPlayers();
  renderSettings();
  renderMessage();
  renderRounds();
  renderEvents();
  renderMap();
}

function renderTimers() {
  if (!R || $('#roomView').classList.contains('hidden')) return;
  const t = now();
  const items = [];
  const timer = (label, value, cls = '') => el('div', { class: `timer ${cls}` }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }));
  if (R.status === 'running') {
    if (t < R.huntStartsAt) items.push(timer('Vorsprung', fmtCountdown(R.huntStartsAt - t)));
    else items.push(timer('Nächster Ping', fmtCountdown(R.nextPingAt - t)));
    const extra = R.extraMin ? ` (${R.extraMin > 0 ? '+' : '−'}${Math.abs(R.extraMin)} min)` : '';
    items.push(timer(`Spielende${extra}`, fmtCountdown(R.endsAt - t), R.endsAt - t <= 5 * 60e3 ? 'urgent' : ''));
    const total = R.players.filter((p) => p.role === 'runner' || p.wasRunner).length;
    items.push(timer('Gejagte frei', `${R.runners} von ${total}`));
    items.push(timer('Extra-Pings übrig', String(R.extraPingsLeft)));
  }
  $('#rTimers').replaceChildren(...items);
}
setInterval(renderTimers, 1000);

let timeBusy = false; // Doppeltipp ergibt nicht +20 min
async function changeTime(minutes) {
  if (timeBusy) return;
  timeBusy = true;
  try {
    if (await act('POST', '/time', { minutes })) toast(`Spielende jetzt ${fmtTime(R.endsAt)} Uhr`);
  } finally {
    timeBusy = false;
  }
}

function renderControls() {
  const b = (text, cls, onclick) => el('button', { class: `btn ${cls}`, type: 'button', onclick, text });
  const items = [];
  const mission = missionActive();
  if (!isAdmin() && !mission) {
    items.push(el('span', { class: 'small muted', text: 'Als Aufsicht siehst du alles, bearbeitest Notfälle und sendest Nachrichten. Starten, Einstellen und Löschen macht die Spielleitung.' }));
  } else if (R.status === 'lobby') {
    items.push(b('Spiel starten', 'primary', () => {
      const open = R.joinOpen ? '\n\nHinweis: Der Beitritt ist noch offen – wer jetzt noch mit dem Code beitritt, wird automatisch Jäger. Im Zweifel vorher „Beitritt schließen“.' : '';
      if (confirm(`Spiel jetzt starten? Alle Handys bekommen sofort Bescheid.${open}`)) act('POST', '/start');
    }));
  }
  if (isAdmin() && R.status === 'running') {
    items.push(b('Sofort-Ping', 'primary', () => {
      if (confirm('Jetzt einen Ping an alle Jäger senden? (zählt nicht als Extra-Ping)')) act('POST', '/ping');
    }));
    // Spielzeit dieser Runde ändern – alle Handys bekommen Bescheid
    items.push(el('span', { class: 'time-btns' },
      el('button', { class: 'btn', type: 'button', title: 'Spielzeit um 10 Minuten verlängern', onclick: () => changeTime(10), text: '+10 min' }),
      el('button', {
        class: 'btn', type: 'button', title: 'Spielzeit um 10 Minuten verkürzen', text: '−10 min',
        onclick: () => { if (confirm('Spielzeit um 10 Minuten verkürzen? Alle Handys bekommen Bescheid.')) changeTime(-10); },
      })));
  }
  // Einsatz-Ansicht: „Alle zum Treffpunkt“ direkt erreichbar (auch für die Aufsicht)
  if (mission && R.settings.meetingPoint) items.push(b('Alle zum Treffpunkt', '', callMeeting));
  if (isAdmin() && R.status === 'running') {
    items.push(b('Spiel beenden', 'danger', () => {
      if (confirm('Spiel wirklich beenden?')) act('POST', '/end');
    }));
  }
  if (isAdmin() && R.status === 'ended') {
    items.push(b('Neue Runde (zurück zur Lobby)', 'primary', () => act('POST', '/lobby')));
  }
  if (isAdmin() && !mission) items.push(b('Raum kopieren', '', copyRoom));
  // Löschen nur durch Gedrückthalten, damit es nicht aus Versehen passiert
  if (isAdmin() && !mission) items.push(holdButton({
    text: 'Raum löschen (gedrückt halten)', cls: 'danger', title: 'Raum mit allen Daten löschen – 2 Sekunden gedrückt halten',
    onConfirm: async () => {
      try {
        await api('DELETE', `/api/admin/rooms/${roomId}`);
        toast(`Raum „${R.name}“ gelöscht`);
        location.hash = '';
      } catch (e) { handleError(e); }
    },
  }));
  swapIfChanged($('#controls'), items);

  let result = null;
  if (R.status === 'ended' && R.result) result = el('div', { class: 'alert result', text: R.result.reason });
  else if (R.status === 'lobby' && isAdmin()) result = el('p', { class: 'small muted', text: 'Geräte beitreten lassen, Rollen setzen oder auslosen, Spielfeld und Treffpunkt festlegen – dann starten.' });
  swapIfChanged($('#result'), result);

  $('#autoDel').textContent = R.autoDeleteAt
    ? `Wird am ${fmtDate(R.autoDeleteAt)} automatisch gelöscht (${cfg.autoDeleteDays} Tage nach der letzten Aktivität).`
    : cfg.autoDeleteDays && R.status === 'running' ? 'Laufende Spiele werden nicht automatisch gelöscht.' : '';
}

let lastQrUrl = '';
function renderInvite() {
  const url = `${baseUrl()}/j/${R.code}`;
  $('#rCode').textContent = R.code;
  $('#joinUrl').textContent = url;
  if (url !== lastQrUrl) {
    lastQrUrl = url;
    $('#qr').src = qrSrc(url);
  }
  $('#joinToggle').textContent = R.joinOpen ? 'Beitritt schließen' : 'Beitritt öffnen';

  const u = new URL(baseUrl());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  let warn = null;
  if (local) warn = 'Du bist über localhost verbunden – dieser QR-Code funktioniert nicht auf Handys. Öffne die Spielleitung über die öffentliche https://-Adresse (Tunnel/Domain).';
  else if (u.protocol !== 'https:') warn = 'Achtung: Ohne https:// können die Handys ihren Standort nicht senden.';
  $('#urlWarn').replaceChildren(...(warn ? [el('div', { class: 'alert', text: warn })] : []));
}

$('#copyUrl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#joinUrl').textContent); toast('Link kopiert'); } catch { toast('Kopieren nicht möglich', true); }
});
$('#joinToggle').addEventListener('click', () => act('PATCH', '', { joinOpen: !R.joinOpen }));
$('#renameRoom').addEventListener('click', () => {
  const name = prompt('Neuer Raumname:', R.name);
  if (name) act('PATCH', '', { name });
});

const closeOverlay = () => $('#overlay').classList.add('hidden');

function openOverlay(card) {
  const ov = $('#overlay');
  ov.replaceChildren(card);
  ov.onclick = (e) => { if (e.target === ov) closeOverlay(); };
  ov.classList.remove('hidden');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });

const qrSrc = (url) => `/api/admin/qr.svg?text=${encodeURIComponent(url)}`;

// QR für Links mit Zugangsschlüssel: per POST holen, damit der Schlüssel nicht in Adressen, Verlauf oder Cache landet
async function secretQr(url) {
  const res = await fetch('/api/admin/qr', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-Requested-With': 'manhunt', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: url }),
  });
  if (!res.ok) throw Object.assign(new Error('QR-Code konnte nicht erzeugt werden'), { status: res.status });
  return URL.createObjectURL(await res.blob());
}

function showJoinQr() {
  const url = `${baseUrl()}/j/${R.code}`;
  openOverlay(el('div', { class: 'card stack qr-full' },
    el('h2', { text: R.name }),
    el('img', { src: qrSrc(url), alt: 'QR-Code zum Beitreten' }),
    el('div', {}, 'Code ', el('span', { class: 'big-code', text: R.code })),
    el('p', { class: 'muted', text: 'QR-Code scannen oder Code auf der Startseite eingeben, Namen eingeben, fertig.' }),
    el('div', { class: 'join-url', text: url }),
    el('button', { class: 'btn primary', type: 'button', onclick: closeOverlay, text: 'Schließen' })));
}
$('#qrFull').addEventListener('click', showJoinQr);
$('#qr').addEventListener('click', showJoinQr);

// --- Geräte-Tabelle ---------------------------------------------------------

const ROLE_ORDER = { runner: 0, hunter: 1, null: 2 };

let touchingPlayers = false;
$('#pBody').addEventListener('pointerdown', () => { touchingPlayers = true; });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('#pBody').addEventListener(ev, () => { setTimeout(() => { touchingPlayers = false; }, 300); });
}

// „Alle Geräte entfernen“: Knopf nur einmal bauen (sonst würde ein Neuaufbau das Gedrückthalten abbrechen)
$('#removeAllBox').prepend(holdButton({
  text: 'Alle Geräte entfernen (3 s gedrückt halten)', holdText: 'Weiter halten … alle werden entfernt', ms: 3000, cls: 'danger',
  title: 'Alle Handys aus dem Raum entfernen – 3 Sekunden gedrückt halten',
  onConfirm: async () => {
    const n = R?.players.length || 0;
    if (await act('DELETE', '/players')) toast(`${n} ${n === 1 ? 'Gerät' : 'Geräte'} entfernt`);
  },
}));

// „Auswertung zurücksetzen“: ebenfalls nur einmal bauen, 3 Sekunden halten
$('#resetEvalBox').prepend(holdButton({
  text: 'Auswertung zurücksetzen (3 s gedrückt halten)', holdText: 'Weiter halten … Auswertung wird gelöscht', ms: 3000, cls: 'danger',
  title: 'Auswertung aller Runden und Ping-Replay löschen – 3 Sekunden gedrückt halten',
  onConfirm: async () => {
    const n = R?.rounds.length || 0;
    if (await act('DELETE', '/rounds')) toast(n ? `Auswertung zurückgesetzt (${n} ${n === 1 ? 'Runde' : 'Runden'} gelöscht)` : 'Ping-Replay gelöscht');
  },
}));

function renderPlayers() {
  // nicht im laufenden Spiel und nur, wenn es etwas zu entfernen gibt
  $('#removeAllBox').classList.toggle('hidden', !isAdmin() || R.status === 'running' || !R.players.length);
  // Einsatz-Ansicht: Geräte mit Problemen (Warnung, außerhalb, kein Signal) gleich nach den Notfällen
  const t0 = now();
  const trouble = (p) => (missionActive()
    ? Number(p.warnings?.some((w) => !w.acked || w.type !== 'join') || p.outside || !p.lastSeen || t0 - p.lastSeen > 60000) : 0);
  const players = [...R.players].sort((a, b) => (b.emergency - a.emergency) || (trouble(b) - trouble(a))
    || (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.name.localeCompare(b.name, 'de'));
  $('#pTitle').textContent = `Geräte (${players.length})`;
  const tabCount = $('#tabCountPlayers');
  const problems = players.filter((p) => ampel(p, now())[0] === 'amber').length;
  tabCount.textContent = players.some((p) => p.emergency) ? `${players.length} · 🚨` : problems ? `${players.length} · ⚠ ${problems}` : String(players.length);
  tabCount.className = `tab-count${players.some((p) => p.emergency) ? ' danger' : problems ? ' warn' : ''}`;
  $('#drawN').max = Math.max(1, players.length - 1);
  $('#drawForm').classList.toggle('hidden', R.status !== 'lobby');
  // Nicht neu zeichnen, während eine Rollen-Auswahl offen ist oder gerade jemand auf die Liste tippt –
  // sonst geht der Tipp auf „⋯“ oder „Gefangen“ verloren, weil der Knopf mitten im Tippen ersetzt wird
  if ($('#pBody').contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  if (touchingPlayers) return;
  const t = now();
  $('#pBody').replaceChildren(...players.map((p) => playerRow(p, t)));
  if (!players.length) $('#pBody').append(el('tr', {}, el('td', { colspan: 5, class: 'muted', text: 'Noch niemand beigetreten.' })));
}

const markCaught = (p) => {
  if (confirm(`${p.name} als gefangen markieren? (wird dann Jäger)`)) act('PATCH', `/players/${p.id}`, { caught: true });
};
const releaseCaught = (p) => act('PATCH', `/players/${p.id}`, { caught: false });

function playerRow(p, t) {
  const stale = !p.lastSeen || t - p.lastSeen > 60000;
  const running = R.status === 'running';

  const roleSel = el('select', {
    'aria-label': `Rolle von ${p.name}`,
    onchange: (e) => {
      e.target.blur(); // sonst bleibt die Tabelle eingefroren (siehe renderPlayers)
      act('PATCH', `/players/${p.id}`, { role: e.target.value || null });
    },
  },
  running && p.role ? null : el('option', { value: '', text: '– keine –' }),
  el('option', { value: 'runner', text: ROLE_LABEL.runner }),
  el('option', { value: 'hunter', text: ROLE_LABEL.hunter }));
  roleSel.value = p.role || '';
  // Aufsicht sieht die Rolle nur als Text
  const roleCell = isAdmin() ? roleSel : el('span', { class: `badge ${p.role || ''}`, text: p.role ? ROLE_LABEL[p.role] : '–' });

  const status = [];
  if (p.emergency) status.push(el('span', { class: 'badge danger', text: '🚨 NOTFALL' }));
  if (p.bot) status.push(el('span', { class: 'badge', text: 'Test' }));
  if (p.caughtAt) status.push(el('span', { class: 'badge caught', text: `gefangen ${fmtTime(p.caughtAt)}` }));
  else if (running && p.role === 'runner') status.push(el('span', { class: 'badge runner', text: 'frei' }));
  if (running && p.role === 'runner' && p.transport) {
    status.push(el('span', { class: 'badge', text: `${TRANSPORT_ICON[p.transport.mode]} ${TRANSPORT[p.transport.mode]} ${fmtTime(p.transport.at)}` }));
  }
  if (p.outside && R.status === 'running') status.push(el('span', { class: 'badge danger', text: 'außerhalb' }));
  if (p.warnings?.some((w) => w.type === 'signal')) status.push(el('span', { class: 'badge warn', text: '⚠ kein Signal' }));
  if (p.warnings?.some((w) => w.type === 'join' && !w.acked)) status.push(el('span', { class: 'badge warn', text: '⚠ neu' }));
  if (p.geoError) status.push(el('span', { class: 'badge warn', text: p.geoError }));
  if (p.blockArmed) status.push(el('span', { class: 'badge', text: '🛡 blockt nächsten Ping' }));
  // Handy-Check: in der Lobby immer, im Spiel nur wenn etwas fehlt
  if (p.check && !p.bot && (R.status === 'lobby' || !checkOk(p.check))) status.push(checkBadge(p.check));
  else if (!p.check && !p.bot && R.status === 'lobby') status.push(el('span', { class: 'badge', text: 'Check offen' }));

  const btn = (text, onclick, title) => el('button', { class: 'btn sm', type: 'button', onclick, text, title });
  const actions = [];
  if (isAdmin() && running && p.role === 'runner') actions.push(btn('Gefangen', () => markCaught(p)));
  if (isAdmin() && running && p.caughtAt) actions.push(btn('Zurück', () => releaseCaught(p), 'Zurück zu Gejagt'));
  actions.push(btn('⋯', () => showPlayerDialog(p.id), 'Weitere Aktionen'));

  const [level, why] = ampel(p, t);
  return el('tr', { class: stale ? 'stale' : '' },
    el('td', { class: 'name', title: `${p.name} – ${why}` }, el('span', { class: `dot ${level}`, role: 'img', 'aria-label': why }), el('strong', { text: p.name })),
    el('td', { class: 'role' }, roleCell),
    el('td', { class: 'status' }, el('div', { class: 'row' }, status)),
    el('td', { class: 'seen small' },
      el('div', { class: 'age', text: signalText(p, t) }),
      el('div', { class: 'batt' }, batteryIcon(p), batteryText(p).replace('Akku ', ''))),
    el('td', { class: 'actions' }, actions));
}

const checkOk = (c) => (c.gps === 'ok' || c.gps === 'weak') && c.wakeLock === 'ok' && c.sound === 'ok';

function checkSummary(c) {
  return [
    `Standort: ${{ ok: 'genau', weak: 'ungenau', fail: 'geht nicht' }[c.gps] || '?'}`,
    `Display an: ${{ ok: 'ja', fail: 'nicht sicher', unsupported: 'nicht unterstützt' }[c.wakeLock] || '?'}`,
    `Ton: ${{ ok: 'gehört', fail: 'nicht gehört', untested: 'nicht getestet' }[c.sound] || '?'}`,
    `Akku: ${c.battery == null ? '?' : `${Math.round(c.battery * 100)} %`}`,
    `Gerät: ${{ ios: 'iPhone', android: 'Android', other: 'anderes' }[c.platform] || '?'}${c.installed ? ' (als App)' : ''}`,
  ].join(' · ');
}

const checkBadge = (c) => el('span', {
  class: `badge ${checkOk(c) ? 'running' : 'warn'}`, text: checkOk(c) ? 'Check ✓' : 'Check ⚠', title: checkSummary(c),
});

function signalText(p, t) {
  if (!p.lastSeen) return 'noch nie';
  return `${fmtAge(t - p.lastSeen).replace('vor ', '')}${p.pos?.acc != null ? ` · ±${p.pos.acc} m` : ''}`;
}

const batteryText = (p) => (p.battery != null ? `Akku ${Math.round(p.battery * 100)} %${p.charging ? ' ⚡' : ''}` : 'Akku –');

// Akku als Symbol: Füllstand grün, unter 30 % gelb, unter 15 % rot (iPhones melden keinen Akkustand)
function batteryIcon(p) {
  if (p.battery == null) return null;
  const pct = Math.round(p.battery * 100);
  const icon = el('span', { class: `batt-icon${pct < 15 ? ' low' : pct < 30 ? ' mid' : ''}`, 'aria-hidden': 'true' }, el('span'));
  icon.style.setProperty('--lvl', String(Math.max(0.04, p.battery)));
  return icon;
}

// Ampel je Gerät: rot = Notfall, gelb = Warnung/kein Signal/außerhalb/Problem, grün = alles gut, grau = noch nie gesendet
function ampel(p, t) {
  if (p.emergency) return ['red', 'Notfall'];
  const running = R.status === 'running';
  if (p.warnings?.some((w) => w.type !== 'join' || !w.acked)) return ['amber', 'Warnung offen'];
  if (!p.lastSeen) return running ? ['amber', 'hat noch nie gesendet'] : ['grey', 'noch kein Signal'];
  if (running && p.outside) return ['amber', 'außerhalb des Spielfelds'];
  if (p.geoError) return ['amber', p.geoError];
  if (t - p.lastSeen > 60000) return ['amber', 'kein aktuelles Signal'];
  if (R.status === 'lobby' && !p.bot && p.check && !checkOk(p.check)) return ['amber', 'Handy-Check unvollständig'];
  return ['green', 'alles in Ordnung'];
}

// Geräte-Menü: seltenere Aktionen, damit die Tabelle schmal bleibt
function showPlayerDialog(pid) {
  const p = R.players.find((x) => x.id === pid);
  if (!p) return;
  const t = now();
  const running = R.status === 'running';
  // Den Wiederbeitritts-Link (= Zugang als dieses Gerät) bekommt nur die Spielleitung, nicht die Aufsicht
  const rejoinImg = p.rejoinPath ? el('img', { alt: `Wiederbeitritts-QR für ${p.name}` }) : null;
  const qrBox = el('div', { class: 'dialog-qr stack hidden' },
    rejoinImg,
    el('p', { class: 'small muted', text: `Nur für ${p.name}! Mit diesem Code spielt ein anderes Handy als dieses Gerät weiter, z. B. nach leerem Akku.` }));
  const b = (text, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', onclick, text });
  const status = p.emergency ? 'NOTFALL gemeldet'
    : p.caughtAt ? `gefangen um ${fmtTime(p.caughtAt)}` : p.outside ? 'außerhalb des Spielfelds' : 'im Spiel';
  const transport = p.transport ? `${TRANSPORT_ICON[p.transport.mode]} ${TRANSPORT[p.transport.mode]} seit ${fmtTime(p.transport.at)} Uhr` : null;

  openOverlay(el('div', { class: 'card stack' },
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h2', { style: 'margin:0', text: p.name }),
      el('span', { class: `badge ${p.role || ''}`, text: p.role ? ROLE_LABEL[p.role] : 'keine Rolle' })),
    el('dl', { class: 'player-info' },
      el('dt', { text: 'Status' }), el('dd', { text: status }),
      el('dt', { text: 'Letztes Signal' }), el('dd', { text: signalText(p, t) }),
      el('dt', { text: 'Akku' }), el('dd', { text: batteryText(p).replace('Akku ', '') }),
      el('dt', { text: 'Beigetreten' }), el('dd', { text: `${fmtTime(p.joinedAt)} Uhr${p.bot ? ' (Test-Gerät)' : ''}` }),
      transport ? el('dt', { text: 'Verkehrsmittel' }) : null, transport ? el('dd', { text: transport }) : null,
      p.wasRunner || p.role === 'runner' ? el('dt', { text: 'Blocks' }) : null,
      p.wasRunner || p.role === 'runner'
        ? el('dd', { text: `${p.blocksUsed} von ${R.settings.blocksPerRunner} eingesetzt${p.blockArmed ? ' – nächster Ping blockiert' : ''}` })
        : null,
      p.bot ? null : el('dt', { text: 'Handy-Check' }),
      p.bot ? null : el('dd', { text: p.check ? `${checkOk(p.check) ? '✓' : '⚠'} ${checkSummary(p.check)}` : 'noch nicht gemacht' }),
      p.geoError ? el('dt', { text: 'Problem' }) : null, p.geoError ? el('dd', { text: p.geoError }) : null),
    el('div', { class: 'dialog-actions' },
      p.pos ? b('Auf Karte zeigen', () => {
        closeOverlay();
        map.setView([p.pos.lat, p.pos.lng], 17);
        $('#adminMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }) : null,
      p.pos ? el('a', { class: 'btn', href: routeUrl(p.pos.lat, p.pos.lng), target: '_blank', rel: 'noopener', text: 'Route ↗' }) : null,
      p.rejoinPath ? b('Wiederbeitritts-QR', () => {
        qrBox.classList.toggle('hidden');
        if (!rejoinImg.src) secretQr(baseUrl() + p.rejoinPath).then((src) => { rejoinImg.src = src; }).catch(handleError);
      }) : null,
      p.bot && p.rejoinPath ? el('a', { class: 'btn', href: p.rejoinPath, target: '_blank', rel: 'noopener', text: 'Als dieses Gerät ansehen ↗' }) : null,
      ...(p.warnings || []).filter((w) => !w.acked).map((w) => b(`${WARN_TEXT[w.type]} quittieren`, async () => {
        await ackWarning({ roomId, playerId: p.id, type: w.type });
        closeOverlay();
      })),
      isAdmin() ? b('Umbenennen', () => {
        const name = prompt('Neuer Name:', p.name);
        if (name) { closeOverlay(); act('PATCH', `/players/${p.id}`, { name }); }
      }) : null,
      isAdmin() && running && p.role === 'runner' ? b('Als gefangen markieren', () => { closeOverlay(); markCaught(p); }) : null,
      isAdmin() && running && p.caughtAt ? b('Zurück zu Gejagt', () => { closeOverlay(); releaseCaught(p); }) : null),
    qrBox,
    // Entfernen nur durch Gedrückthalten, damit es nicht aus Versehen passiert
    isAdmin() ? holdButton({
      text: 'Aus dem Raum entfernen (gedrückt halten)', cls: 'danger',
      title: `${p.name} entfernen – 2 Sekunden gedrückt halten`,
      onConfirm: () => { closeOverlay(); act('DELETE', `/players/${p.id}`); },
    }) : null,
    el('button', { class: 'btn primary', type: 'button', onclick: closeOverlay, text: 'Schließen' })));
}

$('#drawForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number($('#drawN').value);
  const assigned = R.players.some((p) => p.role);
  if (assigned && !confirm('Rollen neu auslosen? Bisherige Rollen werden überschrieben.')) return;
  act('POST', '/draw', { runners: n });
});

// --- Einstellungen ------------------------------------------------------------

const form = $('#settingsForm');

function renderSettings() {
  if (settingsDirty) return;
  const s = R.settings;
  form.pingIntervalMin.value = s.pingIntervalMin;
  form.durationMin.value = s.durationMin;
  form.headStartMin.value = s.headStartMin;
  form.extraPings.value = s.extraPings;
  form.radius.value = s.zone?.radius ?? 1500;
  form.zoneType.value = s.zone?.points ? 'polygon' : 'circle';
  form.emergencyPhone.value = s.emergencyPhone || '';
  form.meetingLabel.value = s.meetingPoint?.label ?? '';
  form.pingWarningSec.value = s.pingWarningSec;
  form.signalAlarmMin.value = s.signalAlarmMin;
  form.transportReports.checked = !!s.transportReports;
  form.shrinkEnabled.checked = !!s.shrinkEnabled;
  form.shrinkFinalRadius.value = s.shrinkFinalRadius;
  form.rules.value = s.rules || '';
  form.blocksPerRunner.value = s.blocksPerRunner ?? 1;
  pendingZone = !s.zone ? null : s.zone.points ? { points: s.zone.points.map((p) => [...p]) } : { lat: s.zone.lat, lng: s.zone.lng };
  drawPoints = [];
  if (picking === 'polygon') picking = null;
  pendingMeeting = s.meetingPoint ? { lat: s.meetingPoint.lat, lng: s.meetingPoint.lng } : null;
  $('#setMsg').textContent = '';
  renderPointInfo();
}

function markDirty() {
  settingsDirty = true;
  $('#setMsg').textContent = 'Nicht gespeichert';
  renderPointInfo();
  renderMap();
}

const isPolygon = () => form.zoneType.value === 'polygon';

function renderPointInfo() {
  const fmt = (p) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  $('#zoneInfo').textContent = picking === 'polygon'
    ? `${drawPoints.length} ${drawPoints.length === 1 ? 'Ecke' : 'Ecken'} – weiter auf die Karte klicken, dann „Fläche fertig“ (oder die erste Ecke antippen)`
    : pendingZone?.points ? `Fläche mit ${pendingZone.points.length} Ecken`
      : pendingZone ? `Kreis, Mitte ${fmt(pendingZone)}` : 'Kein Spielfeld festgelegt';
  const polygon = isPolygon();
  form.radius.disabled = polygon;
  form.radius.closest('label').classList.toggle('hidden', polygon);
  $('#shrinkUnit').textContent = polygon ? 'm (Mitte bis äußerste Ecke)' : 'm Radius';
  $('#zonePick').textContent = picking === 'zone' ? 'Jetzt auf die Karte klicken …'
    : picking === 'polygon' ? 'Zeichnen abbrechen'
      : polygon ? (pendingZone?.points ? 'Fläche neu zeichnen' : 'Fläche auf Karte zeichnen') : 'Spielfeld-Mitte auf Karte wählen';
  $('#zoneUndo').classList.toggle('hidden', picking !== 'polygon');
  $('#zoneDone').classList.toggle('hidden', picking !== 'polygon');
  $('#zoneUndo').disabled = !drawPoints.length;
  $('#zoneDone').disabled = drawPoints.length < 3;
  $('#meetingInfo').textContent = pendingMeeting ? `Punkt ${fmt(pendingMeeting)}` : 'Kein Treffpunkt festgelegt';
}

form.addEventListener('input', markDirty);

function setPicking(target) {
  picking = target;
  if (target === 'polygon') drawPoints = [];
  renderPointInfo();
  $('#meetingPick').textContent = target === 'meeting' ? 'Jetzt auf die Karte klicken …' : 'Treffpunkt auf Karte wählen';
  $('#adminMap').classList.toggle('picking', !!target);
  if (target) $('#adminMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#zonePick').addEventListener('click', () => {
  if (picking === 'zone' || picking === 'polygon') {
    drawPoints = [];
    setPicking(null);
  } else {
    setPicking(isPolygon() ? 'polygon' : 'zone');
  }
  renderMap();
});
$('#zoneClear').addEventListener('click', () => { pendingZone = null; drawPoints = []; setPicking(null); markDirty(); });
$('#zoneUndo').addEventListener('click', () => { drawPoints.pop(); markDirty(); });
$('#zoneDone').addEventListener('click', finishPolygon);

function finishPolygon() {
  if (drawPoints.length < 3) return;
  pendingZone = { points: drawPoints };
  drawPoints = [];
  setPicking(null);
  markDirty();
}

// Form wechseln: aus einer gespeicherten Fläche wird ein Kreis um dieselbe Mitte; eine Fläche muss man zeichnen
for (const radio of form.zoneType) {
  radio.addEventListener('change', () => {
    if (picking === 'zone' || picking === 'polygon') setPicking(null);
    drawPoints = [];
    if (isPolygon() && pendingZone && !pendingZone.points) pendingZone = null;
    if (!isPolygon() && pendingZone?.points) {
      const c = R.settings.zone?.points ? R.settings.zone : null;
      pendingZone = c ? { lat: c.lat, lng: c.lng } : null;
      if (c) form.radius.value = c.radius;
    }
    markDirty();
  });
}
$('#meetingPick').addEventListener('click', () => setPicking(picking === 'meeting' ? null : 'meeting'));
$('#meetingClear').addEventListener('click', () => { pendingMeeting = null; setPicking(null); markDirty(); });

function onMapClick(e) {
  if (!picking) return;
  const point = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
  if (picking === 'polygon') {
    drawPoints.push([point.lat, point.lng]);
    markDirty();
    return;
  }
  if (picking === 'zone') {
    pendingZone = point;
    if (!form.radius.value) form.radius.value = 1500;
  } else {
    pendingMeeting = point;
    if (!form.meetingLabel.value) form.meetingLabel.focus();
  }
  setPicking(null);
  markDirty();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (picking === 'polygon') {
    if (drawPoints.length < 3) return toast('Die Fläche braucht mindestens 3 Ecken – weiter zeichnen oder abbrechen.', true);
    finishPolygon();
  }
  const settings = {
    pingIntervalMin: Number(form.pingIntervalMin.value),
    durationMin: Number(form.durationMin.value),
    headStartMin: Number(form.headStartMin.value),
    extraPings: Number(form.extraPings.value),
    emergencyPhone: form.emergencyPhone.value,
    zone: !pendingZone ? null : pendingZone.points ? { points: pendingZone.points } : { ...pendingZone, radius: Number(form.radius.value) || 1500 },
    meetingPoint: pendingMeeting ? { ...pendingMeeting, label: form.meetingLabel.value } : null,
    pingWarningSec: Number(form.pingWarningSec.value),
    signalAlarmMin: Number(form.signalAlarmMin.value),
    transportReports: form.transportReports.checked,
    shrinkEnabled: form.shrinkEnabled.checked,
    shrinkFinalRadius: Number(form.shrinkFinalRadius.value) || 400,
    rules: form.rules.value,
    blocksPerRunner: Number(form.blocksPerRunner.value),
  };
  settingsDirty = false;
  if (await act('PATCH', '', { settings })) toast('Einstellungen gespeichert');
  else settingsDirty = true;
});

// Einstellungen so, wie sie gerade im Formular stehen (für Regel-Vorschau und Standardtext)
function formSettings() {
  return {
    pingIntervalMin: Number(form.pingIntervalMin.value), durationMin: Number(form.durationMin.value),
    headStartMin: Number(form.headStartMin.value), pingWarningSec: Number(form.pingWarningSec.value),
    zone: pendingZone || null, shrinkEnabled: form.shrinkEnabled.checked, transportReports: form.transportReports.checked,
    blocksPerRunner: Number(form.blocksPerRunner.value),
    emergencyPhone: form.emergencyPhone.value.trim(),
    meetingPoint: pendingMeeting ? { label: form.meetingLabel.value || 'Treffpunkt' } : null,
    rules: form.rules.value,
  };
}

$('#rulesDefault').addEventListener('click', () => {
  if (form.rules.value.trim() && !confirm('Den bisherigen Regeltext durch die Standardregeln ersetzen?')) return;
  form.rules.value = defaultRules(formSettings());
  markDirty();
});

$('#rulesPreview').addEventListener('click', () => {
  openOverlay(el('div', { class: 'card stack' },
    el('h2', { text: 'Regeln – so sehen es die Spieler' }),
    el('div', { class: 'rules-text', text: rulesText(formSettings()) }),
    el('button', { class: 'btn primary', type: 'button', onclick: closeOverlay, text: 'Schließen' })));
});

// --- Probespiel, Druckblatt, Auswertung --------------------------------------

$('#addBots').addEventListener('click', async () => {
  if (await act('POST', '/bots', { runners: 3, hunters: 2 })) toast('Test-Geräte hinzugefügt – sie bewegen sich alle 3 Sekunden');
});
$('#removeBots').addEventListener('click', () => act('DELETE', '/bots'));
$('#printSheet').addEventListener('click', () => window.open(`/print#${roomId}`, '_blank'));
$('#printCards').addEventListener('click', () => window.open(`/notfallkarten#${roomId}`, '_blank'));
$('#replayBtn').addEventListener('click', () => window.open(`/replay#${roomId}`, '_blank'));

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

let roundsKey = '';
function renderRounds() {
  // Zurücksetzen nur durch die Spielleitung, nicht im laufenden Spiel und nur, wenn es etwas zu löschen gibt
  $('#resetEvalBox').classList.toggle('hidden', !isAdmin() || R.status === 'running' || (!R.rounds.length && !R.replayPings));
  $('#replayBtn').disabled = !R.replayPings || R.status === 'running';
  $('#replayBtn').title = R.status === 'running' ? 'Das Replay gibt es erst nach Spielende'
    : R.replayPings ? 'Alle Pings der letzten Runde als Zeitraffer – z. B. für den Beamer (bis zum Start der nächsten Runde)'
      : 'Sobald es in einer Runde Pings gab, lassen sie sich hier nach Spielende als Zeitraffer abspielen';
  $('#csvRounds').href = `/api/admin/rooms/${roomId}/export/auswertung.csv`;
  $('#csvEvents').href = `/api/admin/rooms/${roomId}/export/verlauf.csv`;
  // Nur bei neuen Runden neu aufbauen, sonst klappen geöffnete Runden bei jeder Abfrage wieder zu
  const key = `${roomId}:${R.rounds.map((r) => r.endedAt).join(',')}`;
  if (key === roundsKey) return;
  roundsKey = key;
  const rounds = [...R.rounds].reverse();
  $('#rounds').replaceChildren(...(rounds.length
    ? rounds.map((r) => el('details', { class: 'round' },
      el('summary', {},
        el('strong', { text: `Runde ${r.no}` }),
        ` · ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)} Uhr · `,
        el('span', { text: r.winner === 'hunters' ? 'Jäger gewinnen' : r.winner === 'runners' ? 'Gejagte gewinnen' : 'abgebrochen' })),
      el('table', { class: 'round-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Gejagte' }), el('th', { text: 'Gefangen' }), el('th', { text: 'Im Spiel' }))),
        el('tbody', {}, r.runners.map((g) => el('tr', {},
          el('td', { text: g.name }),
          el('td', { text: g.caughtAt ? `${fmtTime(g.caughtAt)} Uhr` : 'nicht gefangen' }),
          el('td', { text: `${String(g.survivedMin).replace('.', ',')} min` }))))),
      el('p', {
        class: 'small muted',
        text: `${n(r.pings.regular, 'Ping', 'Pings')}, ${n(r.pings.extra, 'Extra-Ping', 'Extra-Pings')}, ${n(r.pings.admin, 'Sofort-Ping', 'Sofort-Pings')}, ${n(r.blocks || 0, 'Block', 'Blocks')} · ${n(r.emergencies, 'Notfall', 'Notfälle')} · Ping alle ${r.settings.pingIntervalMin} min, Dauer ${r.settings.durationMin} min${r.settings.extraMin ? ` (${r.settings.extraMin > 0 ? '+' : '−'}${Math.abs(r.settings.extraMin)} min)` : ''}`,
      })))
    : [el('p', { class: 'small muted', text: 'Nach dem ersten Spielende steht hier, wer wann gefangen wurde.' })]));
}

// --- Nachricht + Verlauf -----------------------------------------------------

function renderMessage() {
  $('#msgCurrent').textContent = R.message ? `Aktiv seit ${fmtTime(R.message.at)}: „${R.message.text}“` : 'Keine aktive Nachricht.';
  $('#msgClear').disabled = !R.message;
  $('#msgMeeting').disabled = !R.settings.meetingPoint;
  $('#msgMeeting').title = R.settings.meetingPoint ? '' : 'Erst in den Einstellungen einen Treffpunkt festlegen';
}

$('#msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#msgText').value.trim();
  if (!text) return;
  if (await act('POST', '/message', { text })) { $('#msgText').value = ''; toast('Nachricht gesendet'); }
});
$('#msgClear').addEventListener('click', () => act('POST', '/message', { text: '' }));
async function callMeeting() {
  const mp = R.settings.meetingPoint;
  if (!mp || !confirm(`Alle Handys zum Treffpunkt „${mp.label}“ rufen?`)) return;
  const text = `Bitte alle sofort zum Treffpunkt: ${mp.label}! Die Route findet ihr unten unter „Treffpunkt“.`;
  if (await act('POST', '/message', { text })) toast('Alle wurden zum Treffpunkt gerufen');
}
$('#msgMeeting').addEventListener('click', callMeeting);

function renderEvents() {
  swapIfChanged($('#events'), [...R.events].reverse().map((ev) =>
    el('li', { class: ev.text.startsWith('NOTFALL') ? 'sos-event' : '' }, el('time', { text: fmtTime(ev.at) }), el('span', { text: ev.text }))));
}

// --- Karte ------------------------------------------------------------------------

function renderMap() {
  if (!map || !R) return;
  const hunter = cssVar('--hunter-map'), runner = cssVar('--runner'), neutral = cssVar('--caught'), primary = cssVar('--primary');
  const t = now();

  layers.preview.clearLayers();
  layers.meeting.clearLayers();
  // aktuelles Spielfeld (schrumpft ggf. während des Spiels) und End-Kreis
  drawZone(layers.zone, R.zone, R.zoneFinalRadius);
  const preview = { color: primary, weight: 2, dashArray: '2 6', fillOpacity: 0.08, interactive: false };
  if (picking === 'polygon') {
    // Fläche wird gerade gezeichnet: Linie durch die Ecken, ein Tipp auf die erste Ecke schließt die Fläche
    if (drawPoints.length > 1) L.polyline(drawPoints, { ...preview, fill: false }).addTo(layers.preview);
    drawPoints.forEach((p, i) => {
      const m = L.circleMarker(p, {
        radius: i === 0 ? 8 : 5, color: primary, weight: 2, fillColor: '#fff', fillOpacity: 1,
        interactive: i === 0, bubblingMouseEvents: false,
      }).addTo(layers.preview);
      if (i === 0) m.on('click', finishPolygon).bindTooltip('Fläche schließen', { direction: 'top' });
    });
  } else if (settingsDirty && pendingZone?.points) {
    L.polygon(pendingZone.points, preview).addTo(layers.preview);
  } else if (settingsDirty && pendingZone) {
    L.circle([pendingZone.lat, pendingZone.lng], { radius: Number(form.radius.value) || 1500, ...preview }).addTo(layers.preview);
  }
  // Treffpunkt: gespeicherter Stand, beim Bearbeiten der Formularstand
  const mp = settingsDirty
    ? pendingMeeting && { ...pendingMeeting, label: `${form.meetingLabel.value || 'Treffpunkt'} (nicht gespeichert)` }
    : R.settings.meetingPoint;
  if (mp) meetingMarker(mp).addTo(layers.meeting);

  layers.pings.clearLayers();
  const ping = R.status === 'lobby' ? null : R.pings.at(-1);
  if (ping) {
    for (const p of ping.positions) {
      if (p.lat != null) L.circleMarker([p.lat, p.lng], { radius: 12, color: runner, weight: 2, fill: false, dashArray: '3 3', interactive: false }).addTo(layers.pings);
    }
  }

  layers.players.clearLayers();
  for (const p of [...R.players].sort((a, b) => b.emergency - a.emergency)) {
    if (!p.pos) continue;
    const stale = !p.lastSeen || t - p.lastSeen > 60000;
    const color = p.role === 'hunter' ? hunter : p.role === 'runner' ? runner : neutral;
    labeledMarker([p.pos.lat, p.pos.lng], {
      color: p.emergency ? cssVar('--danger-solid') : color,
      radius: p.emergency ? 12 : 8,
      fill: stale && !p.emergency ? 0.25 : 0.9,
      label: `${p.emergency ? '🚨 ' : ''}${p.name}${p.outside ? ' ⚠' : ''}${p.transport && p.role === 'runner' ? ` ${TRANSPORT_ICON[p.transport.mode]}` : ''}`,
      className: p.emergency ? 'sos' : stale ? 'old' : '',
    }).addTo(layers.players);
  }

  scheduleDeclutter();
  if (pendingFocus) {
    map.setView(pendingFocus, 17);
    pendingFocus = null;
    fitted = true;
  }
  if (!fitted) fitted = fitAll();
}

// Kartenschilder entzerren – Notfälle zuerst (werden in renderMap zuerst gezeichnet), dann Treffpunkt
let declutterQueued = false;
function scheduleDeclutter() {
  if (declutterQueued) return;
  declutterQueued = true;
  requestAnimationFrame(() => {
    declutterQueued = false;
    if (map && !$('#roomView').classList.contains('hidden')) declutterLabels([layers.players, layers.meeting], [], scheduleDeclutter);
  });
}

function fitAll() {
  const pts = R.players.filter((p) => p.pos).map((p) => [p.pos.lat, p.pos.lng]);
  const { zone: z, meetingPoint: mp } = R.settings;
  if (mp) pts.push([mp.lat, mp.lng]);
  let bounds = pts.length ? L.latLngBounds(pts) : null;
  if (z) {
    const zb = zoneBounds(z);
    bounds = bounds ? bounds.extend(zb) : zb;
  }
  if (!bounds) return false;
  map.fitBounds(bounds.pad(0.1), { maxZoom: 16 });
  return true;
}

$('#fitAll').addEventListener('click', () => { if (R) fitAll(); });

// ---------------------------------------------------------------------------
// Aufsicht-Link: Zugang für eine zweite Lehrkraft nur zu diesem Raum (ohne Konto)
// ---------------------------------------------------------------------------

async function showSupLink() {
  if (!R.supToken && !(await act('POST', '/suplink'))) return;
  const url = `${baseUrl()}/admin#aufsicht=${R.supToken}`;
  const img = el('img', { alt: 'QR-Code: Aufsicht-Link' });
  secretQr(url).then((src) => { img.src = src; }).catch(handleError);
  const b = (text, onclick, cls = '') => el('button', { class: `btn sm ${cls}`, type: 'button', onclick, text });
  openOverlay(el('div', { class: 'card stack qr-full' },
    el('h2', { text: 'Aufsicht-Link' }),
    el('p', { class: 'small', text: `Für Kolleg:innen: Wer diesen Code scannt, sieht nur den Raum „${R.name}“, bekommt dessen Notfälle und Warnungen und kann Nachrichten senden – aber nichts starten, einstellen oder löschen. Ein Konto ist nicht nötig.` }),
    img,
    el('div', { class: 'join-url', text: url }),
    el('div', { class: 'row', style: 'justify-content:center' },
      b('Link kopieren', async () => {
        try { await navigator.clipboard.writeText(url); toast('Aufsicht-Link kopiert'); } catch { toast('Kopieren nicht möglich', true); }
      }),
      b('Neuen Link erzeugen', async () => {
        if (!confirm('Neuen Aufsicht-Link erzeugen? Wer den bisherigen benutzt, wird abgemeldet.')) return;
        if (await act('POST', '/suplink')) showSupLink();
      }),
      b('Zurückziehen', async () => {
        if (!confirm('Aufsicht-Link zurückziehen? Wer ihn benutzt, wird sofort abgemeldet.')) return;
        if (await act('DELETE', '/suplink')) { closeOverlay(); toast('Aufsicht-Link zurückgezogen'); }
      }, 'danger')),
    el('p', { class: 'small muted', text: 'Wie ein Schlüssel: nur an Kolleg:innen weitergeben. „Neuer Link“ und „Zurückziehen“ melden alle Geräte ab, die den bisherigen Link benutzen.' }),
    el('button', { class: 'btn primary', type: 'button', onclick: closeOverlay, text: 'Schließen' })));
}
$('#supLinkBtn').addEventListener('click', showSupLink);

// ---------------------------------------------------------------------------
// Konten (nur Admin): Registrierungen freigeben, sperren, Passwort-Link, löschen
// ---------------------------------------------------------------------------

const STATUS_TEXT = { pending: 'wartet auf Freigabe', active: 'aktiv', disabled: 'gesperrt' };
let usersCache = [];

function renderPendingBadge() {
  const n = alerts.pendingAccounts || 0;
  const badge = $('#pendingBadge');
  badge.textContent = n ? String(n) : '';
  badge.classList.toggle('hidden', !n);
}

async function showAccounts() {
  let data;
  try { data = await api('GET', '/api/admin/users'); } catch (e) { return handleError(e); }
  usersCache = data.users;
  const userAct = async (method, path, body, msg) => {
    try {
      const r = await api(method, `/api/admin/users/${path}`, body);
      if (msg) toast(msg);
      return r || true;
    } catch (e) { handleError(e); return null; }
  };
  const b = (text, onclick, cls = '') => el('button', { class: `btn sm ${cls}`, type: 'button', onclick, text });
  const item = (u) => {
    const actions = [];
    if (u.status === 'pending') {
      actions.push(b('Freigeben', async () => { if (await userAct('PATCH', u.id, { status: 'active' }, `${u.name} freigegeben`)) showAccounts(); }, 'primary'));
      actions.push(b('Ablehnen', async () => {
        if (confirm(`Registrierung von ${u.name} ablehnen und löschen?`) && await userAct('DELETE', u.id, undefined, 'Registrierung gelöscht')) showAccounts();
      }));
    } else {
      if (u.status === 'active') {
        actions.push(b('Passwort-Link', async () => {
          const r = await userAct('POST', `${u.id}/reset`);
          if (!r) return;
          const link = `${baseUrl()}${r.path}`;
          linkBox.replaceChildren(
            el('strong', { text: `Passwort-Link für ${u.name}` }),
            el('div', { class: 'join-url', text: link }),
            el('div', { class: 'small muted', text: `Gilt 48 Stunden und nur einmal. Selbst weitergeben, z. B. per E-Mail an ${u.email}.` }),
            b('Link kopieren', async () => {
              try { await navigator.clipboard.writeText(link); toast('Link kopiert'); } catch { toast('Kopieren nicht möglich', true); }
            }));
          linkBox.classList.remove('hidden');
        }));
        actions.push(b('Sperren', async () => {
          if (confirm(`${u.name} sperren? Angemeldete Geräte werden sofort abgemeldet, die Räume bleiben.`) && await userAct('PATCH', u.id, { status: 'disabled' }, 'Konto gesperrt')) showAccounts();
        }));
      } else {
        actions.push(b('Entsperren', async () => { if (await userAct('PATCH', u.id, { status: 'active' }, 'Konto entsperrt')) showAccounts(); }));
      }
      actions.push(holdButton({
        text: 'Löschen (gedrückt halten)', cls: 'danger sm', title: `Konto von ${u.name} samt ${u.rooms} Räumen löschen – 2 Sekunden gedrückt halten`,
        onConfirm: async () => { if (await userAct('DELETE', u.id, undefined, `Konto von ${u.name} gelöscht`)) showAccounts(); },
      }));
    }
    return el('li', { class: `account-item ${u.status}` },
      el('div', { class: 'account-head' },
        el('strong', { text: u.name }),
        el('span', { class: `badge ${u.status === 'active' ? 'running' : u.status === 'pending' ? 'warn' : ''}`, text: STATUS_TEXT[u.status] })),
      el('div', { class: 'small', text: `${u.org} · ${u.email}` }),
      el('div', {
        class: 'small muted',
        text: [
          `registriert ${fmtDate(u.createdAt)}`,
          u.lastLoginAt ? `zuletzt angemeldet ${fmtDate(u.lastLoginAt)}` : 'noch nie angemeldet',
          `${u.rooms} ${u.rooms === 1 ? 'Raum' : 'Räume'}`,
          u.privacySet ? 'Datenschutz-Angaben ✓' : u.status === 'active' ? 'Datenschutz-Angaben fehlen' : null,
        ].filter(Boolean).join(' · '),
      }),
      el('div', { class: 'row' }, actions));
  };
  const linkBox = el('div', { class: 'link-box stack hidden' });
  const toggle = el('input', {
    type: 'checkbox', checked: data.registrationOpen,
    onchange: async (e) => {
      try {
        await api('PATCH', '/api/admin/platform', { registrationOpen: e.target.checked });
        toast(e.target.checked ? 'Registrierung geöffnet' : 'Registrierung geschlossen');
      } catch (err) { handleError(err); e.target.checked = !e.target.checked; }
    },
  });
  const pending = data.users.filter((u) => u.status === 'pending');
  const others = data.users.filter((u) => u.status !== 'pending');
  openOverlay(el('div', { class: 'card stack accounts-card' },
    el('h2', { text: 'Konten der Lehrkräfte' }),
    el('label', { class: 'check' }, toggle, ` Registrierung offen – unter ${baseUrl()}/registrieren`),
    el('p', { class: 'small muted', text: 'Lehrkräfte sehen nur ihre eigenen Räume und bekommen nur deren Alarme. Du siehst alle Räume, bekommst aber keine Alarme aus fremden Räumen. Nicht freigegebene Registrierungen werden nach 14 Tagen gelöscht.' }),
    linkBox,
    pending.length ? el('h3', { text: `Warten auf Freigabe (${pending.length})` }) : null,
    pending.length ? el('ul', { class: 'list account-list' }, pending.map(item)) : null,
    el('h3', { text: `Konten (${others.length})` }),
    others.length ? el('ul', { class: 'list account-list' }, others.map(item)) : el('p', { class: 'small muted', text: 'Noch keine freigegebenen Konten.' }),
    el('button', { class: 'btn primary', type: 'button', onclick: closeOverlay, text: 'Schließen' })));
}
$('#accountsBtn').addEventListener('click', showAccounts);

// Raum einem anderen Konto übergeben (nur Admin, Einstellungen)
async function renderOwnerSelect() {
  if (!usersCache.length) {
    try { usersCache = (await api('GET', '/api/admin/users')).users; } catch { return; }
  }
  const sel = $('#ownerSel');
  if (document.activeElement === sel) return;
  const opts = [el('option', { value: 'admin', text: 'Admin (dir)' }),
    ...usersCache.filter((u) => u.status === 'active').map((u) => el('option', { value: u.id, text: `${u.name} (${u.org})` }))];
  swapIfChanged(sel, opts);
  sel.value = R.ownerId;
}
$('#ownerSave').addEventListener('click', async () => {
  const ownerId = $('#ownerSel').value;
  if (ownerId === R.ownerId) return;
  if (!confirm(`Raum „${R.name}“ übergeben? Notfälle und Warnungen gehen dann an das neue Konto; ein Aufsicht-Link wird ungültig.`)) return;
  try {
    await api('POST', `/api/admin/rooms/${roomId}/owner`, { ownerId });
    toast('Raum übergeben');
    loadRoom();
  } catch (e) { handleError(e); }
});

// ---------------------------------------------------------------------------
// Mein Konto (Lehrkräfte): Angaben, Datenschutz-Angaben, Passwort, Konto löschen
// ---------------------------------------------------------------------------

async function showMyAccount() {
  let me;
  try { me = await api('GET', '/api/account/me'); } catch (e) { return handleError(e); }
  const input = (label, value, attrs = {}) => {
    const inp = el('input', { value, ...attrs });
    return [el('label', { class: 'field' }, label, inp), inp];
  };
  const [nameL, nameI] = input('Name', me.name, { maxlength: 60 });
  const [orgL, orgI] = input('Schule bzw. Organisation', me.org, { maxlength: 120 });
  const [ctrlL, ctrlI] = input('Verantwortliche Stelle (Name und Anschrift der Schule)', me.privacyController, { maxlength: 300, placeholder: 'z. B. Gymnasium A, Schulweg 1, 99423 Weimar' });
  const [contL, contI] = input('Datenschutz-Kontakt', me.privacyContact, { maxlength: 300, placeholder: 'z. B. Datenschutzbeauftragte:r, E-Mail' });
  const [curL, curI] = input('Bisheriges Passwort', '', { type: 'password', autocomplete: 'current-password' });
  const [nextL, nextI] = input('Neues Passwort (mind. 10 Zeichen)', '', { type: 'password', autocomplete: 'new-password' });
  const [delL, delI] = input('Passwort zur Bestätigung', '', { type: 'password', autocomplete: 'current-password' });
  const save = async () => {
    try {
      const r = await api('PATCH', '/api/account/me', { name: nameI.value, org: orgI.value, privacyController: ctrlI.value, privacyContact: contI.value });
      account.name = r.name;
      $('#whoami').textContent = r.name;
      toast('Angaben gespeichert');
    } catch (e) { handleError(e); }
  };
  const changePw = async () => {
    try {
      await api('POST', '/api/account/password', { current: curI.value, next: nextI.value });
      curI.value = '';
      nextI.value = '';
      toast('Passwort geändert – andere Geräte sind abgemeldet');
    } catch (e) { handleError(e); }
  };
  openOverlay(el('div', { class: 'card stack accounts-card' },
    el('h2', { text: 'Mein Konto' }),
    el('p', { class: 'small muted', text: `${me.email} · ${me.rooms} von ${me.maxRooms} Räumen` }),
    nameL, orgL,
    el('h3', { text: 'Datenschutz-Seite für deine Spieler' }),
    el('p', { class: 'small muted', text: 'Diese Angaben stehen auf der Datenschutz-Seite, die Schüler in deinen Räumen sehen. Ohne Angabe steht dort deine Schule bzw. Organisation.' }),
    ctrlL, contL,
    el('button', { class: 'btn primary', type: 'button', onclick: save, text: 'Angaben speichern' }),
    el('h3', { text: 'Passwort ändern' }),
    curL, nextL,
    el('button', { class: 'btn', type: 'button', onclick: changePw, text: 'Passwort ändern' }),
    el('h3', { text: 'Konto löschen' }),
    el('p', { class: 'small muted', text: 'Löscht dein Konto und alle deine Räume mit allen Spieldaten – sofort und endgültig.' }),
    delL,
    holdButton({
      text: 'Konto löschen (3 s gedrückt halten)', holdText: 'Weiter halten … Konto wird gelöscht', ms: 3000, cls: 'danger',
      onConfirm: async () => {
        try {
          await api('DELETE', '/api/account/me', { password: delI.value });
          closeOverlay();
          showLogin();
          toast('Dein Konto und deine Räume sind gelöscht');
        } catch (e) { handleError(e); }
      },
    }),
    el('button', { class: 'btn primary', type: 'button', onclick: closeOverlay, text: 'Schließen' })));
}
$('#meBtn').addEventListener('click', showMyAccount);

boot().catch(handleError);
