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

// --- Spielfeld: Kreis {lat,lng,radius} oder Fläche {lat,lng,radius,points:[[lat,lng],…]} ------------
// Bei einer Fläche ist lat/lng die Mitte (Schwerpunkt der Ecken) und radius der größte Abstand
// von der Mitte zu einer Ecke – so funktioniert alles, was nur einen Umkreis braucht, für beide Formen.

function polygonZone(points) {
  const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const lng = points.reduce((s, p) => s + p[1], 0) / points.length;
  const radius = Math.ceil(Math.max(...points.map(([a, b]) => distanceM({ lat, lng }, { lat: a, lng: b }))));
  return { lat, lng, radius, points };
}

// Punkt-in-Fläche (Strahlverfahren); für kleine Gebiete genügt die Rechnung in Grad
function insidePolygon(points, pos) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ai, bi] = points[i], [aj, bj] = points[j];
    if ((bi > pos.lng) !== (bj > pos.lng) && pos.lat < ((aj - ai) * (pos.lng - bi)) / (bj - bi) + ai) inside = !inside;
  }
  return inside;
}

// Spielfeld auf einen kleineren Umkreis-Radius verkleinern (Fläche: Ecken Richtung Mitte ziehen)
function scaleZone(zone, radius) {
  if (!zone.points) return { ...zone, radius };
  const f = radius / zone.radius;
  return {
    ...zone, radius,
    points: zone.points.map(([a, b]) => [zone.lat + (a - zone.lat) * f, zone.lng + (b - zone.lng) * f]),
  };
}

// Ecken in Meter umrechnen (lokal, genügt für Stadtgebiete)
function toMeters(points) {
  const lat0 = (points.reduce((s, p) => s + p[0], 0) / points.length) * (Math.PI / 180);
  return points.map(([a, b]) => [b * 111320 * Math.cos(lat0), a * 111320]);
}

// Flächeninhalt in m² (Gaußsche Trapezformel), vorzeichenlos
function polygonAreaM2(points) {
  const m = toMeters(points);
  let a = 0;
  for (let i = 0, j = m.length - 1; i < m.length; j = i++) a += (m[j][0] + m[i][0]) * (m[j][1] - m[i][1]);
  return Math.abs(a / 2);
}

// Überkreuzen sich zwei nicht benachbarte Kanten?
function selfIntersects(points) {
  const m = toMeters(points);
  const n = m.length;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hit = (p1, p2, p3, p4) => {
    const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // erste und letzte Kante hängen zusammen
      if (hit(m[i], m[(i + 1) % n], m[j], m[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Liegt die Mitte auf der Innenseite aller Kanten? Nur dann bleibt die zur Mitte hin verkleinerte Fläche
// vollständig in der ursprünglichen (die Mitte „sieht“ jede Ecke) – sonst wandert sie beim Schrumpfen hinaus.
function starShaped(zone) {
  const m = toMeters([...zone.points, [zone.lat, zone.lng]]);
  const c = m.pop();
  let area = 0;
  for (let i = 0, j = m.length - 1; i < m.length; j = i++) area += (m[j][0] + m[i][0]) * (m[j][1] - m[i][1]);
  const sign = area < 0 ? 1 : -1; // Umlaufsinn der Ecken
  for (let i = 0; i < m.length; i++) {
    const a = m[i], b = m[(i + 1) % m.length];
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cr * sign < -1e-6) return false;
  }
  return true;
}

// Liegt pos im Spielfeld? scale < 1 prüft gegen ein entsprechend kleineres Feld (z. B. 0.9 = Randbereich)
function insideZone(zone, pos, scale = 1) {
  if (!zone.points) return distanceM(pos, zone) <= zone.radius * scale;
  return insidePolygon(scale === 1 ? zone.points : scaleZone(zone, zone.radius * scale).points, pos);
}

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

module.exports = {
  HttpError, randomId, distanceM, offsetPoint, bearingTo, polygonZone, scaleZone, insideZone,
  polygonAreaM2, selfIntersects, starShaped, cleanName, cleanText, clampInt, clampNum,
};
