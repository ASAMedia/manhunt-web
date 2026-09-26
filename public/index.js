import { $, api, store } from './common.js';

// „Zurück zu meinem Spiel“ nur anbieten, wenn das gemerkte Spiel noch existiert
const token = store.get('mh_token');
if (token) {
  api('GET', '/api/play/state', undefined, { 'X-Player-Token': token })
    .then((s) => {
      $('#resume').textContent = `Zurück zu „${s.room.name}“`;
      $('#resume').classList.remove('hidden');
    })
    .catch((e) => { if (e.status === 401) store.del('mh_token'); });
}

$('#codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code) location.href = `/j/${code}`;
});
