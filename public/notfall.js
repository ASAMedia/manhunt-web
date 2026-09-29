import { $, api, el, noBreak, routeUrl, store } from './common.js';

// Notfallkarten für einen Raum: /notfallkarten#<raum-id> – eine Karte pro Gruppe zum Ausschneiden.
// Enthält nur, was die Gruppe ohne App braucht: Treffpunkt, Nummern, was tun, wenn etwas schiefgeht.
const roomId = location.hash.slice(1);
let room = null;

// Eingaben für die nächste Karte merken (nur in diesem Browser)
for (const id of ['returnTime', 'phone2', 'pages']) {
  const saved = store.get(`mh_card_${id}`);
  if (saved) $(`#${id}`).value = saved;
  $(`#${id}`).addEventListener('input', () => { store.set(`mh_card_${id}`, $(`#${id}`).value); render(); });
}

const blank = (w = '100%') => el('span', { class: 'blank', style: `width:${w}` });

function card() {
  const s = room.settings;
  const mp = s.meetingPoint;
  const ret = $('#returnTime').value;
  const phone2 = $('#phone2').value.trim();
  return el('section', { class: 'ncard' },
    el('header', {},
      el('strong', { text: 'Notfallkarte' }),
      el('span', { text: room.name })),
    el('div', { class: 'ncard-row' }, el('b', { text: 'Gruppe: ' }), blank()),
    el('div', { class: 'ncard-meet' },
      el('div', {},
        el('div', {}, el('b', { text: 'Treffpunkt: ' }), mp ? mp.label : blank('60%')),
        el('div', {}, el('b', { text: 'Zurück bis: ' }), ret ? `${ret} Uhr` : blank('30%'), ret ? null : ' Uhr'),
        el('div', { class: 'ncard-phones' },
          el('div', {}, el('b', { text: 'Spielleitung: ' }), s.emergencyPhone ? noBreak(s.emergencyPhone) : blank('55%')),
          el('div', {}, el('b', { text: 'Weitere: ' }), phone2 ? noBreak(phone2) : blank('65%')),
          el('div', {}, el('b', { text: 'Notruf 112' }), ' · Polizei 110'))),
      mp ? el('figure', {},
        el('img', { src: `/api/admin/qr.svg?text=${encodeURIComponent(routeUrl(mp.lat, mp.lng))}`, alt: 'QR-Code: Weg zum Treffpunkt' }),
        el('figcaption', { text: 'Weg zum Treffpunkt' })) : null),
    el('ol', {},
      el('li', { text: 'Immer zusammenbleiben – niemand geht allein.' }),
      el('li', { text: 'App geht nicht oder Handy leer: Lehrkraft anrufen oder schreiben, dann zum Treffpunkt.' }),
      el('li', { text: 'Anderes Handy nehmen: Die Lehrkraft gibt euch einen Wiederbeitritts-Code.' }),
      el('li', { text: 'Verlaufen: an einem belebten, sicheren Ort stehen bleiben und anrufen.' }),
      el('li', { text: 'Verletzt oder in Gefahr: sofort 112, danach die Lehrkraft. In der App: SOS 1,5 Sekunden halten.' })));
}

function render() {
  if (!room) return;
  const n = Number($('#pages').value || 1) * 6;
  $('#cards').replaceChildren(...Array.from({ length: n }, card));
}

async function init() {
  try {
    room = await api('GET', `/api/admin/rooms/${encodeURIComponent(roomId)}`);
  } catch (e) {
    const text = e.status === 401 ? 'Bitte zuerst unter /admin als Spielleitung oder Aufsicht anmelden.' : e.message;
    $('#cards').replaceChildren(el('p', { class: 'alert danger', text }));
    return;
  }
  document.title = `Notfallkarten – ${room.name}`;
  render();
}

$('#printBtn').addEventListener('click', () => window.print());
init();
