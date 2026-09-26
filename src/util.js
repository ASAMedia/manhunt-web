'use strict';

// Kleine Helfer ohne Abhängigkeiten

const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

// Entfernung zweier Punkte {lat,lng} in Metern (Haversine)
function distanceM(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Punkt in `dist` Metern Entfernung in Richtung `bearing` (Grad)
function offsetPoint(p, dist, bearing) {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (dist * Math.cos(rad)) / 111320;
  const dLng = (dist * Math.sin(rad)) / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

const bearingTo = (a, b) => (Math.atan2(
  (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat,
) * 180) / Math.PI;

// Namen und kurze Texte: keine Steuerzeichen, keine spitzen Klammern, Leerraum zusammenfassen.
// Unsichtbare Formatzeichen (Zero-Width, Bidi) fliegen raus, damit sich niemand als „Anna“ ausgeben kann.
function cleanName(v, max = 24) {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '') // eslint-disable-line no-control-regex
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Mehrzeilige Texte (Regeln, Nachrichten): Zeilenumbrüche bleiben, andere Steuerzeichen fliegen raus
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max); // eslint-disable-line no-control-regex

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// wie clampInt, aber mit einer Nachkommastelle (z. B. 0,5 Minuten)
function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}

module.exports = { HttpError, randomId, distanceM, offsetPoint, bearingTo, cleanName, cleanText, clampInt, clampNum };
