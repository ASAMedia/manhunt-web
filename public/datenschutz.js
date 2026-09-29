import { $, el, getConfig, store } from './common.js';
import { lang, applyI18n, langButton } from './i18n.js';

// Datenschutz-Hinweise für Spieler und Eltern – Inhalt folgt der tatsächlichen Konfiguration des Servers
applyI18n();
$('#langSlot').append(langButton());
if (store.get('mh_token')) $('#back').href = '/play';
if (history.length > 1) $('#back').addEventListener('click', (e) => { e.preventDefault(); history.back(); });

function content(cfg) {
  const days = cfg.autoDeleteDays;
  const contact = cfg.privacyContact;
  if (lang === 'en') {
    return {
      title: 'Privacy – Manhunt',
      intro: 'Manhunt is a chase game in the browser. It is run by your game master (e.g. your school) on their own server – not by an app company.',
      sections: [
        ['Who is responsible?', [
          'The game master who runs this game on their own server.',
          contact ? `Contact: ${contact}` : 'Please contact your game master with any questions.',
        ]],
        ['Which data?', [
          'The name or team name you enter.',
          'Your location (GPS) every few seconds while the game page is open.',
          'Battery level and the result of the phone check (e.g. whether GPS and sound work).',
          'Game events: role, caught, emergency call, reported means of transport, blocks.',
          'No account, no e-mail address, no phone number, no tracking, no advertising.',
        ]],
        ['Who sees what?', [
          'The game master (and a second supervisor, if any): your location live – for supervision and emergencies.',
          'Hunters: runners’ locations only at ping times; other hunter teams live.',
          'Runners: only their own location. Nobody else sees your battery level or phone check.',
          'After the game, the game master may show the runners’ ping locations as a time-lapse (e.g. on a projector) – blocked pings stay hidden, hunters are never shown.',
        ]],
        ['Where and for how long?', [
          'Only on the game master’s server, not with third parties.',
          'Only your latest location and the locations at ping times (until the next round starts) are stored – no complete movement tracks.',
          days
            ? `The game including all data is deleted automatically ${days} days after the last activity – or earlier by the game master.`
            : 'The game master deletes the game including all data after the game.',
          'On your phone, the page only stores a key for your game, your settings (sound, language) and – if you want – map images for the offline map.',
        ]],
        ['Other services', [
          cfg.tileProxy
            ? 'Map images (© OpenStreetMap contributors) are loaded via the game master’s server – your phone does not connect to OpenStreetMap directly.'
            : 'Map images are loaded directly from the map provider (OpenStreetMap), which sees your IP address in the process.',
          'Only when you tap “Route” does Google Maps open – with the destination, not your location.',
        ]],
        ['Voluntary participation', [
          'Minors take part with their parents’ consent, organised by the school.',
          'You can leave the game or close the page at any time – then no more location data is sent.',
          'You can ask the game master for information about your data or have it deleted.',
        ]],
      ],
    };
  }
  return {
    title: 'Datenschutz – Manhunt',
    intro: 'Manhunt ist ein Fangspiel im Browser. Es wird von deiner Spielleitung (z. B. deiner Schule) auf einem eigenen Server betrieben – nicht von einer App-Firma.',
    sections: [
      ['Wer ist verantwortlich?', [
        'Die Spielleitung, die dieses Spiel auf ihrem eigenen Server betreibt.',
        contact ? `Kontakt: ${contact}` : 'Bei Fragen wende dich an deine Spielleitung.',
      ]],
      ['Welche Daten?', [
        'Der Name oder Teamname, den du eingibst.',
        'Dein Standort (GPS) alle paar Sekunden, solange die Spielseite geöffnet ist.',
        'Akkustand und das Ergebnis des Handy-Checks (z. B. ob GPS und Ton funktionieren).',
        'Spielereignisse: Rolle, gefangen, Notruf, gemeldete Verkehrsmittel, Blocks.',
        'Kein Konto, keine E-Mail-Adresse, keine Telefonnummer, kein Tracking, keine Werbung.',
      ]],
      ['Wer sieht was?', [
        'Die Spielleitung (und ggf. eine zweite Aufsicht): deinen Standort live – zur Aufsicht und für Notfälle.',
        'Jäger: die Standorte der Gejagten nur zu den Ping-Zeitpunkten; andere Jäger-Teams live.',
        'Gejagte: nur den eigenen Standort. Akkustand und Handy-Check sieht nur die Spielleitung.',
        'Nach dem Spiel kann die Spielleitung die Ping-Standorte der Gejagten als Zeitraffer zeigen (z. B. am Beamer) – blockierte Pings bleiben verborgen, Jäger werden nie gezeigt.',
      ]],
      ['Wo und wie lange?', [
        'Nur auf dem Server der Spielleitung, nicht bei Dritten.',
        'Gespeichert wird nur dein letzter Standort und die Standorte zu den Ping-Zeitpunkten (bis zum Start der nächsten Runde) – keine vollständigen Bewegungsspuren.',
        days
          ? `Das Spiel wird mit allen Daten ${days} Tage nach der letzten Aktivität automatisch gelöscht – oder vorher von der Spielleitung.`
          : 'Die Spielleitung löscht das Spiel mit allen Daten nach dem Spiel.',
        'Auf deinem Handy speichert die Seite nur einen Zugangsschlüssel für dein Spiel, deine Einstellungen (Ton, Sprache) und – wenn du willst – Kartenbilder für die Offline-Karte.',
      ]],
      ['Weitere Dienste', [
        cfg.tileProxy
          ? 'Kartenbilder (© OpenStreetMap-Mitwirkende) werden über den Server der Spielleitung geladen – dein Handy verbindet sich dafür nicht direkt mit OpenStreetMap.'
          : 'Kartenbilder werden direkt vom Kartenanbieter (OpenStreetMap) geladen; der sieht dabei deine IP-Adresse.',
        'Nur wenn du auf „Route“ tippst, öffnet sich Google Maps – mit dem Ziel, nicht mit deinem Standort.',
      ]],
      ['Freiwilligkeit', [
        'Minderjährige spielen mit Einverständnis der Eltern mit; das organisiert die Schule.',
        'Du kannst das Spiel jederzeit verlassen oder die Seite schließen – dann wird kein Standort mehr übertragen.',
        'Du kannst bei der Spielleitung Auskunft über deine Daten verlangen oder sie löschen lassen.',
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
