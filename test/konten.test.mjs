// Lehrkräfte-Konten: Registrierung mit Freigabe, nur eigene Räume, Admin sieht alles (ohne fremde Alarme),
// Aufsicht-Link pro Raum, Datenschutz-Angaben pro Konto, Passwort-Links, Sperren und Löschen
import fs from 'node:fs';
import path from 'node:path';
import { client, sleep } from './lib.mjs';

export default async function konten({ base, adminPass, supPass, check, section, dataDir, smtp }) {
  const req = client(base);
  const A = { admin: true };
  const SUP = { as: 'sup' };
  let ip = 10;
  const from = () => ({ headers: { 'X-Forwarded-For': `198.51.100.${ip++}` } });
  await req('POST', '/api/admin/login', { password: adminPass }, from());
  await req('POST', '/api/admin/login', { password: supPass }, { ...SUP, ...from() });
  const login = (as, email, password) => req('POST', '/api/admin/login', { email, password }, { as, ...from() });
  const reg = (b) => req('POST', '/api/account/register', b, from());

  section('Registrierung und Freigabe');
  check((await req('GET', '/api/account/registration')).data.open === false, 'nach dem Update ist die Registrierung zunächst geschlossen');
  check((await reg({ name: 'Frau Früh', email: 'frueh@schule.example', org: 'Schule X', password: 'lang-genug-123' })).status === 403, 'geschlossen → Registrierung abgelehnt');
  await req('PATCH', '/api/admin/platform', { registrationOpen: true }, A);
  check((await req('GET', '/api/account/registration')).data.open === true, 'Admin öffnet die Registrierung');
  check((await req('POST', '/api/account/register', { name: 'Fremd', email: 'fremd@x.example', org: 'Schule X', password: 'lang-genug-123' }, { noHeader: true, ...from() })).status === 403,
    'Registrierung nur aus der eigenen Seite (Header) – kein Formular fremder Websites');
  check((await req('POST', '/api/admin/login', { password: adminPass }, { noHeader: true, as: 'csrf', ...from() })).status === 403, 'Anmeldung nur aus der eigenen Seite (Login-CSRF)');
  check((await reg({ name: 'Frau Kurz', email: 'kurz@schule.example', org: 'Schule X', password: 'kurz' })).status === 400, 'zu kurzes Passwort → abgelehnt');
  check((await reg({ name: 'Frau Kurz', email: 'keine-mail', org: 'Schule X', password: 'lang-genug-123' })).status === 400, 'ungültige E-Mail → abgelehnt');
  const mailsBefore = smtp.messages.length;
  const r1 = await reg({ name: 'Frau Meier', email: 'Meier@Schule-A.example ', org: 'Gymnasium A', password: 'meier-passwort-1' });
  check(r1.status === 200 && r1.data.ok, 'Frau Meier registriert');
  let mail = null;
  for (let i = 0; i < 30 && !mail; i++) { await sleep(100); mail = smtp.messages[mailsBefore]; }
  check(!!mail && mail.to.some((t) => t.includes('admin@manhunt.example')), 'Admin bekommt eine Mail zur neuen Registrierung', mail?.to);
  check(mail && /Frau Meier/.test(mail.data) && /Gymnasium A/.test(mail.data) && /meier@schule-a\.example/.test(mail.data)
    && mail.data.includes('deiner Manhunt-Seite unter /admin'), 'Mail nennt Name, Schule, E-Mail und den Link zur Freigabe', mail?.data.slice(-500));
  check(smtp.auths.at(-1)?.join('|') === 'versand@manhunt.example|smtp-geheim', 'Versand mit dem eingetragenen Mail-Konto');
  await reg({ name: 'Herr Schulz', email: 'schulz@schule-b.example', org: 'Realschule B', password: 'schulz-passwort-1' });
  const dup = await reg({ name: 'Doppelt', email: 'meier@schule-a.example', org: 'Schule X', password: 'anderes-passwort' });
  await sleep(800);
  check(smtp.messages.length === mailsBefore + 2, 'doppelte E-Mail-Adresse: keine zweite Mail', smtp.messages.length - mailsBefore);
  const usersData = (await req('GET', '/api/admin/users', undefined, A)).data;
  check(usersData.mail === 'admin@manhunt.example', 'Konten-Fenster zeigt, wohin die Mails gehen');
  const t0 = smtp.messages.length;
  check((await req('POST', '/api/admin/mail-test', undefined, A)).status === 200 && smtp.messages.length === t0 + 1
    && /Test-Mail/.test(smtp.messages.at(-1).data), 'Test-Mail an den Admin');
  check((await req('POST', '/api/admin/mail-test', undefined, SUP)).status === 403, 'Test-Mail nur durch den Admin');
  const users = usersData.users;
  check(dup.status === 200 && users.length === 2, 'doppelte E-Mail: gleiche Antwort, aber kein zweites Konto', { dup, users: users.map((u) => u.email) });
  check(users.every((u) => u.status === 'pending'), 'neue Konten warten auf Freigabe');
  check((await login('m1', 'meier@schule-a.example', 'meier-passwort-1')).status === 403, 'vor der Freigabe: Anmeldung abgelehnt (403)');
  const alerts0 = (await req('GET', '/api/admin/alerts', undefined, A)).data;
  check(alerts0.pendingAccounts === 2, 'Admin sieht wartende Registrierungen in der Alarm-Abfrage', alerts0.pendingAccounts);
  const id = (email) => users.find((u) => u.email === email).id;
  const m1Id = id('meier@schule-a.example');
  const m2Id = id('schulz@schule-b.example');
  check((await req('PATCH', `/api/admin/users/${m1Id}`, { status: 'active' }, A)).status === 200, 'Admin gibt Frau Meier frei');
  check((await req('PATCH', `/api/admin/users/${m1Id}`, { status: 'active' }, SUP)).status === 403, 'Aufsicht darf keine Konten freigeben');
  check((await login('m1', 'meier@schule-a.example', 'falsch-falsch-1')).status === 401, 'falsches Passwort → 401');
  const l1 = await login('m1', 'MEIER@schule-a.example', 'meier-passwort-1');
  check(l1.status === 200 && l1.data.role === 'admin' && l1.data.account.kind === 'manager', 'Anmeldung mit E-Mail (Groß-/Kleinschreibung egal)', l1.data);
  const sess = (await req('GET', '/api/admin/session', undefined, { as: 'm1' })).data;
  check(sess.account?.name === 'Frau Meier' && sess.account.email === 'meier@schule-a.example', 'Sitzung kennt das Konto', sess);
  await req('PATCH', `/api/admin/users/${m2Id}`, { status: 'active' }, A);
  await login('m2', 'schulz@schule-b.example', 'schulz-passwort-1');

  section('Nur eigene Räume');
  const ra = (await req('POST', '/api/admin/rooms', { name: 'Meier 10a' }, { as: 'm1' })).data;
  const rb = (await req('POST', '/api/admin/rooms', { name: 'Schulz 9b' }, { as: 'm2' })).data;
  const radm = (await req('POST', '/api/admin/rooms', { name: 'Admin-Raum' }, A)).data;
  check(ra.ownerId === m1Id && ra.ownerName === 'Frau Meier', 'Raum gehört Frau Meier', ra.ownerId);
  const listM1 = (await req('GET', '/api/admin/rooms', undefined, { as: 'm1' })).data;
  check(listM1.length === 1 && listM1[0].id === ra.id && listM1[0].own, 'Frau Meier sieht nur ihren Raum', listM1.map((r) => r.name));
  check((await req('GET', `/api/admin/rooms/${rb.id}`, undefined, { as: 'm1' })).status === 404, 'fremder Raum: 404 (nicht einmal die Existenz)');
  check((await req('PATCH', `/api/admin/rooms/${rb.id}`, { name: 'gekapert' }, { as: 'm1' })).status === 404, 'fremden Raum ändern: 404');
  check((await req('POST', `/api/admin/rooms/${rb.id}/start`, undefined, { as: 'm1' })).status === 404, 'fremden Raum starten: 404');
  check((await req('DELETE', `/api/admin/rooms/${radm.id}`, undefined, { as: 'm1' })).status === 404, 'Admin-Raum löschen: 404');
  check((await req('GET', `/api/admin/rooms/${rb.id}/export/verlauf.csv`, undefined, { as: 'm1' })).status === 404, 'fremden Verlauf exportieren: 404');
  check((await req('POST', '/api/admin/rooms', { name: 'Kopie', copyFrom: rb.id }, { as: 'm1' })).status === 404, 'fremden Raum kopieren: 404');
  const listA = (await req('GET', '/api/admin/rooms', undefined, A)).data;
  const inA = listA.find((r) => r.id === ra.id);
  check(listA.some((r) => r.id === rb.id) && inA && !inA.own && inA.ownerName === 'Frau Meier', 'Admin sieht alle Räume mit Inhaber', inA);
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, A)).status === 200, 'Admin öffnet fremden Raum');
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, SUP)).status === 404, 'Aufsicht-Passwort gilt nur für die Räume des Admins');
  check((await req('GET', `/api/admin/rooms/${radm.id}`, undefined, SUP)).status === 200, 'Aufsicht sieht weiter die Räume des Admins');
  for (const [url, label] of [['/api/admin/users', 'Kontenliste'], ['/api/admin/setup-check', 'Einrichtungs-Check'], ['/api/admin/client-errors', 'Fehlerberichte']]) {
    check((await req('GET', url, undefined, { as: 'm1' })).status === 403, `Lehrkraft: ${label} nur für den Admin`);
  }

  section('Alarme nur aus eigenen Räumen');
  await req('PATCH', `/api/admin/rooms/${ra.id}`, { settings: { headStartMin: 0, durationMin: 30 } }, { as: 'm1' });
  const pt = {};
  for (const n of ['Lena', 'Jonas']) pt[n] = (await req('POST', `/api/join/${ra.code}`, { name: n }, from())).data.token;
  await req('POST', '/api/play/sos', undefined, { token: pt.Lena });
  const alM1 = (await req('GET', '/api/admin/alerts', undefined, { as: 'm1' })).data;
  const alA = (await req('GET', '/api/admin/alerts', undefined, A)).data;
  const alM2 = (await req('GET', '/api/admin/alerts', undefined, { as: 'm2' })).data;
  check(alM1.emergencies.some((e) => e.name === 'Lena'), 'Frau Meier bekommt den Notruf aus ihrem Raum');
  check(!alA.emergencies.some((e) => e.roomId === ra.id), 'Admin bekommt keinen Alarm aus fremden Räumen');
  check(!alM2.emergencies.length && !alM2.warnings.some((w) => w.roomId === ra.id), 'Herr Schulz bekommt nichts aus fremden Räumen');
  check((await req('GET', '/api/admin/rooms', undefined, A)).data.find((r) => r.id === ra.id).emergencies === 1, '…aber der Admin sieht den Notfall in der Raumliste');
  const e1 = alM1.emergencies[0];
  check((await req('PATCH', `/api/admin/rooms/${ra.id}/emergencies/${e1.id}`, { ack: true }, { as: 'm2' })).status === 404, 'fremden Notfall bearbeiten: 404');

  section('Aufsicht-Link pro Raum');
  const withLink = (await req('POST', `/api/admin/rooms/${ra.id}/suplink`, undefined, { as: 'm1' })).data;
  check((await req('POST', `/api/admin/rooms/${ra.id}/suplink`, undefined, A)).status === 403, 'Admin erzeugt keinen Aufsicht-Link in fremden Räumen (würde den der Lehrkraft entwerten)');
  const adminView = (await req('GET', `/api/admin/rooms/${ra.id}`, undefined, A)).data;
  check(adminView.supToken === undefined && adminView.players.every((x) => !x.rejoinPath), 'Admin sieht in fremden Räumen keine Zugangsschlüssel (Aufsicht-Link, Wiederbeitritt)');
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, { as: 'm1' })).data.players.every((x) => x.rejoinPath), '… die Lehrkraft schon');
  check((await req('POST', '/api/admin/sup-login', { token: withLink.supToken }, { noHeader: true, as: 'x', ...from() })).status === 403, 'Aufsicht-Link nur aus der eigenen Seite');
  check(typeof withLink.supToken === 'string' && withLink.supToken.length >= 24, 'Spielleitung erzeugt einen Aufsicht-Link');
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, SUP)).data?.supToken === undefined, 'Aufsicht-Schlüssel nur für die Spielleitung sichtbar');
  check((await req('POST', '/api/admin/sup-login', { token: 'x'.repeat(24) }, { as: 'link', ...from() })).status === 404, 'falscher Link → abgelehnt');
  const sl = await req('POST', '/api/admin/sup-login', { token: withLink.supToken }, { as: 'link', ...from() });
  check(sl.status === 200 && sl.data.roomId === ra.id && sl.data.role === 'supervisor', 'Anmeldung über den Aufsicht-Link', sl.data);
  const L = { as: 'link' };
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, L)).status === 200, 'Aufsicht sieht den Raum');
  check((await req('POST', `/api/admin/rooms/${ra.id}/message`, { text: 'Alle zum Treffpunkt' }, L)).status === 200, 'Aufsicht sendet Nachrichten');
  check((await req('PATCH', `/api/admin/rooms/${ra.id}/emergencies/${e1.id}`, { ack: true }, L)).status === 200, 'Aufsicht bearbeitet Notfälle');
  check((await req('POST', `/api/admin/rooms/${ra.id}/start`, undefined, L)).status === 403, 'Aufsicht darf nicht starten');
  check((await req('POST', '/api/admin/rooms', { name: 'x' }, L)).status === 403, 'Aufsicht darf keine Räume anlegen');
  const ra2 = (await req('POST', '/api/admin/rooms', { name: 'Meier 10b' }, { as: 'm1' })).data;
  check((await req('GET', `/api/admin/rooms/${ra2.id}`, undefined, L)).status === 404, 'Aufsicht-Link gilt nur für diesen einen Raum');
  const lList = (await req('GET', '/api/admin/rooms', undefined, L)).data;
  check(lList.length === 1 && lList[0].id === ra.id, 'Raumliste der Aufsicht: nur dieser Raum');
  check((await req('GET', '/api/admin/alerts', undefined, L)).data.emergencies.every((e) => e.roomId === ra.id), 'Alarme der Aufsicht: nur dieser Raum');
  await req('POST', `/api/admin/rooms/${ra.id}/suplink`, undefined, { as: 'm1' });
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, L)).status === 401, 'neuer Link → altes Aufsicht-Gerät abgemeldet');
  const fresh = (await req('GET', `/api/admin/rooms/${ra.id}`, undefined, { as: 'm1' })).data.supToken;
  await req('POST', '/api/admin/sup-login', { token: fresh }, { as: 'link2', ...from() });
  await req('DELETE', `/api/admin/rooms/${ra.id}/suplink`, undefined, { as: 'm1' });
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, { as: 'link2' })).status === 401, 'Link zurückgezogen → Aufsicht sofort abgemeldet');

  section('Datenschutz-Angaben pro Konto');
  const me = await req('PATCH', '/api/account/me', { privacyController: 'Gymnasium A, Schulweg 1, 99423 Weimar', privacyContact: 'datenschutz@schule-a.example' }, { as: 'm1' });
  check(me.status === 200 && me.data.privacyController.startsWith('Gymnasium A'), 'Lehrkraft trägt ihre Schule ein');
  const pv = (await req('GET', `/api/privacy?code=${ra.code}`)).data;
  check(pv.external && pv.controller.startsWith('Gymnasium A') && pv.contact === 'datenschutz@schule-a.example', 'Datenschutz-Seite nennt die Schule des Raums', pv);
  check((await req('GET', '/api/privacy', undefined, { token: pt.Jonas })).data.controller?.startsWith('Gymnasium A'), '… auch über den Spieler-Zugang');
  check((await req('GET', `/api/privacy?code=${radm.code}`)).data.external === false, 'Räume des Admins: Angaben aus der .env');
  check((await req('GET', '/api/account/me', undefined, A)).status === 403, '„Mein Konto“ gibt es nur für Lehrkräfte-Konten');

  section('Passwort, Sperren, Passwort-Link');
  await login('m1b', 'meier@schule-a.example', 'meier-passwort-1');
  check((await req('POST', '/api/account/password', { current: 'falsch-falsch', next: 'neues-passwort-2' }, { as: 'm1' })).status === 403, 'Passwort ändern nur mit dem bisherigen');
  check((await req('POST', '/api/account/password', { current: 'meier-passwort-1', next: 'neues-passwort-2' }, { as: 'm1' })).status === 200, 'Passwort geändert');
  check((await req('GET', '/api/admin/rooms', undefined, { as: 'm1' })).status === 200, 'diese Sitzung bleibt angemeldet');
  check((await req('GET', '/api/admin/rooms', undefined, { as: 'm1b' })).status === 401, 'andere Sitzungen des Kontos sind abgemeldet');
  // Herr Schulz hat einen Aufsicht-Link und einen Notruf im Raum – dann wird sein Konto gesperrt
  const linkB = (await req('POST', `/api/admin/rooms/${rb.id}/suplink`, undefined, { as: 'm2' })).data.supToken;
  await req('POST', '/api/admin/sup-login', { token: linkB }, { as: 'linkB', ...from() });
  await req('PATCH', `/api/admin/rooms/${rb.id}`, { settings: { headStartMin: 0 } }, { as: 'm2' });
  const tb = (await req('POST', `/api/join/${rb.code}`, { name: 'Ole' }, from())).data.token;
  await req('POST', '/api/play/sos', undefined, { token: tb });
  check(!(await req('GET', '/api/admin/alerts', undefined, A)).data.emergencies.some((e) => e.roomId === rb.id), 'aktives Konto: Admin bekommt keinen Alarm aus dessen Raum');
  await req('PATCH', `/api/admin/users/${m2Id}`, { status: 'disabled' }, A);
  check((await req('GET', '/api/admin/rooms', undefined, { as: 'm2' })).status === 401, 'gesperrt → sofort abgemeldet');
  check((await req('GET', `/api/admin/rooms/${rb.id}`, undefined, { as: 'linkB' })).status === 401, 'gesperrt → auch Aufsicht-Links des Kontos ungültig');
  check((await req('POST', '/api/admin/sup-login', { token: linkB }, { as: 'linkB2', ...from() })).status === 404, '… und lassen sich nicht neu benutzen');
  check((await req('GET', '/api/admin/alerts', undefined, A)).data.emergencies.some((e) => e.roomId === rb.id), 'Notrufe aus Räumen gesperrter Konten gehen an den Admin');
  check((await login('m2', 'schulz@schule-b.example', 'schulz-passwort-1')).status === 403, 'gesperrt → Anmeldung abgelehnt');
  const rs = (await req('POST', `/api/admin/users/${m2Id}/reset`, undefined, A)).data;
  const token = rs.path.split('#')[1];
  check(rs.path.startsWith('/passwort#') && token.length >= 24, 'Admin erzeugt einen Passwort-Link');
  check((await req('POST', '/api/account/reset', { token, password: 'kurz' }, from())).status === 400, 'Passwort-Link: zu kurzes Passwort abgelehnt');
  check((await req('POST', '/api/account/reset', { token, password: 'schulz-neu-12345' }, from())).status === 200, 'neues Passwort über den Link gesetzt');
  check((await req('POST', '/api/account/reset', { token, password: 'noch-einmal-123' }, from())).status === 404, 'Link gilt nur einmal');
  await req('PATCH', `/api/admin/users/${m2Id}`, { status: 'active' }, A);
  check((await login('m2', 'schulz@schule-b.example', 'schulz-neu-12345')).status === 200, 'nach Entsperren: Anmeldung mit neuem Passwort');

  section('Raum übergeben, Grenzen, Registrierung schließen');
  check((await req('POST', `/api/admin/rooms/${ra2.id}/owner`, { ownerId: m2Id }, { as: 'm1' })).status === 403, 'nur der Admin übergibt Räume');
  check((await req('POST', `/api/admin/rooms/${ra2.id}/owner`, { ownerId: [m2Id] }, A)).status === 400, 'Übergabe: ungültige Angabe → 400');
  const pend = await reg({ name: 'Frau Neu', email: 'neu@schule-c.example', org: 'Schule C', password: 'neu-passwort-123' });
  const pendId = (await req('GET', '/api/admin/users', undefined, A)).data.users.find((u) => u.email === 'neu@schule-c.example')?.id;
  check(pend.status === 200 && (await req('POST', `/api/admin/rooms/${ra2.id}/owner`, { ownerId: pendId }, A)).status === 409, 'Übergabe an nicht freigegebenes Konto → abgelehnt');
  check((await req('POST', `/api/admin/rooms/${ra2.id}/owner`, { ownerId: m2Id }, A)).status === 200, 'Admin übergibt einen Raum');
  check((await req('GET', `/api/admin/rooms/${ra2.id}`, undefined, A)).data.events.some((e) => e.text === 'Raum übergeben an Herr Schulz'), 'Übergabe steht im Verlauf');
  check((await req('GET', `/api/admin/rooms/${ra2.id}`, undefined, { as: 'm2' })).status === 200 && (await req('GET', `/api/admin/rooms/${ra2.id}`, undefined, { as: 'm1' })).status === 404, 'neuer Inhaber sieht ihn, der alte nicht mehr');
  let made = 0, blocked = null;
  for (let i = 0; i < 25 && !blocked; i++) {
    const r = await req('POST', '/api/admin/rooms', { name: `Serie ${i}` }, { as: 'm2' });
    if (r.status === 200) made++; else blocked = r;
  }
  check(blocked?.status === 409 && made === 18, 'höchstens 20 Räume je Konto', { made, status: blocked?.status });
  await req('PATCH', '/api/admin/platform', { registrationOpen: false }, A);
  check((await reg({ name: 'Zu spät', email: 'spaet@x.example', org: 'Schule X', password: 'lang-genug-123' })).status === 403, 'Registrierung geschlossen → abgelehnt');
  check((await req('PATCH', '/api/admin/platform', { registrationOpen: true }, { as: 'm1' })).status === 403, 'nur der Admin öffnet die Registrierung');
  await req('PATCH', '/api/admin/platform', { registrationOpen: true }, A);

  section('Schutz gegen Passwort-Raten');
  for (let i = 0; i < 10; i++) await login('rater', 'schulz@schule-b.example', `falsch-${i}-xxxxx`); // jedes Mal eine andere Adresse
  const locked = await login('m2x', 'schulz@schule-b.example', 'schulz-neu-12345');
  check(locked.status === 429, 'nach 10 Fehlversuchen für ein Konto: gesperrt – auch von neuen Adressen und mit richtigem Passwort', locked.data);
  check((await login('m1x', 'meier@schule-a.example', 'neues-passwort-2')).status === 200, 'andere Konten sind davon nicht betroffen');

  section('Konto löschen, gespeicherte Daten');
  await sleep(3500); // Autosave
  const saved = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  check(saved.includes('meier@schule-a.example') && !saved.includes('neues-passwort-2') && saved.includes('scrypt$'), 'Konten gespeichert, Passwort nur als Hash');
  check((await req('DELETE', '/api/account/me', { password: 'falsch' }, { as: 'm1' })).status === 403, 'Konto löschen nur mit Passwort');
  check((await req('DELETE', '/api/account/me', { password: 'neues-passwort-2' }, { as: 'm1' })).status === 200, 'Frau Meier löscht ihr Konto');
  check((await req('GET', `/api/admin/rooms/${ra.id}`, undefined, A)).status === 404, 'ihre Räume sind mit gelöscht');
  check((await req('GET', '/api/play/state', undefined, { token: pt.Lena })).status === 401, 'Spieler-Zugänge der Räume sind ungültig');
  check((await login('m1', 'meier@schule-a.example', 'neues-passwort-2')).status === 401, 'Anmeldung mit gelöschtem Konto unmöglich');
  check(!fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8').includes('meier@schule-a.example'), 'gelöscht wird sofort auf die Platte geschrieben');
  await req('DELETE', `/api/admin/users/${m2Id}`, undefined, A);
  check(!(await req('GET', '/api/admin/users', undefined, A)).data.users.some((u) => u.id === m2Id), 'Admin löscht das zweite Konto samt Räumen');
  check((await req('GET', `/api/admin/rooms/${rb.id}`, undefined, A)).status === 404, '… auch dessen Räume');

}
