// Automatisches Löschen: sehr kurze Frist, der Aufräumlauf beim Neustart löscht alte Räume (laufende nie)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { client, sleep, startServer } from './lib.mjs';

export default async function autodelete({ adminPass, check, section }) {
  section('Automatisches Löschen');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-autodel-'));
  const env = (days) => ({ ADMIN_PASSWORD: adminPass, SUPERVISOR_PASSWORD: '', DATA_DIR: dataDir, AUTO_DELETE_DAYS: days, TILE_PROXY: '0' });
  const names = async (req) => (await req('GET', '/api/admin/rooms', undefined, { admin: true })).data.map((r) => r.name).sort();

  // Frist 0,00002 Tage ≈ 1,7 s
  let srv = await startServer(env('0.00002'));
  let req = client(srv.base);
  await req('POST', '/api/admin/login', { password: adminPass });
  await req('POST', '/api/admin/rooms', { name: 'Alt-Lobby' }, { admin: true });
  const run = (await req('POST', '/api/admin/rooms', { name: 'Läuft' }, { admin: true })).data;
  for (const n of ['A', 'B']) await req('POST', `/api/join/${run.code}`, { name: n });
  await req('POST', `/api/admin/rooms/${run.id}/draw`, { runners: 1 }, { admin: true });
  await req('POST', `/api/admin/rooms/${run.id}/start`, undefined, { admin: true });
  check((await names(req)).join() === 'Alt-Lobby,Läuft', 'zwei Räume angelegt');
  await sleep(3500); // regelmäßiges Speichern abwarten (unter Windows beendet kill den Server hart)
  await srv.stop();
  await sleep(1500);

  srv = await startServer(env('0.00002'));
  req = client(srv.base);
  await req('POST', '/api/admin/login', { password: adminPass });
  check((await names(req)).join() === 'Läuft', 'alter Lobby-Raum gelöscht, laufendes Spiel bleibt');
  check(srv.output().includes('„Alt-Lobby“ automatisch gelöscht'), 'Löschung im Server-Log');
  await srv.stop();

  srv = await startServer(env('0'));
  req = client(srv.base);
  await req('POST', '/api/admin/login', { password: adminPass });
  check((await names(req)).join() === 'Läuft' && srv.output().includes('Automatisches Löschen ist aus'), 'AUTO_DELETE_DAYS=0 schaltet das Löschen ab');
  await srv.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
