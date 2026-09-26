// Startet einen Test-Server (freier Port, eigener Datenordner, Schein-Kartenserver) und führt alle Tests aus.
//   npm test
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, tileMock, results } from './lib.mjs';
import basics from './basics.test.mjs';
import features from './features.test.mjs';
import extras from './extras.test.mjs';
import autodelete from './autodelete.test.mjs';
import golive from './golive.test.mjs';

const r = results();
const secret = () => crypto.randomBytes(9).toString('base64url');
const adminPass = `admin-${secret()}`;
const supPass = `aufsicht-${secret()}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-test-'));
const tiles = await tileMock();

const srv = await startServer({
  ADMIN_PASSWORD: adminPass,
  SUPERVISOR_PASSWORD: supPass,
  DATA_DIR: dataDir,
  AUTO_DELETE_DAYS: '7',
  TILE_URL: `${tiles.base}/{z}/{x}/{y}.png`,
  TILE_PROXY: '1',
  MAP_CENTER: '52.517,13.3889',
  TRUST_PROXY: '1', // wie in docker-compose.yml
});

const ctx = { base: srv.base, adminPass, supPass, check: r.check, section: r.section, tiles };
for (const [name, suite] of [['Grundfunktionen', basics], ['Neue Funktionen', features], ['Blocks, Check, App, Karten', extras], ['Vor dem Live-Gang', golive]]) {
  r.suite(name);
  try {
    await suite(ctx);
  } catch (e) {
    r.fail(`${name} abgebrochen: ${e.stack}`);
  }
}
await srv.stop();
tiles.close();

r.suite('Automatisches Löschen');
try {
  await autodelete(ctx);
} catch (e) {
  r.fail(`Automatisches Löschen abgebrochen: ${e.stack}`);
}

fs.rmSync(dataDir, { recursive: true, force: true });
r.summary();
process.exit(r.failures ? 1 : 0);
