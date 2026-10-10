import { $, api, el } from './common.js';

// Konto-Seite für Lehrkräfte: Registrierung (/registrieren) und neues Passwort über einen Link des Admins (/passwort#…)

function done(title, text) {
  for (const id of ['regForm', 'resetForm']) $(`#${id}`).classList.add('hidden');
  $('#done').replaceChildren(el('h2', { text: title }), el('p', { text }), el('a', { class: 'btn primary', href: '/admin', text: 'Zur Anmeldung' }));
  $('#done').classList.remove('hidden');
}

async function initRegister() {
  document.title = 'Manhunt – Als Lehrkraft registrieren';
  $('#title').textContent = 'Als Lehrkraft registrieren';
  let open = false;
  try { open = (await api('GET', '/api/account/registration')).open; } catch { /* Server nicht erreichbar */ }
  if (!open) {
    $('#done').replaceChildren(el('h2', { text: 'Registrierung geschlossen' }),
      el('p', { text: 'Neue Konten kann gerade nur der Admin freischalten. Bitte wende dich an die Person, die diese Seite betreibt.' }));
    $('#done').classList.remove('hidden');
    return;
  }
  $('#regForm').classList.remove('hidden');
  $('#regName').focus();
  $('#regForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#regErr').textContent = '';
    if ($('#regPw').value !== $('#regPw2').value) { $('#regErr').textContent = 'Die beiden Passwörter sind verschieden.'; return; }
    const btn = $('#regForm button');
    btn.disabled = true;
    try {
      await api('POST', '/api/account/register', {
        name: $('#regName').value, org: $('#regOrg').value, email: $('#regEmail').value, password: $('#regPw').value,
      });
      done('Danke!', 'Dein Konto wartet jetzt auf die Freigabe durch den Admin. Danach meldest du dich unter /admin mit deiner E-Mail-Adresse und deinem Passwort an. Ohne Freigabe wird die Registrierung nach 14 Tagen gelöscht.');
    } catch (err) {
      $('#regErr').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function initReset() {
  document.title = 'Manhunt – Neues Passwort';
  $('#title').textContent = 'Neues Passwort';
  const token = location.hash.slice(1);
  history.replaceState(null, '', '/passwort'); // Schlüssel nicht in der Adresszeile stehen lassen
  if (!token) {
    done('Link unvollständig', 'Bitte den vollständigen Link aus der Nachricht des Admins öffnen.');
    return;
  }
  $('#resetForm').classList.remove('hidden');
  $('#resetPw').focus();
  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#resetErr').textContent = '';
    if ($('#resetPw').value !== $('#resetPw2').value) { $('#resetErr').textContent = 'Die beiden Passwörter sind verschieden.'; return; }
    const btn = $('#resetForm button');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/account/reset', { token, password: $('#resetPw').value });
      done('Passwort gespeichert', `Du kannst dich jetzt mit ${r.email} und dem neuen Passwort anmelden.`);
    } catch (err) {
      $('#resetErr').textContent = err.message;
      btn.disabled = false;
    }
  });
}

if (location.pathname === '/passwort') initReset();
else initRegister();
