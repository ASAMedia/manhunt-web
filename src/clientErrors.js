'use strict';

// Fehlerberichte von Handys: Skriptfehler landen im Server-Log und in einer kleinen Liste für die Spielleitung.
// Bewusst ohne Namen, Standorte oder Spieler-Token – nur, was zum Beheben des Fehlers nötig ist.

const { cleanText, clampInt } = require('./util');
const { route, readJson, rateLimit, requireAdmin, requireStaff } = require('./http');

const MAX_REPORTS = 100;
const reports = []; // nur im Speicher – nach einem Neustart leer

// Wiederbeitritts-Links enthalten das Token – das darf nicht in Log oder Liste landen
const scrub = (s) => s.replace(/\/r\/[A-Za-z0-9_-]{10,64}/g, '/r/…').replace(/\/j\/[A-Za-z0-9]{1,12}/g, '/j/…').replace(/\?[^\s)]*/g, '');
const text = (v, max) => scrub(cleanText(v, max));
const pick = (v, allowed) => (allowed.includes(v) ? v : null);

// Nur Browser + Betriebssystem, nicht der ganze User-Agent
function shortAgent(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'anderes';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'anderer';
  const ver = /(?:Chrome|CriOS|Firefox|FxiOS|Version)\/(\d+)/.exec(ua)?.[1];
  return `${browser}${ver ? ` ${ver}` : ''} / ${os}`;
}

route('POST', '/api/client-error', async (req) => {
  rateLimit(req, 'client-error', 20, 60e3);
  const b = await readJson(req);
  const r = {
    message: text(b.message, 300) || '(ohne Meldung)',
    source: text(b.source, 120),
    line: clampInt(b.line, 0, 1e7),
    col: clampInt(b.col, 0, 1e7),
    stack: text(b.stack, 1000),
    page: text(b.page, 60),
    role: pick(b.role, ['hunter', 'runner', 'lobby', 'admin']),
    lang: pick(b.lang, ['de', 'en']),
    agent: shortAgent(String(req.headers['user-agent'] || '')),
  };
  const t = Date.now();
  // gleicher Fehler vom gleichen Browser: nur mitzählen statt neu eintragen
  const same = reports.find((x) => x.message === r.message && x.source === r.source && x.line === r.line && x.agent === r.agent);
  if (same) {
    same.count++;
    same.lastAt = t;
    return { ok: true };
  }
  reports.push({ ...r, at: t, lastAt: t, count: 1 });
  if (reports.length > MAX_REPORTS) reports.shift();
  const where = r.source ? ` (${r.source}:${r.line ?? '?'}:${r.col ?? '?'})` : '';
  // alles auf eine Zeile – Zeilenumbrüche in irgendeinem Feld dürfen keine gefälschten Log-Zeilen erzeugen
  console.warn(`[Handy-Fehler] ${r.page || '?'} ${r.agent}: ${r.message}${where}`.replace(/[\r\n]+/g, ' ⏎ '));
  return { ok: true };
});

route('GET', '/api/admin/client-errors', (req) => {
  requireStaff(req);
  return [...reports].sort((a, b) => b.lastAt - a.lastAt);
});

route('DELETE', '/api/admin/client-errors', (req) => {
  requireAdmin(req);
  reports.length = 0;
  return { ok: true };
});
