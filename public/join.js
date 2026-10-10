import { $, api, store } from './common.js';
import { t, applyI18n, langButton, langHeader } from './i18n.js';

applyI18n();
$('#langSlot').append(langButton());

const code = location.pathname.split('/').pop().toUpperCase();
// Datenschutz-Seite mit dem Raum aufrufen – sie nennt dann die Schule, die diesen Raum veranstaltet
for (const a of document.querySelectorAll('a[href="/datenschutz"]')) a.href = `/datenschutz?code=${encodeURIComponent(code)}`;

async function init() {
  // Wer den QR-Code erneut scannt (z. B. nach versehentlich geschlossenem Tab), landet wieder in seinem
  // bestehenden Spiel statt doppelt beizutreten
  const token = store.get('mh_token');
  let room;
  try {
    room = await api('GET', `/api/join/${encodeURIComponent(code)}`, undefined, { ...langHeader, ...(token && { 'X-Player-Token': token }) });
  } catch (e) {
    return showProblem(e.message);
  }
  if (room.member) return location.replace('/play');
  $('#roomName').textContent = room.name;
  document.title = `Manhunt – ${room.name}`;
  if (!room.joinOpen) return showProblem(t('join.closed'));
  $('#info').textContent = t('join.enterName');
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
  const btn = e.submitter || $('#joinForm button');
  btn.disabled = true;
  $('#err').textContent = '';
  try {
    const { token } = await api('POST', `/api/join/${encodeURIComponent(code)}`, { name: $('#name').value }, langHeader);
    store.set('mh_token', token);
    location.replace('/play');
  } catch (err) {
    $('#err').textContent = err.message;
    btn.disabled = false;
  }
});

init();
