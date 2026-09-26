// Hilfen für die Tests: Server starten, Anfragen mit Anmeldung, Schein-Kartenserver, Ergebnisse zählen
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Startet server.js mit eigener Konfiguration auf einem freien Port
export async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* startet noch */ }
    if (child.exitCode !== null) throw new Error(`Server beendet sich sofort:\n${output}`);
    await sleep(100);
  }
  return {
    base,
    pid: child.pid,
    output: () => output,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }),
  };
}

// Anfragen wie der Browser: getrennte Anmeldungen (Cookies) für Spielleitung und Aufsicht
export function client(base) {
  const jar = {};
  return async function req(method, url, body, { admin = false, as, token, noHeader = false, headers: extra = {} } = {}) {
    const who = as || (admin ? 'admin' : null);
    const headers = { ...extra };
    if (!noHeader) headers['X-Requested-With'] = 'manhunt';
    if (who && jar[who]) headers.Cookie = jar[who];
    if (token) headers['X-Player-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) jar[who || 'admin'] = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const binary = ct.startsWith('image/') && !ct.includes('svg');
    const data = ct.includes('json') ? await res.json() : binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, ct };
  };
}

// Schein-Kartenserver: liefert für jede Kachel ein winziges PNG und zählt die Abrufe
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64',
);
export function tileMock() {
  return new Promise((resolve) => {
    const mock = { hits: 0 };
    const srv = http.createServer((req, res) => {
      mock.hits++;
      mock.lastUserAgent = req.headers['user-agent'];
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_1PX);
    });
    srv.listen(0, '127.0.0.1', () => {
      mock.base = `http://127.0.0.1:${srv.address().port}`;
      mock.close = () => srv.close();
      resolve(mock);
    });
  });
}

export function results() {
  let failures = 0;
  let passed = 0;
  return {
    get failures() { return failures; },
    suite: (name) => console.log(`\n=== ${name} ===`),
    section: (name) => console.log(`\n${name}`),
    check(cond, label, extra) {
      if (cond) { passed++; console.log('  ok  ', label); } else {
        failures++;
        console.log('  FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
      }
    },
    fail(msg) { failures++; console.log('  FAIL', msg); },
    summary() {
      console.log(failures ? `\n${failures} FEHLER, ${passed} bestanden` : `\nAlle ${passed} Prüfungen bestanden`);
    },
  };
}
