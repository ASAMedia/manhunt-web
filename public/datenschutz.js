import { $, el, getConfig, store } from './common.js';
import { lang, applyI18n, langButton } from './i18n.js';

// Datenschutz-Hinweise für Spieler und Eltern – Inhalt folgt der tatsächlichen Konfiguration des Servers.
// Bei Änderungen am Verhalten der App: Text anpassen und STAND erhöhen.
const STAND = { de: '08.10.2026', en: '8 October 2026' };
applyI18n();
$('#langSlot').append(langButton());
if (store.get('mh_token')) $('#back').href = '/play';
if (history.length > 1) $('#back').addEventListener('click', (e) => { e.preventDefault(); history.back(); });

function content(cfg) {
  const days = cfg.autoDeleteDays;
  const { privacyController: controller, privacyContact: contact, privacyHosting: hosting } = cfg;
  if (lang === 'en') {
    return {
      title: 'Privacy – Manhunt',
      intro: `Manhunt is a chase game in the browser for school events. This notice explains which data is processed. Last updated: ${STAND.en}.`,
      sections: [
        ['Who is responsible?', [
          controller ? `Controller: ${controller}` : 'The controller is the school organising the game, represented by the game master (teacher).',
          contact ? `Data protection contact: ${contact}` : 'Questions about data protection: the game master or the school’s data protection officer.',
        ]],
        ['What for and on which legal basis?', [
          'Purpose: running the city game and supervising the participants (safety, emergency call, meeting point).',
          'Legal basis is consent (Art. 6(1)(a) GDPR) – for minors, the consent of their parents or guardians. Taking part is voluntary; not taking part has no disadvantages.',
          'Consent can be withdrawn at any time with effect for the future (Art. 7(3) GDPR).',
          'There is no automated decision-making and no profiling.',
        ]],
        ['Which data?', [
          'The name or team name you enter.',
          'Your location (coordinates, accuracy, time) – every few seconds while the game page is open, before and during the game. It is only sent after you tap “Share location & start” (again each time you open the page); after the game the server accepts it for at most 2 hours (on the way back to the meeting point).',
          'Device status: battery level and charging, result of the phone check (location, screen, sound, vibration, iPhone/Android, installed as an app), location errors.',
          'Game events: role, joining, last signal, caught, inside/outside the play area, emergency call (with location), reported means of transport, blocks, name changes, messages from the game master.',
          'Technical: your IP address – only briefly in memory to prevent abuse (at most 15 minutes), it is not stored. For a program error: the error message, browser and operating system – without name or location.',
          'Not collected: account, e-mail address, phone number, contacts, photos. No advertising, no advertising or analytics trackers.',
        ]],
        ['Who sees what?', [
          'Game master and supervisor: all data above, including your live location – for supervision and emergencies. In an emergency the game master can open Google Maps with your location as the destination (“Route”).',
          'Hunters: during the running game, the runners’ locations only at ping times (not when blocked), the other hunter teams live and the reported means of transport.',
          'Runners: during the running game, at every ping the locations of the hunter teams and of the other runners at that moment (until the next ping; not of runners who blocked); otherwise no locations of others.',
          'All players: names, roles, who was caught when, the result and, in the lobby, who has joined.',
          'After the game, the game master can show the runners’ ping locations as a time-lapse with connecting lines, e.g. on a projector in front of the class. Blocked pings and hunters are not shown.',
        ]],
        ['Where and for how long?', [
          hosting ? `The data is stored on the game master’s server at ${hosting} (processor).` : 'The data is stored on the game master’s server. If it is run by a hosting provider, that provider is a processor.',
          'Only your latest location is kept, plus the locations at ping times (until the next round starts) and at an emergency call.',
          days
            ? `The room including all data is deleted automatically ${days} days after the last activity (never during a running game), or earlier by the game master on request.`
            : 'The game master deletes the room including all data after the game.',
          'The game master can download the event log and the evaluation as a file (names, times, events – no coordinates) and deletes it after the event.',
          'Error reports stay in memory until the next restart and appear in the server log, which is overwritten automatically (at most 30 MB).',
          'On your phone: an access key and game state in the browser storage – without signal (e.g. in the underground) also reports not yet sent (“caught”, means of transport, block, emergency call) with the time you tapped, until they have arrived – program files and viewed map images in the offline storage. They are deleted when you leave the game or the game master removes you (next time the page is open); settings (sound, language, sunlight mode, guide already read) remain. Remove an installed app from your home screen.',
        ]],
        ['Other services', [
          cfg.tileProxy
            ? 'Map images (© OpenStreetMap contributors) are loaded by the game master’s server – your phone does not connect to OpenStreetMap.'
            : 'Map images come directly from OpenStreetMap (OpenStreetMap Foundation, United Kingdom), which sees your IP address in the process.',
          'Google Maps only opens when you tap “Route”. Google (USA) then receives the destination and calculates the route from your location – Google’s privacy policy applies.',
        ]],
        ['Your rights', [
          'You (or your parents/guardians) can request information about your data (Art. 15 GDPR), have wrong data corrected (Art. 16), deleted (Art. 17) or restricted (Art. 18), and receive a copy (Art. 20) – from the game master or the contact above.',
          'The game master can remove you from the game at any time; your data is deleted completely together with the room – immediately on request.',
          'You can lodge a complaint with a data protection supervisory authority, e.g. the one of your school’s federal state.',
        ]],
        ['Joining and leaving', [
          'Before the game you can tap “Leave game” at any time. During the game, tell the game master or close the page – then no more location data is sent.',
        ]],
      ],
    };
  }
  return {
    title: 'Datenschutz – Manhunt',
    intro: `Manhunt ist ein Fangspiel im Browser für Schulveranstaltungen. Diese Hinweise erklären, welche Daten dabei verarbeitet werden. Stand: ${STAND.de}.`,
    sections: [
      ['Wer ist verantwortlich?', [
        controller ? `Verantwortlich: ${controller}` : 'Verantwortlich ist die Schule, die das Spiel veranstaltet; sie wird von der Spielleitung (Lehrkraft) vertreten.',
        contact ? `Datenschutz-Kontakt: ${contact}` : 'Fragen zum Datenschutz beantwortet die Spielleitung bzw. die oder der Datenschutzbeauftragte der Schule.',
      ]],
      ['Wofür und auf welcher Grundlage?', [
        'Zweck: das Stadtspiel durchführen und die Teilnehmenden beaufsichtigen (Sicherheit, Notruf, Treffpunkt).',
        'Rechtsgrundlage ist die Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) – bei Minderjährigen die der Sorgeberechtigten. Die Teilnahme ist freiwillig; wer nicht mitmacht, hat keine Nachteile.',
        'Die Einwilligung kann jederzeit mit Wirkung für die Zukunft widerrufen werden (Art. 7 Abs. 3 DSGVO).',
        'Es gibt keine automatisierten Entscheidungen und kein Profiling.',
      ]],
      ['Welche Daten?', [
        'Der Name oder Teamname, den du eingibst.',
        'Dein Standort (Koordinaten, Genauigkeit, Zeitpunkt) – alle paar Sekunden, solange die Spielseite offen ist, vor und während des Spiels. Er wird erst gesendet, nachdem du „Standort freigeben & loslegen“ getippt hast (bei jedem Öffnen der Seite neu); nach Spielende nimmt der Server ihn höchstens 2 Stunden lang an (Rückweg zum Treffpunkt).',
        'Geräte-Status: Akkustand und Laden, Ergebnis des Handy-Checks (Standort, Display, Ton, Vibration, iPhone/Android, als App installiert), Standortfehler.',
        'Spielverlauf: Rolle, Beitritt, letztes Signal, gefangen, innerhalb/außerhalb des Spielfelds, Notruf (mit Standort), gemeldete Verkehrsmittel, Blocks, Namensänderungen, Nachrichten der Spielleitung.',
        'Technisch: deine IP-Adresse – nur kurz im Arbeitsspeicher zum Schutz vor Missbrauch (höchstens 15 Minuten), sie wird nicht gespeichert. Bei einem Programmfehler: Fehlermeldung, Browser und Betriebssystem – ohne Name und Standort.',
        'Nicht erhoben: Konto, E-Mail-Adresse, Telefonnummer, Kontakte, Fotos. Keine Werbung, keine Werbe- oder Analyse-Tracker.',
      ]],
      ['Wer sieht was?', [
        'Spielleitung und Aufsicht: alle oben genannten Daten, deinen Standort live – zur Aufsicht und für Notfälle. Im Notfall kann die Spielleitung Google Maps mit deinem Standort als Ziel öffnen („Route“).',
        'Jäger: während des laufenden Spiels die Standorte der Gejagten nur zu den Ping-Zeitpunkten (nicht bei einem Block), die anderen Jäger-Teams live und die gemeldeten Verkehrsmittel.',
        'Gejagte: während des laufenden Spiels bei jedem Ping die Standorte der Jäger-Teams und der anderen Gejagten in diesem Moment (bis zum nächsten Ping; nicht bei einem Block); sonst keine Standorte anderer.',
        'Alle Mitspielenden: Namen, Rollen, wer wann gefangen wurde, das Ergebnis und in der Lobby, wer beigetreten ist.',
        'Nach dem Spiel kann die Spielleitung die Ping-Standorte der Gejagten als Zeitraffer mit Verbindungslinien zeigen, z. B. am Beamer vor der Klasse. Blockierte Pings und Jäger werden dabei nicht gezeigt.',
      ]],
      ['Wo und wie lange?', [
        hosting ? `Die Daten liegen auf dem Server der Spielleitung bei ${hosting} (Auftragsverarbeiter).` : 'Die Daten liegen auf dem Server der Spielleitung. Wird er bei einem Hosting-Anbieter betrieben, ist dieser Auftragsverarbeiter.',
        'Vom Standort wird nur der jeweils letzte gespeichert, dazu die Standorte zu den Ping-Zeitpunkten (bis zum Start der nächsten Runde) und beim Notruf.',
        days
          ? `Der Raum wird mit allen Daten ${days} Tage nach der letzten Aktivität automatisch gelöscht (laufende Spiele nie), auf Wunsch früher durch die Spielleitung.`
          : 'Die Spielleitung löscht den Raum mit allen Daten nach dem Spiel.',
        'Die Spielleitung kann Verlauf und Auswertung als Datei herunterladen (Namen, Zeiten, Ereignisse – keine Koordinaten) und löscht sie nach der Veranstaltung.',
        'Fehlerberichte bleiben bis zum nächsten Neustart im Arbeitsspeicher und stehen im Server-Protokoll, das automatisch überschrieben wird (höchstens 30 MB).',
        'Auf deinem Handy: Zugangsschlüssel und Spielstand im Browser-Speicher – im Funkloch (z. B. in der U-Bahn) außerdem noch nicht gesendete Meldungen („gefangen“, Verkehrsmittel, Block, Notruf) mit der Uhrzeit des Tippens, bis sie angekommen sind –, Programmdateien und angesehene Kartenbilder im Offline-Speicher. Das wird gelöscht, wenn du das Spiel verlässt oder die Spielleitung dich entfernt (beim nächsten Öffnen der Seite); Einstellungen (Ton, Sprache, Sonnenmodus, Kurzanleitung gelesen) bleiben. Eine installierte App entfernst du vom Home-Bildschirm.',
      ]],
      ['Weitere Dienste', [
        cfg.tileProxy
          ? 'Kartenbilder (© OpenStreetMap-Mitwirkende) lädt der Server der Spielleitung – dein Handy verbindet sich dafür nicht mit OpenStreetMap.'
          : 'Kartenbilder kommen direkt von OpenStreetMap (OpenStreetMap Foundation, Großbritannien); OpenStreetMap sieht dabei deine IP-Adresse.',
        'Google Maps öffnet sich nur, wenn du auf „Route“ tippst. Google (USA) erhält dann das Ziel und berechnet die Route von deinem Standort aus – es gelten die Datenschutzbestimmungen von Google.',
      ]],
      ['Deine Rechte', [
        'Du bzw. deine Sorgeberechtigten können Auskunft über deine Daten verlangen (Art. 15 DSGVO), falsche Daten berichtigen (Art. 16), Daten löschen (Art. 17) oder ihre Verarbeitung einschränken lassen (Art. 18) und eine Kopie erhalten (Art. 20) – bei der Spielleitung bzw. dem oben genannten Kontakt.',
        'Die Spielleitung kann dich jederzeit aus dem Spiel entfernen; vollständig gelöscht werden deine Daten mit dem Raum – auf Wunsch sofort.',
        'Du kannst dich bei einer Datenschutz-Aufsichtsbehörde beschweren, z. B. bei der oder dem Landesbeauftragten für Datenschutz im Bundesland deiner Schule.',
      ]],
      ['Mitmachen und Aussteigen', [
        'Vor dem Spiel kannst du jederzeit „Spiel verlassen“ tippen. Während des Spiels meldest du dich bei der Spielleitung oder schließt die Seite – dann wird kein Standort mehr übertragen.',
      ]],
    ],
  };
}

getConfig().then((cfg) => {
  const c = content(cfg);
  document.title = c.title;
  $('#privacy').replaceChildren(
    el('h1', { text: c.title }),
    el('p', { class: 'lead', text: c.intro }),
    ...c.sections.map(([heading, items]) => el('section', {},
      el('h2', { text: heading }),
      el('ul', {}, items.map((text) => el('li', { text }))))));
});
