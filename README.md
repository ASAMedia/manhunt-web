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
| Pings | frei wählbares Intervall (1–180 min), erster Ping am Ende des Vorsprungs; **Vorwarnung** kurz vorher |
| Extra-Pings | gemeinsamer Vorrat für alle Jäger; die Spielleitung kann jederzeit einen Sofort-Ping auslösen |
| **Blocks** | jeder Gejagte darf (einstellbar, Standard 1×) den nächsten Ping aussetzen und bleibt dabei unsichtbar |
| Fangen | Gejagte melden sich selbst als gefangen und **werden dann Jäger**; die Spielleitung kann korrigieren |
| Spielfeld | Kreis auf der Karte; optional **schrumpfend** bis Spielende |
| Verkehrsmittel (Option) | Mister-X-Stil: Gejagte melden U-Bahn, S-Bahn, Bus, Tram oder zu Fuß – Jäger sehen nur die Art |
| Treffpunkt | auf der Karte mit Fußweg-Route; nach Spielende „Alle zum Treffpunkt“ |
| Regeln | „📋 Regeln“ auf jedem Handy – Standardregeln aus den Einstellungen oder eigener Text |
| Töne | bei Ping, Vorwarnung, Start, Gefangen, Nachricht; pro Handy abschaltbar |
| Sprachen | Spielerseiten auf **Deutsch und Englisch** (automatisch nach Handy-Sprache, umschaltbar) |

**Sicherheit & Aufsicht**

| | |
|---|---|
| **Notfall (SOS)** | SOS-Knopf 1,5 s gedrückt halten → rote Alarmleiste mit Ton auf jeder Admin-Seite, Standort, Route; „Gesehen“ sieht der Schüler; optional Anruf-Knopf mit Notfall-Telefon |
| **Warnungen** | gelbe Leiste, wenn ein Gerät einige Minuten kein Signal sendet oder das Spielfeld verlässt; gebündelt, quittierbar |
| **Handy-Check** | prüft vor dem Start Standort, Display-an, Ton, Akku, Vibration mit Tipps für iPhone/Android; Ergebnis in der Geräte-Liste („Check ✓/⚠“) |
| Live-Übersicht | alle Geräte auf der Karte, letztes Signal, GPS-Genauigkeit, Akku |
| Nachricht an alle | z. B. Spielabbruch; Schnellknopf „Alle zum Treffpunkt rufen“ |
| Wiederbeitritt | QR-Code pro Gerät, falls ein Handy ausfällt |
| Schutz vor Versehen | „Spiel verlassen“, „Aus dem Raum entfernen“, „Raum löschen“ nur durch 2 s Gedrückthalten |

**Vorbereitung & Nachbereitung**

| | |
|---|---|
| Druckblatt | A4 mit QR-Code, Kurzanleitung, Eckdaten und Regeln – zum Ausdrucken oder Beamern |
| Probespiel | Test-Geräte, die selbst über die Karte laufen – zum Ausprobieren allein |
| Auswertung | pro Runde: wer wann gefangen wurde, Pings, Blocks, Notfälle; CSV-Export (Excel); keine Bewegungsspuren |
| Hilfe | `/hilfe` – Kurzanleitung für Spielleitung und Aufsicht (druckbar) |
| Datenschutz | `/datenschutz` – für Schüler und Eltern, Deutsch/Englisch, passend zur Konfiguration |

**Technik**

| | |
|---|---|
| Als App installierbar | „Zum Home-Bildschirm“ mit Icon und Vollbild; die installierte App weiß, in welchem Spiel man ist |
| Offline-Karte | Kartenkacheln laufen über einen Zwischenspeicher auf deinem Server; im Handy-Check „Karte speichern“ lädt das Spielfeld für Funklöcher (U-Bahn) vor |
| Automatisches Löschen | Räume samt Standortdaten 7 Tage nach der letzten Aktivität (einstellbar, laufende Spiele nie) |
| Tests | über 160 automatische Prüfungen (`npm test`), laufen auf GitHub vor jedem Image-Build |
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

In der `.env` wählt `COMPOSE_PROFILES`, welche Zusatzdienste laufen:

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

> **Tunnel:** Die Adresse ändert sich bei jedem Neustart des Tunnels. Am Spieltag also nicht neu starten; falls doch, beigetretene Geräte über den Wiederbeitritts-QR (⋯ in der Geräte-Liste) wieder verbinden.

> **Vorhandener Reverse Proxy:** die (Sub-)Domain per HTTPS auf `http://127.0.0.1:3000` weiterleiten, `PUBLIC_URL=https://…` setzen. Läuft der Proxy selbst in Docker, statt des Ports sein Netzwerk an den Dienst `app` hängen.

## Ablauf am Spieltag

1. `/admin` öffnen, anmelden, **Raum erstellen**.
2. **Einstellungen:** Ping-Intervall, Dauer, Vorsprung, Extra-Pings, Blocks, Notfall-Telefon, Vorwarnung, Signal-Alarm, optional Verkehrsmittel und schrumpfendes Spielfeld. Spielfeld und Treffpunkt auf der Karte wählen. Regeln prüfen („Vorschau“). **Speichern**.
3. **Druckblatt** beamern oder **QR groß anzeigen** – alle treten bei und tippen „Standort freigeben & loslegen“.
4. **Handy-Check** abwarten, bis möglichst alle „Check ✓“ haben; dabei „Karte speichern“ für Funklöcher.
5. **Rollen** setzen oder auslosen. Jäger-Teams behalten ein Handy, die anderen melden sich unten mit „Spiel verlassen“ ab.
6. SOS-Knopf kurz erklären, **Beitritt schließen**, **Spiel starten**.
7. Danach: **Auswertung** ansehen, „Neue Runde“.

**Tipp:** Erst allein mit dem **Probespiel** ausprobieren, dann einmal mit 3–4 echten Handys – inklusive iPhone. Die Kurzanleitung für Kolleg:innen steht unter `/hilfe`.

## Wer sieht was?

| | Spielleitung / Aufsicht | Jäger | Gejagte |
|---|---|---|---|
| Position der Gejagten | immer live | nur bei Pings (letzte 4, mit Spur); bei Block nicht | nur die eigene |
| Position der Jäger | immer live | andere Jäger-Teams live | nie |
| Verkehrsmittel der Gejagten (Option) | ✓ | ✓ (zuletzt gemeldet) | nur das eigene |
| Wer ist frei / gefangen | ✓ | ✓ | ✓ |
| Notruf, Akku, Handy-Check | ✓ | – | nur eigener |

## Datenschutz

- Alle Daten liegen nur auf deinem Server (Docker-Volume `manhunt-data`): Namen, letzter Standort, Standorte zu den Pings, Akkustand, Handy-Check, Verlauf. Kein Account, keine Tracker, keine Werbung.
- **Kartenkacheln** kommen über deinen Server (Zwischenspeicher, `TILE_PROXY=1`): Die Handys verbinden sich nicht mit OpenStreetMap, jede Kachel wird nur einmal geholt. „Route“-Links öffnen Google Maps nur auf Tippen (mit dem Ziel, nicht dem Standort).
- **Automatisches Löschen** nach `AUTO_DELETE_DAYS` Tagen (Standard 7); Löschungen werden sofort gespeichert. Früher löschen: Raum löschen oder `docker compose down -v`.
- Die Seite `/datenschutz` erklärt das Schülern und Eltern; `PRIVACY_CONTACT` nennt dort den Ansprechpartner.
- Standortdaten Minderjähriger: Eltern vorab informieren und Einverständnis einholen (z. B. im Elternbrief).

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `ADMIN_PASSWORD` | **Pflicht.** Passwort der Spielleitung (mind. 8 Zeichen) |
| `SUPERVISOR_PASSWORD` | Passwort für die Aufsicht (mind. 8 Zeichen, anders als `ADMIN_PASSWORD`) |
| `COMPOSE_PROFILES` | Zusatzdienste: `caddy`, `tunnel`, `autoupdate` (kommagetrennt) |
| `PUBLIC_URL` | feste Adresse für QR-Codes; leer = Adresse der Admin-Seite |
| `DOMAIN` | Domain für das Caddy-Profil |
| `PRIVACY_CONTACT` | Ansprechpartner auf der Datenschutz-Seite |
| `AUTO_DELETE_DAYS` | Tage bis zum automatischen Löschen (Standard 7, `0` = nie) |
| `TILE_PROXY` | Karten über den Server zwischenspeichern (Standard `1`) |
| `MAP_CENTER` | Kartenmitte beim Öffnen, `lat,lng` (Standard: Berlin-Mitte) |
| `TILE_URL`, `TILE_ATTRIBUTION` | anderer Kartenanbieter |
| `LOCAL_PORT` | lokaler Port (Standard 3000) |
| `MANHUNT_IMAGE` | anderes Image statt `ghcr.io/asamedia/manhunt-web:latest` |

## Entwicklung

```bash
npm install
npm test
docker compose up -d --build
```

`npm test` startet einen eigenen Testserver (freier Port, Testdaten, Schein-Kartenserver) und prüft Spielablauf, Rechte, Notfälle, Warnungen, Blocks, Handy-Check, Kacheln, Manifest, Export und automatisches Löschen. `docker-compose.override.yml` sorgt dafür, dass lokal aus dem Quellcode gebaut wird (`http://localhost:3000/admin`). Node.js ≥ 20.
