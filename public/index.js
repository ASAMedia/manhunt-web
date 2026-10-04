import { $, api, store } from './common.js';
import { t, applyI18n, langButton, langHeader } from './i18n.js';

applyI18n();
$('#langSlot').append(langButton());

// „Zurück zu meinem Spiel“ nur anbieten, wenn das gemerkte Spiel noch existiert
const token = store.get('mh_token');
if (token) {
  api('GET', '/api/play/state', undefined, { 'X-Player-Token': token, ...langHeader })
    .then((s) => {
      $('#resume').textContent = t('idx.resume', { name: s.room.name });
      $('#resume').classList.remove('hidden');
    })
    .catch((e) => { if (e.status === 401) store.del('mh_token'); });
}

// Code beim Tippen gleich in Großbuchstaben, ohne Leer- und Sonderzeichen
$('#code').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); // auch eingefügte Codes wie „abc 123“
  if (v !== e.target.value) e.target.value = v;
});

$('#codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code) location.href = `/j/${code}`;
});
