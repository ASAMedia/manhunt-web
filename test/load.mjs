// Last- und Dauertest: simuliert viele Handys, die wie die echte Spielerseite abfragen und Standorte senden,
// dazu eine Spielleitung mit offener Admin-Seite. Misst Antwortzeiten, Fehler sowie CPU und Speicher des Servers.
//
//   npm run loadtest                                   eigener Test-Server, 60 Handys, 30 Minuten
//   npm run loadtest -- --phones 120 --minutes 10      mehr Handys, kürzer
//   LOAD_ADMIN_PASSWORD=… npm run loadtest -- --base http://localhost:3000 --container manhunt-web-app-1
//                                                      gegen einen laufenden Server/Docker-Container
//
// Beendet sich mit Code 1, wenn mehr als 0,5 % der Anfragen fehlschlagen oder das 95. Perzentil über 500 ms liegt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startServer, sleep } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map((a) => {
  const [k, ...v] = a.trim().split(/\s+/);
  return [k, v.join(' ') || true];
}));
const PHONES = Number(args.phones) || 60;
const MINUTES = Number(args.minutes) || 30;
const ROOMS = Number(args.rooms) || 2;
const REPORT_EVERY = 60e3;
const CENTER = { lat: 52.5163, lng: 13.3777 };

// --- Server ------------------------------------------------------------------

let base = args.base;
let password = process.env.LOAD_ADMIN_PASSWORD;
let srv = null;
let dataDir = null;
if (!base) {
  password = `last-${crypto.randomBytes(9).toString('base64url')}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-load-'));
  srv = await startServer({ ADMIN_PASSWORD: password, DATA_DIR: dataDir, TILE_PROXY: '0', AUTO_DELETE_DAYS: '0' });
  base = srv.base;
} else if (!password) {
  console.error('Für --base bitte LOAD_ADMIN_PASSWORD setzen.');
  process.exit(2);
}

// --- Messung -------------------------------------------------------------------

const stats = new Map(); // Art -> { times: [], errors: 0 }
let win = new Map();
function record(kind, ms, ok) {
  for (const m of [stats, win]) {
    if (!m.has(kind)) m.set(kind, { times: [], errors: 0 });
    const s = m.get(kind);
    s.times.push(ms);
    if (!ok) s.errors++;
  }
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
function table(map, seconds) {
  const rows = [];
  let all = [];
  let errors = 0;
  for (const [kind, s] of [...map].sort()) {
    const t = [...s.times].sort((a, b) => a - b);
    all = all.concat(s.times);
    errors += s.errors;
    rows.push(`  ${kind.padEnd(14)} ${String(t.length).padStart(7)}  ${(t.length / seconds).toFixed(1).padStart(6)}/s  p50 ${String(pct(t, 50)).padStart(4)} ms  p95 ${String(pct(t, 95)).padStart(4)} ms  p99 ${String(pct(t, 99)).padStart(4)} ms  max ${String(t.at(-1) ?? 0).padStart(5)} ms  Fehler ${s.errors}`);
  }
  all.sort((a, b) => a - b);
  return { text: rows.join('\n'), total: all.length, errors, p95: pct(all, 95), p99: pct(all, 99) };
}

let cookie = '';
async function call(kind, method, url, body, headers = {}) {
  const h = { 'X-Requested-With': 'manhunt', ...headers };
  if (cookie && url.startsWith('/api/admin')) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const t0 = performance.now();
  try {
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    record(kind, Math.round(performance.now() - t0), res.ok || res.status === 409);
    if (!res.ok && res.status !== 409) lastErrors.push(`${kind} ${res.status} ${data?.error || ''}`);
    return { status: res.status, data };
  } catch (e) {
    record(kind, Math.round(performance.now() - t0), false);
    lastErrors.push(`${kind} ${e.name}: ${e.message}`);
    return { status: 0, data: null };
  }
}
let lastErrors = [];

// CPU und Speicher des Servers: eigener Prozess (Windows/Linux) oder Docker-Container
const resources = [];
function sampleResources() {
  return new Promise((resolve) => {
    const done = (r) => { if (r) resources.push({ at: Date.now(), ...r }); resolve(r); };
    if (args.container) {
      execFile('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}};{{.MemUsage}}', args.container], (err, out) => {
        if (err) return done(null);
        const [cpu, mem] = out.trim().split(';');
        done({ cpu: parseFloat(cpu), memMb: parseMem(mem.split('/')[0]) });
      });
    } else if (srv?.pid && process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${srv.pid}; "$($p.CPU);$($p.WorkingSet64)"`], (err, out) => {
        if (err) return done(null);
        const [cpuSec, ws] = out.trim().replace(',', '.').split(';');
        done({ cpuSec: parseFloat(cpuSec), memMb: Math.round(Number(ws) / 1048576) });
      });
    } else if (srv?.pid && process.platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${srv.pid}/stat`, 'utf8').split(') ')[1].split(' ');
        const status = fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8');
        done({ cpuSec: (Number(stat[11]) + Number(stat[12])) / 100, memMb: Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)[1]) / 1024) });
      } catch { done(null); }
    } else done(null);
  });
}
const parseMem = (s) => {
  const n = parseFloat(s);
  return /GiB/.test(s) ? Math.round(n * 1024) : /KiB/.test(s) ? Math.round(n / 1024) : Math.round(n);
};
function cpuPercent(a, b) {
  if (!a || !b) return null;
  if (b.cpu != null) return b.cpu;
  const v = Math.round(((b.cpuSec - a.cpuSec) / ((b.at - a.at) / 1000)) * 1000) / 10;
  return Number.isFinite(v) ? v : null;
}

// --- Aufbau: Spielleitung legt Räume an, Handys treten bei --------------------------------

const walk = (p, meters) => {
  const b = Math.random() * 2 * Math.PI;
  return { lat: p.lat + (meters * Math.cos(b)) / 111320, lng: p.lng + (meters * Math.sin(b)) / (111320 * Math.cos((p.lat * Math.PI) / 180)) };
};

console.log(`Lasttest: ${PHONES} Handys in ${ROOMS} Räumen, ${MINUTES} Minuten gegen ${base}`);
if ((await call('login', 'POST', '/api/admin/login', { password })).status !== 200) {
  console.error('Anmeldung fehlgeschlagen – Passwort prüfen.');
  process.exit(2);
}
const rooms = [];
for (let r = 0; r < ROOMS; r++) {
  const room = (await call('admin', 'POST', '/api/admin/rooms', { name: `Lasttest ${r + 1}` })).data;
  await call('admin', 'PATCH', `/api/admin/rooms/${room.id}`, {
    settings: {
      zone: { ...CENTER, radius: 2000 }, pingIntervalMin: 1, headStartMin: 0, durationMin: MINUTES + 10,
      extraPings: 50, transportReports: true, signalAlarmMin: 1,
    },
  });
  rooms.push(room);
}
const phones = [];
for (let i = 0; i < PHONES; i++) {
  const room = rooms[i % ROOMS];
  const res = await call('join', 'POST', `/api/join/${room.code}`, { name: `Handy ${i + 1}` });
  if (!res.data?.token) { console.error('Beitritt fehlgeschlagen:', res.status, res.data); process.exit(1); }
  phones.push({ room, token: res.data.token, name: `Handy ${i + 1}`, pos: walk(CENTER, Math.random() * 1500), lastSent: 0, sentPos: null, S: null });
}
// ungefähr jedes dritte Handy ist gejagt, der Rest Jäger-Teams
for (const room of rooms) await call('admin', 'POST', `/api/admin/rooms/${room.id}/draw`, { runners: Math.max(1, Math.round(PHONES / ROOMS / 3)) });
for (const room of rooms) await call('admin', 'POST', `/api/admin/rooms/${room.id}/start`);

// --- Ein Handy: so oft abfragen und senden wie die echte Spielerseite ------------------------

const end = Date.now() + MINUTES * 60e3;
let running = true;

async function phoneLoop(p) {
  const auth = { 'X-Player-Token': p.token };
  await sleep(Math.random() * 3000);
  let nextPoll = 0;
  while (running && Date.now() < end) {
    const t = Date.now();
    p.pos = walk(p.pos, 1.4 * (0.5 + Math.random())); // gehen, ~1,4 m/s
    if (t >= nextPoll) {
      const r = await call('state', 'GET', '/api/play/state', undefined, auth);
      if (r.status === 200) p.S = r.data;
      const role = p.S?.me.role;
      nextPoll = Date.now() + (p.S?.room.status === 'running' ? (role === 'hunter' ? 3000 : 5000) : 5000);
      // ab und zu eine Aktion wie im echten Spiel
      if (role === 'hunter' && Math.random() < 0.002) await call('extra-ping', 'POST', '/api/play/extra-ping', undefined, auth);
      if (role === 'runner' && Math.random() < 0.01) {
        await call('transport', 'POST', '/api/play/transport', { mode: ['U', 'S', 'Bus', 'Tram', 'Fuss'][Math.floor(Math.random() * 5)] }, auth);
      }
    }
    // Sende-Regeln wie play.js: Herzschlag 20 s, bei Bewegung ab 15 m alle 5 s, Gejagte kurz vor dem Ping alle 3 s
    const role = p.S?.me.role;
    const left = (p.S?.room.nextPingAt ?? 0) - t;
    const nearPing = role === 'runner' && left > -3000 && left < 30000;
    const since = t - p.lastSent;
    const moved = p.sentPos ? Math.hypot((p.pos.lat - p.sentPos.lat) * 111320, (p.pos.lng - p.sentPos.lng) * 67800) : Infinity;
    if (since >= (nearPing ? 3000 : 20000) || (since >= (nearPing ? 3000 : 5000) && moved >= (nearPing ? 0 : 15))) {
      p.lastSent = t;
      p.sentPos = { ...p.pos };
      await call('pos', 'POST', '/api/play/pos', { ...p.pos, acc: 8 + Math.round(Math.random() * 20), battery: 0.8, charging: false }, auth);
    }
    await sleep(1000);
  }
}

async function adminLoop() {
  while (running && Date.now() < end) {
    for (const room of rooms) await call('admin-room', 'GET', `/api/admin/rooms/${room.id}`);
    await call('admin-alerts', 'GET', '/api/admin/alerts');
    await sleep(3000);
  }
}

// --- Zwischenberichte ---------------------------------------------------------------------

const started = Date.now();
await sampleResources();
const reporter = setInterval(async () => {
  const r = await sampleResources();
  const prevRes = resources.at(-2);
  const tbl = table(win, REPORT_EVERY / 1000);
  const minute = Math.round((Date.now() - started) / 60e3);
  console.log(`\n[Minute ${minute}] ${tbl.total} Anfragen, ${tbl.errors} Fehler, p95 ${tbl.p95} ms`
    + (r ? ` · Server: CPU ${cpuPercent(prevRes, r) ?? '?'} %, RAM ${r.memMb} MB` : ''));
  console.log(tbl.text);
  if (lastErrors.length) console.log('  letzte Fehler:', [...new Set(lastErrors)].slice(-5).join(' | '));
  lastErrors = [];
  win = new Map();
}, REPORT_EVERY);

await Promise.all([...phones.map(phoneLoop), adminLoop()]);
running = false;
clearInterval(reporter);

// --- Ergebnis -------------------------------------------------------------------------------

await sampleResources();
const seconds = (Date.now() - started) / 1000;
const sum = table(stats, seconds);
const errRate = sum.errors / Math.max(1, sum.total);
console.log(`\n=== Ergebnis nach ${(seconds / 60).toFixed(1)} Minuten, ${PHONES} Handys ===`);
console.log(sum.text);
console.log(`  gesamt ${sum.total} Anfragen (${(sum.total / seconds).toFixed(1)}/s), Fehlerquote ${(errRate * 100).toFixed(2)} %, p95 ${sum.p95} ms, p99 ${sum.p99} ms`);
if (resources.length > 1) {
  const first = resources[0], last = resources.at(-1);
  const mems = resources.map((x) => x.memMb);
  const cpus = resources.slice(1).map((x, i) => cpuPercent(resources[i], x)).filter((x) => x != null);
  console.log(`  Server-RAM: Start ${first.memMb} MB, Ende ${last.memMb} MB, max ${Math.max(...mems)} MB`);
  if (cpus.length) console.log(`  Server-CPU: Mittel ${(cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(1)} %, max ${Math.max(...cpus)} % (eines Kerns)`);
}
if (dataDir) {
  const f = path.join(dataDir, 'state.json');
  console.log(`  state.json zuletzt ${fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) : '?'} KB`);
}
const pings = [];
for (const room of rooms) {
  const r = (await call('admin', 'GET', `/api/admin/rooms/${room.id}`)).data;
  pings.push(`${room.name}: ${r?.pings?.length ?? '?'} Pings (letzte 10), Status ${r?.status}`);
  await call('admin', 'DELETE', `/api/admin/rooms/${room.id}`);
}
console.log(`  ${pings.join(' · ')}`);
if (srv) {
  await srv.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
const ok = errRate <= 0.005 && sum.p95 <= 500;
console.log(ok ? '\nBESTANDEN' : '\nNICHT BESTANDEN (Fehlerquote > 0,5 % oder p95 > 500 ms)');
process.exit(ok ? 0 : 1);
