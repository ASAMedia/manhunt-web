import { $, api, store } from './common.js';

const code = location.pathname.split('/').pop().toUpperCase();

async function init() {
  // Wer den QR-Code erneut scannt, landet wieder in seinem bestehenden Spiel statt doppelt beizutreten
  const token = store.get('mh_token');
  if (token) {
    try {
      const s = await api('GET', '/api/play/state', undefined, { 'X-Player-Token': token });
      if (s.room.code === code) return location.replace('/play');
    } catch { /* altes Token ungültig – neu beitreten */ }
  }

  let room;
  try {
    room = await api('GET', `/api/join/${encodeURIComponent(code)}`);
  } catch (e) {
    return showProblem(e.message);
  }
  $('#roomName').textContent = room.name;
  document.title = `Manhunt – ${room.name}`;
  if (!room.joinOpen) return showProblem('Der Beitritt ist gerade geschlossen. Frag die Spielleitung.');
  $('#info').textContent = 'Gib deinen Namen ein, um mitzuspielen.';
  $('#joinForm').classList.remove('hidden');
  $('#name').focus();
}

function showProblem(text) {
  const info = $('#info');
  info.textContent = text;
  info.className = 'alert danger';
  info.removeAttribute('style');
}

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('#err').textContent = '';
  try {
    const { token } = await api('POST', `/api/join/${encodeURIComponent(code)}`, { name: $('#name').value });
    store.set('mh_token', token);
    location.replace('/play');
  } catch (err) {
    $('#err').textContent = err.message;
    btn.disabled = false;
  }
});

init();
