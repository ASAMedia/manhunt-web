'use strict';

// Einstellungen aus der Umgebung (.env / docker-compose) – einmal beim Start gelesen und geprüft

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const env = process.env;

function parseCenter(v) {
  if (!v) return null;
  const [lat, lng] = v.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

const config = {
  PORT: Number(env.PORT) || 3000,
  DATA_DIR: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  // Optionales zweites Passwort für eine Aufsichtsperson (sieht alles, darf aber nichts starten/löschen/einstellen)
  SUPERVISOR_PASSWORD: env.SUPERVISOR_PASSWORD || '',
  PUBLIC_URL: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  TRUST_PROXY: env.TRUST_PROXY === '1',
  TILE_URL: env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION: env.TILE_ATTRIBUTION || '&copy; OpenStreetMap-Mitwirkende',
  MAP_CENTER: parseCenter(env.MAP_CENTER) || [52.517, 13.3889], // Berlin-Mitte
  // Räume werden so viele Tage nach der letzten Aktivität gelöscht (0 = nie); laufende Spiele nie
  AUTO_DELETE_DAYS: ['', undefined].includes(env.AUTO_DELETE_DAYS) ? 7 : Number(env.AUTO_DELETE_DAYS),
  // Kartenkacheln über diesen Server laden und zwischenspeichern (schont OSM, Handys sprechen nur mit uns)
  TILE_PROXY: env.TILE_PROXY !== '0',
  TILE_CACHE_DAYS: 7,
  // Angaben für die Datenschutz-Seite: verantwortliche Schule, Datenschutz-Kontakt, Hosting-Anbieter
  PRIVACY_CONTROLLER: (env.PRIVACY_CONTROLLER || '').slice(0, 300),
  PRIVACY_CONTACT: (env.PRIVACY_CONTACT || '').slice(0, 300),
  PRIVACY_HOSTING: (env.PRIVACY_HOSTING || '').slice(0, 300),
  // Betreiber der Plattform, wenn auch Lehrkräfte anderer Schulen eigene Konten haben (dann Auftragsverarbeiter)
  PRIVACY_OPERATOR: (env.PRIVACY_OPERATOR || '').slice(0, 300),
  // Lehrkräfte-Konten: höchstens so viele Räume je Konto (der Admin hat keine Grenze)
  MAX_ROOMS_PER_USER: Number(env.MAX_ROOMS_PER_USER) || 20,
  // E-Mail an den Admin bei neuen Registrierungen (über ein vorhandenes Mail-Konto)
  ADMIN_EMAIL: (env.ADMIN_EMAIL || '').trim(),
  SMTP_HOST: (env.SMTP_HOST || '').trim(),
  SMTP_PORT: Number(env.SMTP_PORT) || 587,
  SMTP_USER: env.SMTP_USER || '',
  SMTP_PASS: env.SMTP_PASS || '',
  SMTP_FROM: (env.SMTP_FROM || '').trim(),

  PUBLIC_DIR: path.join(ROOT, 'public'),
  LEAFLET_DIR: path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist'),

  MAX_PLAYERS: 100,
  MAX_PINGS: 60,
  MAX_EVENTS: 300,
  ADMIN_SESSION_MS: 12 * 3600e3,

  // Version für die Anzeige im Admin-Bereich; APP_BUILD setzt der Docker-Build (Commit + Datum)
  VERSION: require('../package.json').version,
  BUILD: (env.APP_BUILD || '').slice(0, 60) || null,
};

if (config.ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD fehlt oder ist kürzer als 8 Zeichen. Bitte in .env setzen.');
  process.exit(1);
}
// Ein Tippfehler wie „7d“ darf nicht still „nie löschen“ bedeuten
if (!(Number.isFinite(config.AUTO_DELETE_DAYS) && config.AUTO_DELETE_DAYS >= 0)) {
  console.error('AUTO_DELETE_DAYS muss eine Zahl ≥ 0 sein (Tage, 0 = nie löschen).');
  process.exit(1);
}
if (config.ADMIN_PASSWORD.length < 12) {
  console.warn('Hinweis: ADMIN_PASSWORD ist kürzer als 12 Zeichen – für den Betrieb im Internet besser ein längeres Passwort wählen.');
}
if (config.SUPERVISOR_PASSWORD && (config.SUPERVISOR_PASSWORD.length < 8 || config.SUPERVISOR_PASSWORD === config.ADMIN_PASSWORD)) {
  console.error('SUPERVISOR_PASSWORD muss mindestens 8 Zeichen haben und sich vom ADMIN_PASSWORD unterscheiden.');
  process.exit(1);
}

fs.mkdirSync(config.DATA_DIR, { recursive: true });
config.STATE_FILE = path.join(config.DATA_DIR, 'state.json');
config.TILE_DIR = path.join(config.DATA_DIR, 'tiles');

// Schlüssel für die Admin-Sitzungen: aus der Umgebung oder einmal erzeugt und im Datenordner gemerkt
config.SESSION_SECRET = (() => {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(config.DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
})();

module.exports = config;
