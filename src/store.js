'use strict';

// Spielzustand im Speicher + Sicherung als state.json (alle 3 s, Löschungen sofort)

const fs = require('node:fs');
const { STATE_FILE, MAX_EVENTS } = require('./config');

const state = { rooms: {} };
const tokenIndex = new Map(); // Spieler-Token -> { roomId, playerId }
let dirty = false;

const playersOf = (room) => Object.values(room.players);

// migrateRoom ergänzt Räume aus älteren Versionen um neue Felder
function loadState(migrateRoom) {
  try {
    state.rooms = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).rooms || {};
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
function logEvent(room, text, bot = false) {
  room.events.push(bot ? { at: Date.now(), text, bot: true } : { at: Date.now(), text });
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
  markDirty();
}

module.exports = { state, tokenIndex, playersOf, loadState, saveState, markDirty, startAutosave, logEvent };
