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
    ['Auf der Karte', 'legend'],
    ['Notfall', `SOS-Knopf oben rechts 1,5 Sekunden gedrückt halten${s.emergencyPhone ? ` · Spielleitung: ${noBreak(s.emergencyPhone)}` : ''} · Lebensgefahr: 112`],
  ].filter(Boolean);

  // Farben wie in der App: Jäger orange, Gejagte blau, Rot nur für Notfälle
  const legend = () => el('dd', {},
    el('span', { class: 'legend-dot hunter' }), 'Jäger', el('span', { class: 'legend-dot runner' }), 'Gejagte',
    el('span', { class: 'legend-dot sos' }), 'Notfall · gestrichelte Linie = Spielfeld · 🏁 Treffpunkt');
  const step = (n, title, sub) => el('li', {}, el('span', { class: 'step-n', text: String(n) }),
    el('div', {}, title, sub ? el('span', { class: 'sub' }, ...sub) : null));
  $('#sheet').replaceChildren(
    el('header', { class: 'sheet-head' },
      el('img', { src: '/icon.svg', alt: '' }),
      el('div', {}, el('div', { class: 'kicker', text: 'Manhunt – Das Fangspiel durch die Stadt' }), el('h1', { text: room.name }))),
    el('section', { class: 'sheet-join' },
      el('img', { src: `/api/admin/qr.svg?text=${encodeURIComponent(url)}`, alt: 'QR-Code zum Beitreten' }),
      el('div', { class: 'stack' },
        el('ol', { class: 'sheet-steps' },
          step(1, 'QR-Code scannen', ['oder ', el('strong', { text: base.replace(/^https?:\/\//, '') }), ' öffnen und den Code eingeben:']),
          el('li', {}, el('div', { class: 'big-code', text: room.code })),
          step(2, 'Namen eingeben', ['bei Jäger-Teams den Teamnamen']),
          step(3, '„Standort freigeben & loslegen“', ['Seite offen lassen, Display an, Powerbank mitnehmen'])))),
    el('dl', { class: 'sheet-facts' }, facts.flatMap(([k, v]) => [el('dt', { text: k }), v === 'legend' ? legend() : el('dd', { text: v })])),
    el('section', { class: 'sheet-rules' }, el('div', { class: 'rules-text', text: rulesText(s) })),
  );
}

$('#printBtn').addEventListener('click', () => window.print());
init();
