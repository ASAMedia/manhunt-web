'use strict';

// E-Mail an den Admin (z. B. bei neuen Registrierungen) über ein vorhandenes Mail-Konto (SMTP).
// Ohne SMTP_HOST und ADMIN_EMAIL ist der Versand aus – dann bleibt nur der Hinweis in der Admin-Seite.
// checkMail() prüft die Einstellungen Schritt für Schritt und erklärt Fehler (Mail-Prüfung im Admin-Bereich).

const nodemailer = require('nodemailer');
const config = require('./config');

const MAX_PER_HOUR = 10; // gegen Mail-Fluten, falls jemand massenhaft Registrierungen anlegt

const enabled = () => !!(config.SMTP_HOST && config.ADMIN_EMAIL);
const isLocal = (host) => ['localhost', '127.0.0.1', '::1'].includes(host);
const sender = () => config.SMTP_FROM || config.SMTP_USER || config.ADMIN_EMAIL;

let transport = null;
function getTransport() {
  transport ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,         // 465 = TLS von Anfang an, sonst STARTTLS
    requireTLS: !isLocal(config.SMTP_HOST),   // Passwort nie unverschlüsselt übers Netz
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    connectionTimeout: 10e3,
    greetingTimeout: 10e3,
    socketTimeout: 20e3,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return transport;
}

let window = { start: 0, n: 0 };
let last = null; // letzte Benachrichtigung: { at, ok, subject, error }

async function deliver(subject, text) {
  await getTransport().sendMail({ from: sender(), to: config.ADMIN_EMAIL, subject, text });
}

// Benachrichtigung im Hintergrund: Die Anfrage wartet nicht darauf, Fehler stehen im Protokoll und in der Mail-Prüfung.
// Mehr als MAX_PER_HOUR pro Stunde werden nicht verschickt (die Registrierungen selbst stehen trotzdem unter „Konten“).
function notifyAdmin(subject, text) {
  if (!enabled()) return;
  const t = Date.now();
  if (t - window.start > 3600e3) window = { start: t, n: 0 };
  if (++window.n > MAX_PER_HOUR) {
    console.error(`E-Mail an den Admin übersprungen: mehr als ${MAX_PER_HOUR} in einer Stunde (Registrierungen stehen unter „Konten“).`);
    last = { at: t, ok: false, subject, error: `Übersprungen – mehr als ${MAX_PER_HOUR} Mails in einer Stunde.` };
    return;
  }
  deliver(subject, text)
    .then(() => { last = { at: Date.now(), ok: true, subject }; })
    .catch((e) => {
      console.error('E-Mail an den Admin fehlgeschlagen:', e.message);
      last = { at: Date.now(), ok: false, subject, error: explain(e) };
    });
}

// Fehler des Mailservers in verständliche Hinweise übersetzen
function explain(e) {
  const host = config.SMTP_HOST;
  const port = config.SMTP_PORT;
  const msg = String(e?.message || e);
  const code = e?.code || '';
  const rc = Number(e?.responseCode) || 0;
  const provider = /web\.de$/i.test(host) ? 'web.de: unter Einstellungen → POP3/IMAP Abruf „POP3 und IMAP Zugriff erlauben“ einschalten.'
    : /gmx\.(net|de|com)$/i.test(host) ? 'GMX: unter E-Mail → Einstellungen → POP3/IMAP Abruf den Zugriff erlauben.'
      : /gmail\.com$|googlemail\.com$/i.test(host) ? 'Gmail: ein App-Passwort verwenden (Google-Konto → Sicherheit → App-Passwörter), nicht das normale Passwort.'
        : /office365|outlook/i.test(host) ? 'Microsoft 365/Outlook: „Authentifiziertes SMTP“ muss für das Postfach erlaubt sein.' : '';
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return `Der Mailserver „${host}“ wurde nicht gefunden – SMTP_HOST prüfen (z. B. smtp.web.de).`;
  if (/ECONNREFUSED/.test(msg)) return `Verbindung zu ${host}:${port} abgelehnt – SMTP_PORT prüfen (587 für STARTTLS, 465 für SSL).`;
  if (code === 'EAUTH' || rc === 535 || rc === 534) {
    return `Anmeldung abgelehnt – SMTP_USER und SMTP_PASS prüfen.${provider ? ` ${provider}` : ''} (Meldung des Servers: ${msg})`;
  }
  if (/wrong version number|EPROTO|ssl3_get_record|unknown protocol/i.test(msg)) {
    return 'Verschlüsselung passt nicht zum Port: Port 587 nutzt STARTTLS, Port 465 SSL – SMTP_PORT prüfen.';
  }
  if (code === 'ETLS' || /certificate|self.signed|STARTTLS/i.test(msg)) {
    return `Verschlüsselte Verbindung zu ${host} nicht möglich (${msg}). Ohne Verschlüsselung schickt der Server das Passwort nicht – anderen Port (587/465) oder Mailserver nehmen.`;
  }
  if (code === 'ETIMEDOUT' || /Greeting never received|timeout|timed out/i.test(msg)) {
    return `Keine Antwort von ${host}:${port}. Häufig: falscher Port (587 und 465 vertauscht) oder der Hosting-Anbieter sperrt ausgehende Mail-Ports – dann dort nachfragen.`;
  }
  if (code === 'EENVELOPE' || [550, 551, 553, 554].includes(rc)) {
    if (/sender|from|absender/i.test(msg) || e?.command === 'MAIL FROM') {
      return `Absender „${sender()}“ abgelehnt – die meisten Anbieter erlauben nur die eigene Adresse: SMTP_FROM leer lassen oder gleich SMTP_USER setzen.`;
    }
    return `Empfänger oder Nachricht abgelehnt – ADMIN_EMAIL prüfen (${msg}).`;
  }
  return msg;
}

// Einstellungen (ohne Passwort) und Stand der letzten Benachrichtigung – für die Mail-Prüfung
function status() {
  const missing = [!config.ADMIN_EMAIL && 'ADMIN_EMAIL', !config.SMTP_HOST && 'SMTP_HOST'].filter(Boolean);
  return {
    enabled: enabled(),
    missing,
    to: config.ADMIN_EMAIL || null,
    host: config.SMTP_HOST || null,
    port: config.SMTP_PORT,
    encryption: config.SMTP_PORT === 465 ? 'SSL/TLS (Port 465)' : isLocal(config.SMTP_HOST) ? 'keine (lokaler Mailserver)' : 'STARTTLS (Pflicht)',
    user: config.SMTP_USER || null,
    passwordSet: !!config.SMTP_PASS,
    from: enabled() ? sender() : null,
    sentThisHour: Date.now() - window.start > 3600e3 ? 0 : Math.min(window.n, MAX_PER_HOUR),
    maxPerHour: MAX_PER_HOUR,
    last,
  };
}

// Schrittweise Prüfung: Einstellungen → Verbindung und Anmeldung (ohne zu senden) → auf Wunsch Test-Mail
async function checkMail({ send = false } = {}) {
  const steps = [];
  const s = status();
  if (!s.enabled) {
    steps.push({ step: 'Einstellungen', ok: false, text: `Fehlt in der .env: ${s.missing.join(', ')}. Danach den Container neu starten (docker compose up -d).` });
    return { status: s, steps, ok: false };
  }
  const warn = [];
  if (!s.user) warn.push('ohne Anmeldung (SMTP_USER leer) – das erlauben fast nur eigene Mailserver');
  if (s.user && !s.passwordSet) warn.push('SMTP_PASS ist leer');
  steps.push({ step: 'Einstellungen', ok: true, text: `Mail an ${s.to} über ${s.host}:${s.port}${warn.length ? ` – Achtung: ${warn.join(', ')}` : ''}.` });
  try {
    await getTransport().verify();
    steps.push({ step: 'Verbindung und Anmeldung', ok: true, text: `${s.host} erreichbar, ${s.encryption}${s.user ? `, angemeldet als ${s.user}` : ''}.` });
  } catch (e) {
    steps.push({ step: 'Verbindung und Anmeldung', ok: false, text: explain(e) });
    return { status: status(), steps, ok: false };
  }
  if (send) {
    try {
      await deliver('Manhunt: Test-Mail', `Diese Test-Mail zeigt: Benachrichtigungen bei neuen Registrierungen kommen an.\n\nAbsender: ${s.from}\nMailserver: ${s.host}:${s.port}`);
      steps.push({ step: 'Test-Mail', ok: true, text: `An ${s.to} verschickt – im Posteingang (und Spam-Ordner) nachsehen.` });
    } catch (e) {
      steps.push({ step: 'Test-Mail', ok: false, text: explain(e) });
      return { status: status(), steps, ok: false };
    }
  }
  return { status: status(), steps, ok: true };
}

module.exports = { enabled, notifyAdmin, checkMail, status, explain };
