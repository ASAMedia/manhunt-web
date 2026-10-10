'use strict';

// Einrichtungs-Check für die Spielleitung: Ist der Server bereit für den Einsatz mit Schülern?
// Prüft Konfiguration und – anhand der aktuellen Anfrage – ob der Reverse Proxy HTTPS und Handy-Adressen richtig weitergibt.

const fs = require('node:fs');
const net = require('node:net');
const config = require('./config');
const { state, playersOf } = require('./store');
const { route, requireSuperAdmin, isHttps } = require('./http');
const { tileHealth } = require('./tiles');

const isInternal = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip)
  || ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);

async function setupChecks(req) {
  const checks = [];
  const add = (status, title, text) => checks.push({ status, title, text });
  const h = req.headers;

  // HTTPS – ohne HTTPS geben Handys keinen Standort frei
  if (isHttps(req)) {
    add('ok', 'HTTPS', h['x-forwarded-proto'] ? 'Der Proxy meldet eine verschlüsselte Verbindung.'
      : 'Über PUBLIC_URL erkannt. Der Proxy sendet kein X-Forwarded-Proto – besser ergänzen (dann stimmt es auch bei anderer Adresse).');
  } else {
    add('warn', 'HTTPS', 'Diese Anfrage kam nicht über HTTPS. Handys geben den Standort nur über HTTPS frei – den Proxy auf HTTPS einrichten und „X-Forwarded-Proto: https“ weitergeben (oder PUBLIC_URL=https://… setzen).');
  }

  // Öffentliche Adresse für QR-Codes
  const host = h['x-forwarded-host'] || h.host || '';
  if (!config.PUBLIC_URL) {
    add('warn', 'Öffentliche Adresse', 'PUBLIC_URL ist leer – QR-Codes zeigen dann auf die Adresse, über die gerade die Admin-Seite offen ist. PUBLIC_URL=https://… in der .env setzen.');
  } else if (!config.PUBLIC_URL.startsWith('https://')) {
    add('warn', 'Öffentliche Adresse', `PUBLIC_URL (${config.PUBLIC_URL}) beginnt nicht mit https:// – Handys könnten dann keinen Standort freigeben.`);
  } else if (new URL(config.PUBLIC_URL).host !== host) {
    add('info', 'Öffentliche Adresse', `QR-Codes zeigen auf ${config.PUBLIC_URL}; diese Seite ist gerade über „${host}“ geöffnet. Passt, wenn beides derselbe Server ist.`);
  } else {
    add('ok', 'Öffentliche Adresse', `QR-Codes zeigen auf ${config.PUBLIC_URL}.`);
  }

  // Handy-Adressen über den Proxy (für die Anfrage-Limits pro Gerät/Netz)
  const xff = String(h['x-forwarded-for'] || '').split(',').at(-1).trim();
  if (!config.TRUST_PROXY) {
    add('info', 'Adressen hinter dem Proxy', 'TRUST_PROXY ist aus – in Ordnung, wenn kein Proxy davor läuft.');
  } else if (!net.isIP(xff)) {
    add('warn', 'Adressen hinter dem Proxy', 'Der Proxy übermittelt die Adresse der Geräte nicht (X-Forwarded-For fehlt). Dann teilen sich alle Handys ein gemeinsames Anfrage-Limit. Im Proxy X-Forwarded-For anhängen lassen (nginx: $proxy_add_x_forwarded_for).');
  } else if (isInternal(xff)) {
    add('info', 'Adressen hinter dem Proxy', `Deine Adresse wird als ${xff} erkannt – eine interne Adresse. Normal, wenn du im selben Netz wie der Server bist; sonst steht noch ein Proxy davor, der die echte Adresse nicht weitergibt.`);
  } else {
    add('ok', 'Adressen hinter dem Proxy', `Deine Adresse wird als ${xff} erkannt – der Proxy gibt die Geräte-Adressen richtig weiter.`);
  }

  add(config.ADMIN_PASSWORD.length >= 12 ? 'ok' : 'warn', 'Passwort der Spielleitung',
    config.ADMIN_PASSWORD.length >= 12 ? 'Mindestens 12 Zeichen.' : `Nur ${config.ADMIN_PASSWORD.length} Zeichen – für den Betrieb im Internet ein längeres ADMIN_PASSWORD wählen (mind. 12).`);
  add(config.SUPERVISOR_PASSWORD ? 'ok' : 'info', 'Aufsicht',
    config.SUPERVISOR_PASSWORD ? 'Zugang für eine zweite Aufsichtsperson ist eingerichtet.' : 'Kein Aufsicht-Zugang (optional: SUPERVISOR_PASSWORD).');

  // Datenschutz-Angaben für /datenschutz
  const missing = [!config.PRIVACY_CONTROLLER && 'PRIVACY_CONTROLLER (Schule)', !config.PRIVACY_CONTACT && 'PRIVACY_CONTACT (Datenschutz-Kontakt)'].filter(Boolean);
  add(missing.length ? 'warn' : 'ok', 'Datenschutz-Angaben',
    missing.length ? `Fehlt in der .env: ${missing.join(', ')}. Ohne diese Angaben zeigt /datenschutz nur allgemeine Formulierungen.`
      : 'Schule und Datenschutz-Kontakt stehen auf der Datenschutz-Seite.');
  add(config.PRIVACY_HOSTING ? 'ok' : 'info', 'Hosting-Anbieter',
    config.PRIVACY_HOSTING ? `Auf der Datenschutz-Seite: ${config.PRIVACY_HOSTING}.` : 'PRIVACY_HOSTING ist leer – richtig nur, wenn der Server bei dir oder der Schule steht (sonst Anbieter und Standort eintragen).');
  add(config.AUTO_DELETE_DAYS > 0 ? 'ok' : 'warn', 'Automatisches Löschen',
    config.AUTO_DELETE_DAYS > 0 ? `Räume werden ${config.AUTO_DELETE_DAYS} Tage nach der letzten Aktivität gelöscht.` : 'Ist aus (AUTO_DELETE_DAYS=0) – dann Räume nach der Fahrt selbst löschen.');

  // Karten und Speicher
  const tiles = await tileHealth();
  add(tiles.ok === false ? 'warn' : tiles.ok ? 'ok' : 'info', 'Karte', tiles.text);
  try {
    fs.accessSync(config.DATA_DIR, fs.constants.W_OK);
    add('ok', 'Speicher', 'Spielstände werden gespeichert (Datenordner beschreibbar).');
  } catch {
    add('warn', 'Speicher', `Der Datenordner ${config.DATA_DIR} ist nicht beschreibbar – Spielstände gehen bei einem Neustart verloren.`);
  }

  // Liegengebliebene Test-Geräte
  const withBots = Object.values(state.rooms).filter((r) => playersOf(r).some((p) => p.bot)).map((r) => `„${r.name}“`);
  add(withBots.length ? 'warn' : 'ok', 'Test-Geräte',
    withBots.length ? `Test-Geräte in ${withBots.join(', ')} – vor dem echten Spiel entfernen (Probespiel → Test-Geräte entfernen).` : 'Keine Test-Geräte in den Räumen.');

  // Lehrkräfte-Konten
  const users = Object.values(state.users);
  const pending = users.filter((u) => u.status === 'pending').length;
  const active = users.filter((u) => u.status === 'active').length;
  add(pending ? 'warn' : 'info', 'Lehrkräfte-Konten',
    `${active} aktiv${pending ? `, ${pending} ${pending === 1 ? 'wartet' : 'warten'} auf Freigabe (Räume → Konten)` : ''} · Registrierung ${state.platform.registrationOpen ? 'offen (/registrieren)' : 'geschlossen'}.`);
  add(config.ADMIN_EMAIL && config.SMTP_HOST ? 'ok' : 'info', 'E-Mail bei Registrierungen',
    config.ADMIN_EMAIL && config.SMTP_HOST
      ? `Neue Registrierungen gehen per Mail an ${config.ADMIN_EMAIL} (Test-Mail unter Räume → Konten).`
      : 'Aus. Für eine Mail bei jeder neuen Registrierung ADMIN_EMAIL und SMTP_HOST, SMTP_USER, SMTP_PASS in der .env setzen.');
  if (users.length && !config.PRIVACY_OPERATOR) {
    add('info', 'Betreiber-Angabe', 'Nutzen Lehrkräfte anderer Schulen die Plattform, PRIVACY_OPERATOR in der .env setzen (Betreiber der Plattform, z. B. Name und Anschrift) – er steht dann auf deren Datenschutz-Seite. Mit jeder Schule einen Vertrag zur Auftragsverarbeitung schließen.');
  }

  add('info', 'Automatische Updates', 'Während der Fahrt ausschalten: autoupdate aus COMPOSE_PROFILES in der .env nehmen und docker compose rm -sf autoupdate ausführen.');
  return checks;
}

route('GET', '/api/admin/setup-check', async (req) => {
  requireSuperAdmin(req);
  return { checks: await setupChecks(req), serverTime: Date.now(), version: config.VERSION, build: config.BUILD };
});
