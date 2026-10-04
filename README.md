# Manhunt – Web

Browserbasiertes Fang- und Versteckspiel („Manhunt“ / „Mister X“) für Gruppen, z. B. auf Klassenfahrt.
Läuft im Browser – **keine App aus dem Store, keine Accounts** – und wird mit Docker selbst gehostet.

- **Spielleitung (Admin):** erstellt Räume, lädt per QR-Code ein, setzt oder lost Rollen aus, sieht alle Geräte live auf der Karte.
- **Aufsicht (optional):** eine zweite Person mit eigenem Passwort, die zusieht und Notfälle bearbeitet.
- **Gejagte** (ein Handy pro Person): werden den Jägern nur zu den Ping-Zeitpunkten gezeigt.
- **Jäger-Teams** (ein Handy pro Team): sehen die letzten Pings der Gejagten und die anderen Jäger-Teams live.

## Funktionen

**Spiel**

| | |
|---|---|
| Räume & Beitritt | beliebig viele Räume; Beitritt per QR-Code oder 6-stelligem Code; Beitritt schließbar |
| Rollen | pro Gerät setzen oder „N Gejagte auslosen“; wer später beitritt, wird automatisch Jäger |
| Pings | frei wählbares Intervall (1–180 min), erster Ping am Ende des Vorsprungs; **Vorwarnung** kurz vorher. Beim Ping sehen die Jäger die Gejagten – und die Gejagten die Jäger (jeweils als Momentaufnahme, beschriftet mit dem **Alter**, z. B. „vor 3 min“) |
| Extra-Pings | gemeinsamer Vorrat für alle Jäger; die Spielleitung kann jederzeit einen Sofort-Ping auslösen |
| **Blocks** | jeder Gejagte darf (einstellbar, Standard 1×) den nächsten Ping aussetzen und bleibt dabei unsichtbar |
| Fangen | Gejagte melden sich selbst als gefangen und **werden dann Jäger**; die Spielleitung kann korrigieren |
| Spielfeld | **Kreis oder frei gezeichnete Fläche** (z. B. entlang von Spree und S-Bahn-Ring); optional **schrumpfend** bis Spielende – bei Flächen nur, wenn sie dabei nicht aus sich herauswandern (keine U- oder L-Formen) |
| Verkehrsmittel (Option) | Mister-X-Stil: Gejagte melden U-Bahn, S-Bahn, Bus, Tram oder zu Fuß – Jäger sehen nur die Art |
| **Endspurt** | 5 Minuten vor Schluss Banner und Ton auf allen Handys; bei Spielende automatisch „Alle zum Treffpunkt“ mit Fußweg-Route |
| **Spielzeit ändern** | „+10 min“ / „−10 min“ im laufenden Spiel (nur diese Runde); alle Handys bekommen Bescheid, ein schrumpfendes Spielfeld schrumpft gleichmäßig bis zum neuen Ende |
| **Funkloch-Puffer** | „Ich wurde gefangen“, Verkehrsmittel, Block und SOS gehen ohne Netz (U-Bahn) nicht verloren: Sie warten auf dem Handy – auch über Neuladen hinweg – und werden mit dem Zeitpunkt des Tipps nachgesendet. SOS zeigt im Funkloch sofort die Notfallnummer |
| Treffpunkt | auf der Karte mit Fußweg-Route |
| **Kurzanleitung** | beim ersten Öffnen drei Schritte passend zur Rolle (Lobby, Gejagt, Jäger), einmal pro Handy; danach oben im Regel-Fenster |
| Regeln | „📋 Regeln“ auf jedem Handy – Standardregeln aus den Einstellungen oder eigener Text |
| Töne | bei Ping, Vorwarnung, Start, Gefangen, Nachricht, Endspurt; pro Handy abschaltbar |
| Sprachen | Spielerseiten auf **Deutsch und Englisch** (automatisch nach Handy-Sprache, umschaltbar) |
| Karte | Jäger **orange**, Gejagte blau – **Rot nur für Notfälle**; Schilder weichen einander aus (verdeckte zeigt ein Antippen), eigener Punkt mit Pfeil in Laufrichtung, **Radar-Ringe** beim Ping; Symbolleiste für Zentrieren, Regeln, Ton, Sonne, Check |
| **Sonnenmodus** | „☀️ Sonnenmodus“ auf dem Handy: maximaler Kontrast, größere Schrift und Kartenbeschriftung für draußen |

**Sicherheit & Aufsicht**

| | |
|---|---|
| **Notfall (SOS)** | SOS-Knopf 1,5 s gedrückt halten → rote Alarmleiste mit Ton auf jeder Admin-Seite, Standort, Route; „Gesehen“ sieht der Schüler; optional Anruf-Knopf mit Notfall-Telefon |
| **Warnungen** | gelbe Leiste, wenn ein Gerät einige Minuten kein Signal sendet, das Spielfeld verlässt (mit 20 m Toleranz gegen GPS-Zittern), nach dem Verteilen der Rollen neu beitritt oder der **Akku unter 15 %** fällt (Android; iPhones melden den Akkustand nicht); gebündelt, quittierbar |
| **Handy-Check** | prüft vor dem Start Standort, Display-an, Ton, Akku, Vibration mit Tipps für iPhone/Android; Ergebnis in der Geräte-Liste („Check ✓/⚠“) |
| **Alarm-Absicherung** | solange ein Spiel läuft, hält die Admin-Seite das Display an; rotes Banner „Keine Verbindung – Alarme kommen nicht an“, wenn das Handy der Spielleitung kein Netz hat; Knopf „🔊 Alarmton testen“ |
| **Einsatz-Ansicht** | im laufenden Spiel auf dem Handy automatisch: nur Warnungen, Zähler, Karte, Sofort-Ping/Treffpunkt/Beenden, Geräte (Probleme zuerst) und Nachricht; „Alles anzeigen“ schaltet um |
| Live-Übersicht | alle Geräte auf der Karte, letztes Signal, GPS-Genauigkeit; Geräte-Liste mit **Ampelpunkt** und **Akku-Symbol**; am Computer **Reiter** (Spiel · Geräte · Einstellungen · Auswertung), die Karte bleibt rechts |
| Nachricht an alle | z. B. Spielabbruch; Schnellknopf „Alle zum Treffpunkt rufen“ |
| Wiederbeitritt | QR-Code pro Gerät, falls ein Handy ausfällt |
| Schutz vor Versehen | „Spiel verlassen“, „Aus dem Raum entfernen“, „Raum löschen“ nur durch 2 s Gedrückthalten; „Alle Geräte entfernen“ (nicht im laufenden Spiel) durch 3 s |

**Vorbereitung & Nachbereitung**

| | |
|---|---|
| Druckblatt | A4 mit QR-Code, Kurzanleitung, Eckdaten und Regeln – zum Ausdrucken oder Beamern |
| **Notfallkarten** | 6 Karten pro A4-Seite für die Gruppen: Treffpunkt mit QR zur Route, Rückkehrzeit, Nummern, was tun, wenn App oder Handy ausfallen |
| **Einrichtungs-Check** | Karte oben in der Raumliste: prüft HTTPS, öffentliche Adresse, ob der Proxy die Handy-Adressen weitergibt, Passwort, Datenschutz-Angaben, Löschfrist, Kartenserver, Speicher, liegengebliebene Test-Geräte, Uhrzeit |
| Probespiel | Test-Geräte, die selbst über die Karte laufen – zum Ausprobieren allein |
| **Raum kopieren** | Spielfeld, Treffpunkt, Regeln und alle Einstellungen in einen neuen Raum übernehmen (ohne Geräte) – z. B. für die zweite Klasse oder Runde |
| Auswertung | pro Runde: wer wann gefangen wurde, Pings, Blocks, Notfälle; CSV-Export (Excel); keine Bewegungsspuren |
| **Ping-Replay** | `/replay` – nach Spielende alle Pings der Runde als Zeitraffer für den Beamer: eine Farbe pro Gejagtem, Blocks, Fänge, schrumpfendes Spielfeld; bis zum Start der nächsten Runde |
| Hilfe | `/hilfe` – Kurzanleitung für Spielleitung und Aufsicht (druckbar) |
| Datenschutz | `/datenschutz` – für Schüler und Eltern, Deutsch/Englisch, passend zur Konfiguration |

**Technik**

| | |
|---|---|
| Als App installierbar | „Zum Home-Bildschirm“ mit Icon und Vollbild; die installierte App weiß, in welchem Spiel man ist |
| Offline-Karte | Kartenkacheln laufen über einen Zwischenspeicher auf deinem Server; im Handy-Check „Karte speichern“ lädt das Spielfeld für Funklöcher (U-Bahn) vor |
| Automatisches Löschen | Räume samt Standortdaten 7 Tage nach der letzten Aktivität (einstellbar, laufende Spiele nie) |
| Akku sparen | Handys fragen nur so oft wie nötig ab (Jäger 3 s, sonst 5–15 s) und senden den Standort bei Bewegung bzw. alle 20 s – kurz vor jedem Ping aber alle 3 s |
| **Fehlerberichte** | Skriptfehler auf Handys landen im Server-Log und unten in der Raumliste – ohne Namen, Standort oder Spieler-Link |
| Version | steht unten im Admin-Bereich (mit Commit und Build-Datum) |
| Tests | über 190 automatische Prüfungen (`npm test`), Linting, `npm audit` und Image-Scan laufen auf GitHub vor bzw. nach jedem Image-Build |
| Automatische Updates | optional, nachts um 4 Uhr |

**Spielende:** Alle Gejagten gefangen → die Jäger gewinnen. Zeit abgelaufen → die verbliebenen Gejagten gewinnen.

## Wichtig: Grenzen einer Web-App

- **Die Seite muss auf jedem Handy geöffnet bleiben und das Display an.** Browser (vor allem iPhone/Safari) stoppen die Standortübertragung, sobald der Bildschirm aus ist. Die Seite hält das Display per „Wake Lock“ wach; der Handy-Check zeigt, wo das nicht klappt, und gibt Tipps.
- **Powerbank einplanen.** GPS + Display an kostet etwa 15–25 % Akku pro Stunde.
- **HTTPS ist Pflicht** – sonst gibt es keinen Standort. Dafür gibt es unten drei fertige Varianten.
- **Töne:** Browser spielen erst Ton ab, nachdem man die Seite angetippt hat. iPhones sind bei Stummschalter stumm und vibrieren im Browser nie.
- Der **Notfall-Knopf ersetzt keinen Notruf**: Er alarmiert nur die Spielleitung, solange deren Admin-Seite offen ist. Bei Lebensgefahr 112.

## Installation auf dem Server

Bei jedem Push auf `main` testet GitHub Actions den Code und baut dann das Image `ghcr.io/asamedia/manhunt-web:latest` (für normale Server und ARM/Raspberry Pi). Auf dem Server braucht es nur Docker und **zwei Dateien** in einem Ordner:

- `docker-compose.yml` (aus diesem Repo)
- `.env` (Vorlage: `.env.example`) – mindestens `ADMIN_PASSWORD` setzen

In der `.env` wählt `COMPOSE_PROFILES`, welche Zusatzdienste laufen – standardmäßig keiner (nur die App). Nur eintragen, was du brauchst:

| Profil | Wofür |
|---|---|
| `caddy` | eigene Domain mit automatischem HTTPS – `DOMAIN` und `PUBLIC_URL` setzen, DNS auf den Server, Ports 80/443 frei |
| `tunnel` | kostenloser Cloudflare-Schnelltunnel ohne Domain – Adresse mit `docker compose logs tunnel` |
| `autoupdate` | holt neue Versionen automatisch, täglich 4 Uhr nachts ([Watchtower-Nachfolger](https://github.com/nicholas-fedor/watchtower), braucht Zugriff auf den Docker-Socket) |
| *(keins)* | nur die App auf `http://127.0.0.1:3000` – für einen vorhandenen Reverse Proxy (nginx, Traefik …) |

Starten und später aktualisieren – immer derselbe Befehl:

```bash
docker compose pull && docker compose up -d
```

Ist das Image privat, einmalig auf dem Server anmelden (Token mit Recht `read:packages`, selbst eingeben): `docker login ghcr.io -u ASAMedia`.

> **Zusatzdienst abschalten:** Aus `COMPOSE_PROFILES` herausnehmen reicht nicht – ein schon laufender Container läuft weiter. Zusätzlich `docker compose rm -sf caddy` (bzw. `tunnel`, `autoupdate`) ausführen.

> **Während der Klassenfahrt:** `autoupdate` aus `COMPOSE_PROFILES` nehmen und `docker compose rm -sf autoupdate` – dann ändert sich bis zur Rückkehr nichts mehr am Server.

> **Tunnel nur zum Ausprobieren:** Beim Cloudflare-Schnelltunnel läuft der gesamte Verkehr (inkl. Standorte) für Cloudflare lesbar über dessen Server (USA), und ohne Konto gibt es keinen Auftragsverarbeitungsvertrag. Für Spiele mit Schülern daher eine eigene Domain mit dem Profil `caddy` auf einem Server in der EU nutzen.

> **Tunnel:** Die Adresse ändert sich bei jedem Neustart des Tunnels. Am Spieltag also nicht neu starten; falls doch, beigetretene Geräte über den Wiederbeitritts-QR (⋯ in der Geräte-Liste) wieder verbinden.

### Hinter einem vorhandenen Reverse Proxy

In der `.env`: `COMPOSE_PROFILES` leer lassen (höchstens `autoupdate`) – **kein `caddy`**, der würde mit deinem Proxy um die Ports 80/443 streiten –, `PUBLIC_URL=https://manhunt.example.de`. Die App lauscht dann auf `http://127.0.0.1:3000` (`LOCAL_PORT`). Der Proxy muss HTTPS machen, die Adresse des Handys an `X-Forwarded-For` **anhängen** (die App wertet den letzten Eintrag aus) und `X-Forwarded-Proto` setzen. Beispiel für nginx:

```nginx
server {
    listen 443 ssl;
    server_name manhunt.example.de;
    # ssl_certificate / ssl_certificate_key – z. B. von certbot

    access_log off;               # Wiederbeitritts-Links (/r/…) sind Zugangsschlüssel – nicht protokollieren
    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy auf dem Host (`reverse_proxy 127.0.0.1:3000`), Traefik und Nginx Proxy Manager setzen diese Header von selbst. Läuft der Proxy selbst in Docker, erreicht er `127.0.0.1` des Hosts nicht – dann sein Docker-Netzwerk an den Dienst `app` hängen und auf `http://app:3000` weiterleiten. Zugriffs-Logs möglichst ausschalten.

**Danach prüfen:** `/admin` über die öffentliche Adresse öffnen – der **Einrichtungs-Check** oben in der Raumliste zeigt, ob HTTPS und die Handy-Adressen richtig ankommen (bei „Adressen hinter dem Proxy“ muss deine echte öffentliche Adresse stehen).

## Ablauf am Spieltag

1. `/admin` öffnen, anmelden, **Raum erstellen**.
2. **Einstellungen:** Ping-Intervall, Dauer, Vorsprung, Extra-Pings, Blocks, Notfall-Telefon, Vorwarnung, Signal-Alarm, optional Verkehrsmittel und schrumpfendes Spielfeld. Spielfeld (Kreis: Mitte anklicken; Fläche: Ecken nacheinander anklicken, „Fläche fertig“) und Treffpunkt auf der Karte wählen. Regeln prüfen („Vorschau“). **Speichern**.
3. **Druckblatt** beamern oder **QR groß anzeigen** – alle treten bei und tippen „Standort freigeben & loslegen“.
4. **Handy-Check** abwarten, bis möglichst alle „Check ✓“ haben; dabei „Karte speichern“ für Funklöcher.
5. **Rollen** setzen oder auslosen. Jäger-Teams behalten ein Handy, die anderen melden sich unten mit „Spiel verlassen“ ab.
6. SOS-Knopf kurz erklären, **Beitritt schließen**, einmal **„🔊 Alarmton testen“** (Lautstärke!), **Spiel starten**. Unterwegs zeigt das Handy der Spielleitung die kompakte **Einsatz-Ansicht**.
7. Danach: **Auswertung** ansehen, abends das **Ping-Replay** zeigen, „Neue Runde“.

**Tipp:** Erst allein mit dem **Probespiel** ausprobieren, dann einmal mit 3–4 echten Handys – inklusive iPhone. Die Kurzanleitung für Kolleg:innen steht unter `/hilfe`.

## Wer sieht was?

| | Spielleitung / Aufsicht | Jäger | Gejagte |
|---|---|---|---|
| Position der Gejagten | immer live | nur im laufenden Spiel und nur bei Pings (letzte 4, mit Spur); bei Block nicht | nie (nur die eigene) |
| Position der Jäger | immer live | nur im laufenden Spiel: andere Jäger-Teams live | nur im laufenden Spiel und nur bei Pings (Momentaufnahme bis zum nächsten Ping) |
| Verkehrsmittel der Gejagten (Option) | ✓ | nur im laufenden Spiel (zuletzt gemeldet) | nur das eigene |
| Nach Spielende | ✓ | keine Standorte mehr | keine Standorte |
| Ping-Replay (erst nach Spielende) | ✓ – z. B. am Beamer für alle; Pings mit Verbindungslinien, ohne Blocks und Jäger | – | – |
| Namen, Rollen, wer ist frei / gefangen | ✓ | ✓ | ✓ |
| Notruf, Akku, Handy-Check | ✓ | – | nur eigener |

## Datenschutz

- **Verantwortlich ist die Schule.** In der `.env` `PRIVACY_CONTROLLER` (Schule), `PRIVACY_CONTACT` (Datenschutzbeauftragte/r) und ggf. `PRIVACY_HOSTING` (Hoster) eintragen – die Seite `/datenschutz` zeigt sie an. Sie erklärt Schülern und Eltern Zweck, Rechtsgrundlage (Einwilligung), alle Datenarten, Empfänger, Fristen und Rechte (Stand-Datum im Text).
- Alle Daten liegen nur auf deinem Server (Docker-Volume `manhunt-data`): Namen, letzter Standort, Standorte zu den Pings (bis zum Start der nächsten Runde) und beim Notruf, Akku- und Gerätestatus, Verlauf, Auswertung. Keine Konten, keine Werbe- oder Analyse-Tracker.
- **Wann wird der Standort gesendet?** Erst nachdem auf dem Handy „Standort freigeben & loslegen“ getippt wurde – bei jedem Öffnen der Seite neu. In Lobby und laufendem Spiel nimmt der Server ihn an, nach Spielende noch 2 Stunden (Rückweg). Standortmeldungen verlängern die Aufbewahrung nicht (gezählt werden nur Ereignisse wie Beitritt, Rundenstart, Aktionen der Spielleitung).
- **IP-Adressen** liegen nur kurz im Arbeitsspeicher (Rate-Limits, höchstens 15 Minuten) und werden nicht protokolliert. Zugriffs-Logs des Proxys aus lassen.
- **Kartenkacheln** kommen über deinen Server (Zwischenspeicher, `TILE_PROXY=1`): Die Handys verbinden sich nicht mit OpenStreetMap. „Route“-Links öffnen Google Maps nur auf Tippen – Google berechnet die Route dann vom Standort des Handys aus.
- **Automatisches Löschen** nach `AUTO_DELETE_DAYS` Tagen ohne Aktivität (Standard 7); Löschungen werden sofort gespeichert. Früher löschen: Raum löschen oder `docker compose down -v`. Heruntergeladene CSV-Dateien nach der Fahrt selbst löschen.
- **Auf den Handys** liegen Zugangsschlüssel, Spielstand und Offline-Speicher (Programm, angesehene Kartenbilder); beim Verlassen oder Entfernen löscht die Seite sie selbst. Wiederbeitritts-Links (Zugangsschlüssel) stehen nie in Adressen oder im Offline-Speicher.
- Suchmaschinen sind ausgesperrt (`robots.txt` und `X-Robots-Tag: noindex`).
- Wer nach dem Verteilen der Rollen oder während des Spiels beitritt, wird Jäger – die Aufsicht bekommt dazu eine gelbe Warnung „Neu beigetreten“ und kann unbekannte Geräte entfernen. Am sichersten: vor dem Start **Beitritt schließen**.
- Fehlerberichte von Handys enthalten keine Namen, Standorte, Spieler-Links oder Spielcodes; sie liegen bis zum Neustart im Arbeitsspeicher (max. 100) und im Container-Log (begrenzt auf 3 × 10 MB).
- Standortdaten Minderjähriger: Einwilligung der Eltern einholen (Elternbrief), Datenschutzbeauftragte/n der Schule vorher einbinden – eine Datenschutz-Folgenabschätzung kann nötig sein.

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `ADMIN_PASSWORD` | **Pflicht.** Passwort der Spielleitung (mind. 8 Zeichen) |
| `SUPERVISOR_PASSWORD` | Passwort für die Aufsicht (mind. 8 Zeichen, anders als `ADMIN_PASSWORD`) |
| `COMPOSE_PROFILES` | Zusatzdienste: `caddy`, `tunnel`, `autoupdate` (kommagetrennt) |
| `PUBLIC_URL` | feste Adresse für QR-Codes; leer = Adresse der Admin-Seite |
| `DOMAIN` | Domain für das Caddy-Profil |
| `PRIVACY_CONTROLLER` | Verantwortliche Schule (Name, Anschrift) für die Datenschutz-Seite |
| `PRIVACY_CONTACT` | Datenschutz-Kontakt (Datenschutzbeauftragte/r der Schule) |
| `PRIVACY_HOSTING` | Hosting-Anbieter und Standort des Servers (Auftragsverarbeiter), leer bei eigenem Gerät |
| `AUTO_DELETE_DAYS` | Tage bis zum automatischen Löschen (Standard 7, `0` = nie) |
| `TILE_PROXY` | Karten über den Server zwischenspeichern (Standard `1`) |
| `TILE_CACHE_MAX_MB` | Obergrenze für den Kartenspeicher (Standard 1000 MB) |
| `MAP_CENTER` | Kartenmitte beim Öffnen, `lat,lng` (Standard: Berlin-Mitte) |
| `TILE_URL`, `TILE_ATTRIBUTION` | anderer Kartenanbieter |
| `LOCAL_PORT` | lokaler Port (Standard 3000) |
| `MANHUNT_IMAGE` | anderes Image statt `ghcr.io/asamedia/manhunt-web:latest` |

## Entwicklung

```bash
npm install
npm run lint
npm test
npm run loadtest -- --phones 60 --minutes 30
docker compose up -d --build
```

`npm test` startet einen eigenen Testserver (freier Port, Testdaten, Schein-Kartenserver) und prüft Spielablauf, Rechte, Notfälle, Warnungen, Blocks, Handy-Check, Kacheln, Manifest, Export und automatisches Löschen. `npm run loadtest` simuliert viele Handys mit dem echten Abfrage- und Sende-Rhythmus und meldet Antwortzeiten, Fehler, CPU und RAM – auch gegen einen laufenden Server: `LOAD_ADMIN_PASSWORD=… npm run loadtest -- --base http://localhost:3000 --container <Containername>`.

Aufbau: `server.js` startet nur; die Logik liegt in `src/` (`game.js` Spielregeln, `views.js` wer was sieht, `routes/` API, `http.js` Anmeldung/Sicherheit, `tiles.js` Karten-Zwischenspeicher, `store.js` Speichern). `docker-compose.override.yml` sorgt dafür, dass lokal aus dem Quellcode gebaut wird (`http://localhost:3000/admin`). Node.js ≥ 20.
