'use strict';

// Lehrkräfte-Konten: Selbst-Registrierung mit Freigabe durch den Admin, eigene Räume, eigene Datenschutz-Angaben.
// Kein Mailversand: Ein vergessenes Passwort setzt der Admin über einen einmaligen Link zurück.

const crypto = require('node:crypto');
const config = require('./config');
const { HttpError, randomId, cleanName } = require('./util');
const { state, tokenIndex, markDirty, saveState, logEvent } = require('./store');
const game = require('./game');
const mail = require('./mail');
const {
  route, readJson, rateLimit, limitKey, requireLogin, requireSuperAdmin, requireOwnPage, startSession, revokeSession, setAdminCookie,
  safeEqual, roomFor,
} = require('./http');

const MAX_PENDING = 50;          // gleichzeitig wartende Registrierungen (gegen Massen-Anmeldungen)
const MAX_USERS = 1000;
const PENDING_DAYS = 14;         // nicht freigegebene Registrierungen werden danach gelöscht
const RESET_MS = 48 * 3600e3;    // Gültigkeit eines Passwort-Links

// --- Passwörter (scrypt, je Konto eigenes Salz) ------------------------------------

// N=2^15, r=8, p=3 (OWASP-Empfehlung mit 32 MB Speicher je Berechnung); die Parameter stehen im Hash,
// damit sie sich später erhöhen lassen, ohne alte Passwörter ungültig zu machen
const PARAMS = { N: 32768, r: 8, p: 3 };
const scrypt = (pw, salt, { N, r, p }) => new Promise((resolve, reject) => {
  crypto.scrypt(String(pw), salt, 32, { N, r, p, maxmem: 256 * N * r }, (e, key) => (e ? reject(e) : resolve(key)));
});

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const { N, r, p } = PARAMS;
  const key = await scrypt(pw, salt, PARAMS);
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every(Number.isInteger) || params.N > 2 ** 20) return false;
  const key = await scrypt(pw, Buffer.from(salt, 'base64url'), params);
  const want = Buffer.from(hash, 'base64url');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

// Für unbekannte E-Mail-Adressen trotzdem rechnen – sonst verrät die Antwortzeit, welche Adressen es gibt
let dummyHash = null;
const dummy = async () => (dummyHash ??= await hashPassword(randomId(12)));

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Das Passwort braucht mindestens 10 Zeichen.');
  if (pw.length > 200) throw new HttpError(400, 'Das Passwort ist zu lang.');
  return pw;
}

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,180}\.[^\s@<>]{2,}$/;
const userByEmail = (email) => Object.values(state.users).find((u) => u.email === email) || null;
const getUser = (id) => {
  const u = Object.hasOwn(state.users, id) ? state.users[id] : null;
  if (!u) throw new HttpError(404, 'Konto nicht gefunden');
  return u;
};

async function checkLogin(email, pw) {
  const u = userByEmail(normEmail(email));
  if (!u) { await verifyPassword(pw, await dummy()); return null; }
  return (await verifyPassword(pw, u.passwordHash)) ? u : null;
}

const ownerName = (ownerId) => (ownerId === 'admin' ? 'Admin' : state.users[ownerId]?.name ?? 'gelöschtes Konto');
const roomsOf = (id) => Object.values(state.rooms).filter((r) => r.ownerId === id);

// Konto löschen: alle Räume (mit allen Spieldaten) gleich mit – sofort auf die Platte
function deleteUser(u) {
  for (const room of roomsOf(u.id)) game.deleteRoom(room);
  delete state.users[u.id];
  try { saveState(); } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); markDirty(); }
}

// Aufsicht-Links aller Räume eines Kontos zurückziehen (beim Sperren und beim Passwort-Link des Admins)
function revokeSupLinks(u) {
  for (const room of roomsOf(u.id)) room.supLink = null;
}

function requireAccount(req) {
  const p = requireLogin(req);
  if (p.kind !== 'manager') throw new HttpError(403, 'Das gibt es nur für Lehrkräfte-Konten.');
  return p;
}

const accountView = (u) => ({
  name: u.name, email: u.email, org: u.org,
  privacyController: u.privacy?.controller || '', privacyContact: u.privacy?.contact || '',
  rooms: roomsOf(u.id).length, maxRooms: config.MAX_ROOMS_PER_USER,
});

// --- Registrierung, eigenes Konto ----------------------------------------------------

route('GET', '/api/account/registration', () => ({ open: !!state.platform.registrationOpen }));

route('POST', '/api/account/register', async (req) => {
  requireOwnPage(req);
  rateLimit(req, 'register', 5, 3600e3);
  if (!state.platform.registrationOpen) throw new HttpError(403, 'Die Registrierung ist gerade geschlossen.');
  // insgesamt höchstens 30 Registrierungen pro Stunde – auch von vielen Adressen aus
  try { limitKey('register-global', 30, 3600e3); } catch { throw new HttpError(429, 'Gerade gibt es sehr viele Anmeldungen – bitte später erneut versuchen.'); }
  const b = await readJson(req);
  const name = cleanName(b.name, 60);
  const org = cleanName(b.org, 120);
  const email = normEmail(b.email);
  if (name.length < 2) throw new HttpError(400, 'Bitte deinen Namen angeben.');
  if (org.length < 2) throw new HttpError(400, 'Bitte Schule bzw. Organisation angeben.');
  if (email.length > 200 || !EMAIL_RE.test(email)) throw new HttpError(400, 'Bitte eine gültige E-Mail-Adresse angeben.');
  checkPassword(b.password);
  // Immer zuerst rechnen (gleiche Antwortzeit für neue und bekannte Adressen), danach ohne Unterbrechung prüfen und
  // eintragen – so können zwei gleichzeitige Anfragen weder doppelte Adressen noch zu viele Wartende erzeugen
  const passwordHash = await hashPassword(b.password);
  const users = Object.values(state.users);
  if (users.filter((u) => u.status === 'pending').length >= MAX_PENDING) {
    throw new HttpError(429, 'Gerade warten zu viele Anmeldungen auf Freigabe – bitte später erneut versuchen.');
  }
  if (users.length >= MAX_USERS) throw new HttpError(409, 'Es können gerade keine weiteren Konten angelegt werden.');
  // Gibt es die Adresse schon, antworten wir genauso – sonst ließe sich herausfinden, wer ein Konto hat
  if (!userByEmail(email)) {
    const u = {
      id: randomId(6), name, email, org, passwordHash,
      status: 'pending', createdAt: Date.now(), approvedAt: null, lastLoginAt: null, sessionVersion: 1,
      privacy: { controller: '', contact: '' }, reset: null,
    };
    state.users[u.id] = u;
    markDirty();
    console.log('Neue Registrierung wartet auf Freigabe'); // ohne Namen: Server-Protokolle überleben gelöschte Konten
    const pendingNow = Object.values(state.users).filter((x) => x.status === 'pending').length;
    // Link nur aus PUBLIC_URL – den Host-Header einer Anfrage könnte ein Angreifer fälschen (Link auf eine fremde Seite)
    const adminUrl = config.PUBLIC_URL ? `${config.PUBLIC_URL}/admin` : 'deiner Manhunt-Seite unter /admin';
    mail.notifyAdmin('Manhunt: neue Registrierung wartet auf Freigabe', [
      'Eine neue Lehrkraft hat sich bei Manhunt registriert:',
      '',
      `Name:   ${name}`,
      `Schule: ${org}`,
      `E-Mail: ${email}`,
      '',
      `Freigeben oder ablehnen: ${adminUrl} → Räume → Konten${pendingNow > 1 ? ` (insgesamt ${pendingNow} wartend)` : ''}`,
      `Ohne Freigabe wird die Registrierung nach ${PENDING_DAYS} Tagen gelöscht.`,
    ].join('\n'));
  }
  return { ok: true };
});

route('GET', '/api/account/me', (req) => accountView(requireAccount(req).user));

route('PATCH', '/api/account/me', async (req) => {
  const u = requireAccount(req).user;
  const b = await readJson(req);
  if (b.name != null) {
    const name = cleanName(b.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Bitte deinen Namen angeben.');
    u.name = name;
  }
  if (b.org != null) u.org = cleanName(b.org, 120) || u.org;
  u.privacy ??= { controller: '', contact: '' };
  if (b.privacyController != null) u.privacy.controller = cleanName(b.privacyController, 300);
  if (b.privacyContact != null) u.privacy.contact = cleanName(b.privacyContact, 300);
  markDirty();
  return accountView(u);
});

// Passwort ändern: alle anderen Sitzungen dieses Kontos werden ungültig, diese bekommt eine neue
route('POST', '/api/account/password', async (req, res) => {
  rateLimit(req, 'password', 10, 15 * 60e3);
  const u = requireAccount(req).user;
  const b = await readJson(req);
  if (!(await verifyPassword(b.current, u.passwordHash))) throw new HttpError(403, 'Das bisherige Passwort stimmt nicht.');
  u.passwordHash = await hashPassword(checkPassword(b.next));
  u.sessionVersion++;
  markDirty();
  startSession(req, res, `u:${u.id}:${u.sessionVersion}`, config.ADMIN_SESSION_MS);
  return { ok: true };
});

// Konto selbst löschen (mit Passwort) – alle eigenen Räume samt Spieldaten verschwinden sofort
route('DELETE', '/api/account/me', async (req, res) => {
  rateLimit(req, 'password', 10, 15 * 60e3);
  const u = requireAccount(req).user;
  const b = await readJson(req);
  if (!(await verifyPassword(b.password, u.passwordHash))) throw new HttpError(403, 'Das Passwort stimmt nicht.');
  revokeSession(req);
  setAdminCookie(req, res, '', 0);
  console.log(`Konto gelöscht (selbst), ${roomsOf(u.id).length} Räume`);
  deleteUser(u);
  return { ok: true };
});

// Neues Passwort über einen Link des Admins (/passwort#<schlüssel>)
route('POST', '/api/account/reset', async (req) => {
  requireOwnPage(req);
  rateLimit(req, 'reset', 10, 15 * 60e3);
  const b = await readJson(req);
  const token = typeof b.token === 'string' ? b.token : '';
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const t = Date.now();
  const u = token.length >= 16 && Object.values(state.users).find((x) => x.reset && x.reset.exp > t && safeEqual(x.reset.hash, hash));
  if (!u) throw new HttpError(404, 'Dieser Link ist abgelaufen oder wurde schon benutzt. Bitte beim Admin einen neuen holen.');
  u.passwordHash = await hashPassword(checkPassword(b.password));
  u.reset = null;
  u.sessionVersion++;
  revokeSupLinks(u); // wer das Passwort neu setzt, will auch alte Zugänge loswerden
  markDirty();
  return { ok: true, email: u.email };
});

// --- Verwaltung durch den Admin ------------------------------------------------------

route('GET', '/api/admin/users', (req) => {
  requireSuperAdmin(req);
  const order = { pending: 0, active: 1, disabled: 2 };
  return {
    registrationOpen: !!state.platform.registrationOpen,
    mail: mail.enabled() ? config.ADMIN_EMAIL : null,
    users: Object.values(state.users)
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'de'))
      .map((u) => ({
        id: u.id, name: u.name, email: u.email, org: u.org, status: u.status,
        createdAt: u.createdAt, approvedAt: u.approvedAt, lastLoginAt: u.lastLoginAt,
        rooms: roomsOf(u.id).length, privacySet: !!u.privacy?.controller,
      })),
  };
});

route('PATCH', '/api/admin/users/:id', async (req, res, { id }) => {
  requireSuperAdmin(req);
  const u = getUser(id);
  const { status } = await readJson(req);
  if (!['active', 'disabled'].includes(status)) throw new HttpError(400, 'Ungültiger Status');
  if (status === 'active' && !u.approvedAt) u.approvedAt = Date.now();
  if (status === 'disabled') {
    u.sessionVersion++; // gesperrt: angemeldete Geräte fliegen sofort raus …
    revokeSupLinks(u);  // … auch Aufsicht-Links aus diesem Konto
  }
  u.status = status;
  markDirty();
  console.log(`Konto ${status === 'active' ? 'freigegeben' : 'gesperrt'}`);
  return { ok: true };
});

// Einmaliger Link zum Setzen eines neuen Passworts – der Admin gibt ihn selbst weiter
route('POST', '/api/admin/users/:id/reset', (req, res, { id }) => {
  requireSuperAdmin(req);
  const u = getUser(id);
  const token = randomId(24);
  u.reset = { hash: crypto.createHash('sha256').update(token).digest('hex'), exp: Date.now() + RESET_MS };
  markDirty();
  return { path: `/passwort#${token}`, exp: u.reset.exp };
});

route('DELETE', '/api/admin/users/:id', (req, res, { id }) => {
  requireSuperAdmin(req);
  const u = getUser(id);
  console.log(`Konto gelöscht (Admin), ${roomsOf(u.id).length} Räume`);
  deleteUser(u);
  return { ok: true };
});

// Mail-Prüfung im Admin-Bereich: Einstellungen (ohne Passwort) und letzte Benachrichtigung …
route('GET', '/api/admin/mail', (req) => {
  requireSuperAdmin(req);
  return mail.status();
});

// … und Schritt für Schritt prüfen: Verbindung und Anmeldung, auf Wunsch eine Test-Mail (send: true)
route('POST', '/api/admin/mail-check', async (req) => {
  requireSuperAdmin(req);
  rateLimit(req, 'mail-check', 10, 10 * 60e3);
  const { send } = await readJson(req);
  return mail.checkMail({ send: send === true });
});

route('PATCH', '/api/admin/platform', async (req) => {
  requireSuperAdmin(req);
  const b = await readJson(req);
  if (typeof b.registrationOpen === 'boolean') state.platform.registrationOpen = b.registrationOpen;
  markDirty();
  return { registrationOpen: state.platform.registrationOpen };
});

// Raum einem anderen Konto (oder dem Admin) übergeben. Wird vor den Raum-Aktionen in routes/admin.js registriert
// (admin.js lädt dieses Modul zuerst) – sonst fiele „owner“ unter /api/admin/rooms/:id/:action.
route('POST', '/api/admin/rooms/:id/owner', async (req, res, { id }) => {
  requireSuperAdmin(req);
  const { room } = roomFor(req, id);
  const { ownerId } = await readJson(req);
  if (typeof ownerId !== 'string') throw new HttpError(400, 'Ungültiges Konto');
  if (ownerId !== 'admin') {
    const u = getUser(ownerId);
    if (u.status !== 'active') throw new HttpError(409, 'Räume lassen sich nur an freigegebene, nicht gesperrte Konten übergeben.');
    if (roomsOf(u.id).length >= config.MAX_ROOMS_PER_USER) throw new HttpError(409, `${u.name} hat schon ${config.MAX_ROOMS_PER_USER} Räume.`);
  }
  if (ownerId === room.ownerId) return { ok: true };
  room.ownerId = ownerId;
  room.supLink = null; // ein Aufsicht-Link gehört zur bisherigen Spielleitung
  logEvent(room, `Raum übergeben an ${ownerName(ownerId)}`);
  markDirty();
  return { ok: true };
});

// --- Datenschutz-Angaben für Spieler: die Schule, deren Raum sie beigetreten sind ----------

route('GET', '/api/privacy', (req, res, params, url) => {
  rateLimit(req, 'privacy', 120, 60e3);
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  const token = req.headers['x-player-token'];
  const ref = token ? tokenIndex.get(token) : null;
  const room = ref ? state.rooms[ref.roomId] : code ? Object.values(state.rooms).find((r) => r.code === code) : null;
  const u = room && room.ownerId !== 'admin' ? state.users[room.ownerId] : null;
  if (!u) return { external: false, operator: config.PRIVACY_OPERATOR || null };
  return {
    external: true,
    org: u.org,
    controller: u.privacy?.controller || null,
    contact: u.privacy?.contact || null,
    operator: config.PRIVACY_OPERATOR || config.PRIVACY_CONTROLLER || null,
  };
});

// --- Aufräumen: alte, nie freigegebene Registrierungen und abgelaufene Passwort-Links ----------

function cleanupAccounts() {
  const t = Date.now();
  for (const u of Object.values(state.users)) {
    if (u.status === 'pending' && t - u.createdAt > PENDING_DAYS * 86400e3) {
      console.log(`Registrierung ohne Freigabe nach ${PENDING_DAYS} Tagen gelöscht`);
      delete state.users[u.id];
      markDirty();
    } else if (u.reset && u.reset.exp < t) {
      u.reset = null;
      markDirty();
    }
  }
}
function startAccountCleanup() {
  cleanupAccounts();
  setInterval(cleanupAccounts, 3600e3);
}

module.exports = { checkLogin, ownerName, startAccountCleanup, hashPassword, PENDING_DAYS };
