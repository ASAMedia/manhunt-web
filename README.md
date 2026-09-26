# Manhunt – Web

Browserbasiertes Fang- und Versteckspiel („Manhunt“ / „Mister X“) für Gruppen, z. B. auf Klassenfahrt.
Läuft komplett im Browser – **keine App, keine Accounts** – und wird mit Docker selbst gehostet.

- **Spielleitung (Admin):** sieht alle Räume, erstellt Räume, lädt per QR-Code ein, setzt Rollen oder lost sie aus, sieht alle Geräte live auf der Karte.
- **Gejagte** (ein Handy pro Person): werden den Jägern nur zu den Ping-Zeitpunkten gezeigt.
- **Jäger-Teams** (ein Handy pro Team): sehen die letzten Pings der Gejagten und die anderen Jäger-Teams live.

## Funktionen

| | |
|---|---|
| Räume | beliebig viele, nur die Spielleitung kann sie anlegen; Beitritt per QR-Code oder 6-stelligem Code, Beitritt schließbar |
| Rollen | pro Gerät setzen oder „N Gejagte auslosen“ (Rest wird Jäger); wer nach dem Verteilen der Rollen oder während des Spiels beitritt, wird automatisch Jäger |
| Pings | frei wählbares Intervall (1–180 min), erster Ping am Ende des Vorsprungs |
| Extra-Pings | gemeinsamer Vorrat für alle Jäger pro Runde (0–50), nicht während des Vorsprungs |
| Sofort-Ping | die Spielleitung kann jederzeit einen zusätzlichen Ping auslösen |
| Fangen | Gejagte melden sich selbst als gefangen und **werden dann Jäger**; Spielleitung kann korrigieren |
| Spielfeld | Kreis (Mitte auf der Karte wählen + Radius); wer rausgeht, bekommt eine Warnung und wird bei der Spielleitung markiert |
| Nachricht an alle | z. B. „Spielabbruch – alle zum Treffpunkt“, erscheint auf allen Handys (Android vibriert); Schnellknopf „Alle zum Treffpunkt rufen“ |
| **Notfall (SOS)** | roter SOS-Knopf oben rechts, **1,5 s gedrückt halten**. Bei der Spielleitung erscheint auf jeder Admin-Seite eine rote Leiste mit Alarmton, Standort, „Auf Karte“ und Route; „Gesehen“ sieht der Schüler auf dem Handy, „Erledigt“ schließt den Notfall. Der Schüler kann selbst Entwarnung geben. Optional mit Notfall-Telefon der Spielleitung (Anruf-Knopf auf dem Handy) |
| **Treffpunkt** | auf der Karte wählen und benennen; alle sehen ihn auf der Karte (🏁) mit Link zur Fußweg-Route; nach Spielende steht „Alle zum Treffpunkt“ ganz oben |
| **Töne** | Signalton bei Ping, Spielstart/-ende, Gefangen und Nachricht; pro Handy abschaltbar („🔔 Ton an“), z. B. für Gejagte im Versteck |
| **Vorwarnung** | Hinweis + Ton kurz vor jedem Ping (Standard 60 s, einstellbar, 0 = aus) |
| **Verkehrsmittel** (Option) | Mister-X-Stil: Gejagte tippen beim Einsteigen auf 🚇 U-Bahn, 🚆 S-Bahn, 🚌 Bus, 🚊 Tram oder 🚶 zu Fuß; Jäger sehen nur das Verkehrsmittel, nicht die Linie |
| **Schrumpfendes Spielfeld** (Option) | der Kreis wird vom Ende des Vorsprungs bis Spielende gleichmäßig auf einen End-Radius kleiner; End-Kreis ist auf der Karte zu sehen |
| **Regeln** | „📋 Regeln“ auf jedem Handy; Standardregeln aus den Einstellungen oder eigener Text |
| Aufsicht | Spielleitung sieht alle Geräte live, letztes Signal, GPS-Genauigkeit, Akkustand (wo der Browser ihn liefert) |
| **Warnungen** | gelbe Leiste mit leisem Ton, wenn ein Gerät länger als 3 min (einstellbar) kein Signal sendet oder das Spielfeld verlässt; mit „OK“ quittierbar |
| **Zweite Aufsicht** | eigenes Passwort (`SUPERVISOR_PASSWORD`): sieht alles, bearbeitet Notfälle/Warnungen, sendet Nachrichten – kann aber nichts starten, einstellen, entfernen oder löschen |
| **Druckblatt** | A4-Seite mit QR-Code, Code, Kurzanleitung, Eckdaten und Regeln – zum Ausdrucken oder Beamern |
| **Probespiel** | Test-Geräte (3 Gejagte + 2 Jäger), die selbst über die Karte laufen – zum Ausprobieren allein |
| **Auswertung** | pro Runde: wer wann gefangen wurde, wie lange im Spiel, Pings, Notfälle; Export als CSV (Excel). Keine Bewegungsspuren |
| Wiederbeitritt | pro Gerät ein QR-Code, falls ein Handy ausfällt und ein anderes übernimmt |
| Runden | nach Spielende „Neue Runde“ → Startrollen werden wiederhergestellt, neu auslosen möglich |
| Schutz vor Versehen | „Spiel verlassen“, „Aus dem Raum entfernen“ und „Raum löschen“ lösen nur durch **2 s Gedrückthalten** aus (Fortschrittsbalken, Loslassen bricht ab) |
| **Auto-Löschen** | Räume samt Standortdaten werden 7 Tage nach der letzten Aktivität automatisch gelöscht (einstellbar, laufende Spiele nie) |

**Spielende:** Alle Gejagten gefangen → die Jäger gewinnen. Zeit abgelaufen → die verbliebenen Gejagten gewinnen.

## Wichtig: Grenzen einer reinen Web-App

- **Die Seite muss auf jedem Handy geöffnet bleiben und das Display an.** Browser (vor allem iPhone/Safari) stoppen die Standortübertragung, sobald der Bildschirm aus ist oder man die App wechselt. Die Seite hält das Display per „Wake Lock“ wach (Chrome/Android, Safari ab iOS 16.4) und warnt, wenn das nicht klappt.
- **Powerbank einplanen.** GPS + Display an kostet etwa 15–25 % Akku pro Stunde.
- **HTTPS ist Pflicht** – sonst geben Browser keinen Standort heraus. Dafür gibt es unten drei fertige Varianten.
- **Töne:** Browser spielen erst Ton ab, nachdem man die Seite einmal angetippt hat (bei den Spielern passiert das mit „Loslegen“). iPhones sind stumm, wenn der Stummschalter an ist, und vibrieren im Browser nie.
- Der **Notfall-Knopf ersetzt keinen Notruf**: Er alarmiert nur die Spielleitung, solange deren Admin-Seite offen ist. Bei Lebensgefahr 112.
- Die Karte nutzt die Kacheln von OpenStreetMap. Für eine Schulklasse ist das unproblematisch; für große Veranstaltungen `TILE_URL` auf einen anderen Anbieter setzen.

## Installation auf dem Server (fertiges Docker-Image)

Bei jedem Push auf `main` baut GitHub Actions das Image `ghcr.io/asamedia/manhunt-web:latest` (für normale Server und ARM/Raspberry Pi). Auf dem Server braucht es keinen Quellcode – nur Docker und **zwei Dateien** in einem Ordner:

- `docker-compose.yml` (aus diesem Repo)
- `.env` (Vorlage: `.env.example`) – mindestens `ADMIN_PASSWORD` setzen, optional `SUPERVISOR_PASSWORD`

Ist das Image privat, einmalig auf dem Server anmelden (Token mit Recht `read:packages`, selbst eingeben):

```bash
docker login ghcr.io -u ASAMedia
```

Der Server muss während des Spiels online sein. Drei Varianten für HTTPS:

### Variante A: eigene Domain mit automatischem HTTPS (Caddy)

1. DNS-Eintrag (A/AAAA) der Domain auf den Server zeigen lassen, Ports 80 und 443 freigeben.
2. In `.env`: `DOMAIN=manhunt.example.de` und `PUBLIC_URL=https://manhunt.example.de`
3. Starten:

```bash
docker compose --profile caddy pull && docker compose --profile caddy up -d
```

### Variante B: Server mit vorhandenem Reverse Proxy (nginx, Traefik, Caddy …)

Nur die App starten – sie lauscht auf `127.0.0.1:3000` (Port über `LOCAL_PORT` änderbar):

```bash
docker compose pull && docker compose up -d
```

Im vorhandenen Proxy die (Sub-)Domain per HTTPS auf `http://127.0.0.1:3000` weiterleiten und in `.env` `PUBLIC_URL=https://…` setzen. Der Proxy sollte `X-Forwarded-Proto` und `X-Forwarded-For` mitschicken (Standard bei den meisten).
Läuft der Proxy selbst in Docker (z. B. Traefik), statt des Ports das Netzwerk des Proxys an den Dienst `app` hängen.

### Variante C: Cloudflare-Schnelltunnel (kostenlos, ohne Domain und ohne Account)

```bash
docker compose --profile tunnel pull && docker compose --profile tunnel up -d
docker compose logs tunnel | grep trycloudflare
```

Die ausgegebene Adresse `https://….trycloudflare.com` im Browser öffnen und `/admin` anhängen. Die QR-Codes zeigen automatisch auf diese Adresse.

> Die Tunnel-Adresse ändert sich bei jedem Neustart des Tunnels. Also am Spieltag nicht neu starten. Falls doch: Neue Adresse öffnen, bereits beigetretene Geräte über den **Wiederbeitritts-QR** (⋯ in der Geräte-Liste) wieder verbinden.

### Updates

Denselben Befehl wie beim Start noch einmal ausführen (`… pull && … up -d`). Die Spieldaten im Volume `manhunt-data` bleiben erhalten.

### Mit Quellcode arbeiten (lokal)

```bash
npm install
docker compose up -d --build
```

`docker-compose.override.yml` sorgt dafür, dass lokal aus dem Quellcode gebaut wird. Dann `http://localhost:3000/admin` – zum Ausprobieren der Oberfläche. Handys können so nicht mitspielen (kein HTTPS).

## Ablauf am Spieltag

1. `/admin` öffnen, anmelden, **Raum erstellen**.
2. **Einstellungen:** Ping-Intervall, Spieldauer, Vorsprung, Extra-Pings, **Notfall-Telefon**, Vorwarnung, Signal-Alarm, optional Verkehrsmittel und schrumpfendes Spielfeld. „Spielfeld-Mitte auf Karte wählen“ → auf die Karte klicken → Radius eintragen. „Treffpunkt auf Karte wählen“ → klicken → Namen eintragen. Regeln prüfen („Vorschau“). **Speichern**.
3. **Druckblatt** ausdrucken oder beamern, oder **QR groß anzeigen** – alle scannen und geben ihren Namen ein.
4. **Rollen:** einzeln setzen oder „Gejagte auslosen“. Jäger-Teams behalten ein Handy: das Team-Handy benennt sich über „Namen ändern“ um, die anderen melden sich unten mit „Spiel verlassen“ (gedrückt halten) ab.
5. **Kurz erklären:** SOS-Knopf oben rechts gedrückt halten = Notruf an dich; Treffpunkt und Route stehen im Spiel unten.
6. **Beitritt schließen.**
7. Alle tippen auf **„Standort freigeben & loslegen“**. In der Geräte-Liste prüfen, dass jedes Gerät ein frisches Signal hat.
8. **Spiel starten.**

Während des Spiels: Blasse Punkte auf der Karte = seit über einer Minute kein Signal (Display aus? Funkloch?). ⚠ = außerhalb des Spielfelds. Die Admin-Seite muss offen bleiben, damit Notrufe ankommen – einmal auf die Seite klicken, sonst blockiert der Browser den Alarmton.

**Tipp:** Erst allein mit dem **Probespiel** (Test-Geräte) ausprobieren, dann einmal mit 3–4 echten Handys auf dem Schulgelände – inklusive iPhone.

Nach dem Spiel: **Auswertung** im Admin-Bereich (pro Runde, als CSV exportierbar), dann „Neue Runde“.

## Wer sieht was?

| | Spielleitung | Jäger | Gejagte |
|---|---|---|---|
| Position der Gejagten | immer live | nur bei Pings (letzte 4, mit Spur) | nur die eigene |
| Position der Jäger | immer live | andere Jäger-Teams live | nie |
| Wer ist noch frei / gefangen | ✓ | ✓ | ✓ |
| Nachricht der Spielleitung | – | ✓ | ✓ |
| Treffpunkt | ✓ | ✓ | ✓ |
| Verkehrsmittel der Gejagten (Option) | ✓ | ✓ (zuletzt gemeldet) | nur das eigene |
| Notruf eines Schülers | ✓ (mit Standort) | – | – |

## Datenschutz

- Alle Daten liegen nur auf deinem Server (Docker-Volume `manhunt-data`, Datei `state.json`): Namen, letzte Position, Akkustand, Ping-Positionen, Verlauf. Kein Account, keine Tracker, keine Werbung.
- Externe Verbindungen: Kartenkacheln (OpenStreetMap) und – bei Variante A – der Cloudflare-Tunnel. Die „Route“-Links öffnen Google Maps nur, wenn jemand darauf tippt (mit dem Ziel, nicht dem eigenen Standort).
- **Automatisches Löschen:** Räume samt allen Standortdaten werden `AUTO_DELETE_DAYS` Tage (Standard 7) nach der letzten Aktivität gelöscht; laufende Spiele nie. Das Löschdatum steht in der Raumliste. Gelöschte Räume werden sofort auch aus der Datei entfernt.
- Früher löschen: Raum löschen (gedrückt halten) oder alles entfernen mit `docker compose down -v`.
- Standortdaten Minderjähriger: Eltern vorab informieren und Einverständnis einholen (z. B. im Elternbrief zur Klassenfahrt).

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `ADMIN_PASSWORD` | **Pflicht.** Passwort der Spielleitung (mind. 8 Zeichen) |
| `SUPERVISOR_PASSWORD` | optional: Passwort für eine zweite Aufsicht (mind. 8 Zeichen, anders als `ADMIN_PASSWORD`) |
| `MANHUNT_IMAGE` | optional: anderes Image statt `ghcr.io/asamedia/manhunt-web:latest` |
| `PUBLIC_URL` | feste Adresse für QR-Codes; leer = Adresse, über die die Admin-Seite geöffnet wurde |
| `DOMAIN` | nur Variante B: Domain für Caddy |
| `MAP_CENTER` | Kartenmitte beim Öffnen, `lat,lng` (Standard: Berlin-Mitte) |
| `AUTO_DELETE_DAYS` | Tage bis zum automatischen Löschen nach der letzten Aktivität (Standard 7, `0` = nie) |
| `TILE_URL`, `TILE_ATTRIBUTION` | anderer Kartenanbieter |
| `LOCAL_PORT` | lokaler Port (Standard 3000) |

## Ohne Docker

```bash
npm install
ADMIN_PASSWORD=… node server.js
```

Node.js ≥ 20. Daten landen dann in `./data`.
