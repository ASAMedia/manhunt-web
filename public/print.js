import { $, api, el, getConfig, rulesText, fmtSeconds, noBreak } from './common.js';

// Druckblatt für einen Raum: /print#<raum-id> (nur für angemeldete Spielleitung/Aufsicht)
const roomId = location.hash.slice(1);

async function init() {
  const cfg = await getConfig();
  let room;
  try {
    room = await api('GET', `/api/admin/rooms/${encodeURIComponent(roomId)}`);
  } catch (e) {
    const text = e.status === 401 ? 'Bitte zuerst unter /admin als Spielleitung anmelden.' : e.message;
    $('#sheet').replaceChildren(el('p', { class: 'alert danger', text }));
    return;
  }
  const base = cfg.publicUrl || location.origin;
  const url = `${base}/j/${room.code}`;
  const s = room.settings;
  document.title = `Druckblatt – ${room.name}`;

  const facts = [
    ['Ping', `alle ${s.pingIntervalMin} Minuten${s.pingWarningSec ? ` (Vorwarnung ${fmtSeconds(s.pingWarningSec)} vorher)` : ''}`],
    ['Vorsprung', `${s.headStartMin} Minuten`],
    ['Spieldauer', `${s.durationMin} Minuten`],
    s.zone ? ['Spielfeld', `${s.zone.points ? 'markierte Fläche auf der Karte' : `Kreis mit ${s.zone.radius} m Radius`}${s.shrinkEnabled ? `, schrumpft bis zum Ende${s.zone.points ? '' : ` auf ${s.shrinkFinalRadius} m`}` : ''}`] : null,
    s.meetingPoint ? ['Treffpunkt', s.meetingPoint.label] : null,
    ['Notfall', `SOS-Knopf oben rechts 1,5 Sekunden gedrückt halten${s.emergencyPhone ? ` · Spielleitung: ${noBreak(s.emergencyPhone)}` : ''} · Lebensgefahr: 112`],
  ].filter(Boolean);

  $('#sheet').replaceChildren(
    el('h1', { text: `Manhunt – ${room.name}` }),
    el('section', { class: 'sheet-join' },
      el('img', { src: `/api/admin/qr.svg?text=${encodeURIComponent(url)}`, alt: 'QR-Code zum Beitreten' }),
      el('div', { class: 'stack' },
        el('p', { class: 'big', text: '1. QR-Code scannen' }),
        el('p', {}, 'oder ', el('strong', { text: base.replace(/^https?:\/\//, '') }), ' öffnen und den Code eingeben:'),
        el('div', { class: 'big-code', text: room.code }),
        el('p', { class: 'big', text: '2. Namen eingeben (Jäger-Teams: Teamname)' }),
        el('p', { class: 'big', text: '3. „Standort freigeben & loslegen“ – Seite offen und Display an lassen' }))),
    el('dl', { class: 'sheet-facts' }, facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    el('section', { class: 'sheet-rules' }, el('div', { class: 'rules-text', text: rulesText(s) })),
  );
}

$('#printBtn').addEventListener('click', () => window.print());
init();
