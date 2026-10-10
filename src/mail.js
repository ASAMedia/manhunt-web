'use strict';

// E-Mail an den Admin (z. B. bei neuen Registrierungen) über ein vorhandenes Mail-Konto (SMTP).
// Ohne SMTP_HOST und ADMIN_EMAIL ist der Versand aus – dann bleibt nur der Hinweis in der Admin-Seite.

const nodemailer = require('nodemailer');
const config = require('./config');

const MAX_PER_HOUR = 10; // gegen Mail-Fluten, falls jemand massenhaft Registrierungen anlegt

const enabled = () => !!(config.SMTP_HOST && config.ADMIN_EMAIL);
const isLocal = (host) => ['localhost', '127.0.0.1', '::1'].includes(host);

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

// Schickt eine Mail an ADMIN_EMAIL. Wirft bei Fehlern (für die Test-Mail); fürs Hintergrund-Senden notifyAdmin().
async function sendAdminMail(subject, text) {
  if (!enabled()) throw new Error('E-Mail ist nicht eingerichtet (SMTP_HOST und ADMIN_EMAIL in der .env).');
  const t = Date.now();
  if (t - window.start > 3600e3) window = { start: t, n: 0 };
  if (++window.n > MAX_PER_HOUR) throw new Error(`Mehr als ${MAX_PER_HOUR} Mails in einer Stunde – weitere werden erst später verschickt.`);
  await getTransport().sendMail({
    from: config.SMTP_FROM || config.SMTP_USER || config.ADMIN_EMAIL,
    to: config.ADMIN_EMAIL,
    subject,
    text,
  });
}

// Im Hintergrund senden: Die Anfrage wartet nicht darauf, Fehler stehen nur im Server-Protokoll
function notifyAdmin(subject, text) {
  if (!enabled()) return;
  sendAdminMail(subject, text).catch((e) => console.error('E-Mail an den Admin fehlgeschlagen:', e.message));
}

module.exports = { enabled, sendAdminMail, notifyAdmin };
