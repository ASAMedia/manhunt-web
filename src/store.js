'use strict';

// Spielzustand im Speicher + Sicherung als state.json (alle 3 s, Löschungen sofort)

const fs = require('node:fs');
const { STATE_FILE, MAX_EVENTS } = require('./config');

// rooms: Spielräume · users: Lehrkräfte-Konten · platform: Einstellungen des Admins (z. B. Registrierung offen)
// Registrierung zunächst geschlossen – der Admin öffnet sie bewusst unter „Konten“
const state = { rooms: {}, users: {}, platform: { registrationOpen: false } };
const tokenIndex = new Map(); // Spieler-Token -> { roomId, playerId }
let dirty = false;

const playersOf = (room) => Object.values(room.players);

// migrateRoom ergänzt Räume aus älteren Versionen um neue Felder
function loadState(migrateRoom) {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.rooms = saved.rooms || {};
    state.users = saved.users || {};
    state.platform = { ...state.platform, ...saved.platform };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('state.json konnte nicht gelesen werden:', e.message);
  }
  for (const room of Object.values(state.rooms)) {
    migrateRoom(room);
    for (const p of playersOf(room)) tokenIndex.set(p.token, { roomId: room.id, playerId: p.id });
  }
}

function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

const markDirty = () => { dirty = true; };

function startAutosave() {
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try { saveState(); } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); dirty = true; }
  }, 3000);
}

// bot = Ereignis eines Test-Geräts (zählt nicht als Aktivität fürs automatische Löschen)
// keep = wichtiges Ereignis (Notruf, Rundenstart/-ende) – wird beim Kürzen des Verlaufs nie verdrängt
function logEvent(room, text, bot = false, keep = false) {
  const e = { at: Date.now(), text };
  if (bot) e.bot = true;
  if (keep) e.keep = true;
  room.events.push(e);
  while (room.events.length > MAX_EVENTS) {
    const i = room.events.findIndex((x) => !x.keep);
    room.events.splice(i < 0 ? 0 : i, 1);
  }
  markDirty();
}

module.exports = { state, tokenIndex, playersOf, loadState, saveState, markDirty, startAutosave, logEvent };
