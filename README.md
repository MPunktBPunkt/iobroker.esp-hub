# iobroker.esp-hub

![Version](https://img.shields.io/badge/version-0.4.3-blue)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)

> **ESP32 & ESP8266 Hub** für ioBroker — zentrale Verwaltung, USB-Programmierung und Kompilierung direkt im Browser.

---

## Features

- 📡 **Geräteverwaltung** — ESP32/ESP8266 registrieren sich per Heartbeat, Status als ioBroker-States
- 🔌 **USB-Programmierung** — esptool.py wird automatisch installiert, ESP erkennen + direkt flashen
- 💻 **Serieller Monitor** — Live-Debug-Ausgabe vom ESP direkt im Browser
- ⚙️ **Compiler** — arduino-cli Auto-Install, .ino hochladen, kompilieren, flashen
- 📚 **Bibliotheks-Manager** — 20+ Bibliotheken in 6 Kategorien per Checkbox installieren
- 🚀 **OTA-Updates** — Firmware per WLAN auf laufende ESPs verteilen
- 🧩 **ioBroker States** — IP, Version, RSSI, Uptime, Heap, IO-Werte pro Gerät

---

## Quickstart

### Adapter installieren

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.esp-hub
iobroker add esp-hub
iobroker start esp-hub
```

### Adapter aktualisieren

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.esp-hub
iobroker restart esp-hub
```

Web-UI: `http://<ioBroker-IP>:8093`

---

## Konfiguration

| Parameter | Standard | Beschreibung |
|---|---|---|
| Web-UI Port | `8093` | HTTP-Port für Web-Interface + ESP-API |
| Adapter-Host | `192.168.178.1` | IP des ioBroker-Hosts für OTA-URLs |
| Heartbeat-Intervall | `30` | Sekunden zwischen ESP-Heartbeats |

---

## Web-Dashboard

| Tab | Inhalt |
|---|---|
| 📡 Geräte | Alle ESPs mit Chip-Badge, Flash-Balken, Pinout-Panel, OTA-Push |
| 🔌 Programmieren | ESP erkennen, USB-Flash, Serieller Monitor |
| ⚙️ Kompilieren | arduino-cli, Bibliotheks-Manager, .ino → .bin |
| 📋 Logs | Adapter-Logs mit Filter und Export |
| 🔧 System | Firmware hochladen, Versionsprüfung, Self-Update |

---

## ESP-Firmware (esp32.EspHub)

Die Standard-Firmware `esp-hub-base` wird direkt mit dem Adapter mitgeliefert und erscheint automatisch im Firmware-Dropdown. Für den Wemos D1 Mini ESP32 ist eine vorkompilierte .bin enthalten — einfach USB anschließen und flashen.

### Eigene Firmware kompilieren

1. **Kompilieren-Tab** → `+ ESP32 Board-Paket` installieren
2. **📚 Bibliotheken** → WiFiManager + ArduinoJson auswählen → installieren
3. `.ino` per Drag & Drop hochladen
4. Board wählen → **⚡ Kompilieren**
5. .bin erscheint automatisch im Programmieren-Tab

### Partition Scheme (Speicheraufteilung)

Für den ESP32-S3 WROOM-1 (4MB Flash) empfiehlt sich **Minimal SPIFFS**:

| Schema | APP | OTA | Empfehlung |
|---|---|---|---|
| Default 4MB with spiffs | 1.2MB | ✅ | ❌ zu eng (89% belegt) |
| **Minimal SPIFFS** | **1.9MB** | ✅ | ✅ **empfohlen** (~57% belegt) |
| No OTA (2MB APP) | 2MB | ❌ | ⚠️ kein OTA möglich |
| Huge APP | 3MB | ❌ | ⚠️ kein OTA möglich |

Die 8M/16M/32M-Schemata erfordern Boards mit entsprechend größerem Flash-Chip — nicht für WROOM-1 (4MB) geeignet.

### Bibliotheken (Arduino Library Manager)

- **WiFiManager** (tablatronix/tzapu) — WLAN Captive Portal
- **ArduinoJson** (bblanchon) — JSON-Serialisierung

Viele weitere Bibliotheken im integrierten Bibliotheks-Manager:
Display, Sensoren, LED, Aktoren, Kommunikation, Energie & Messtechnik.

### Erststart ESP

1. Flash-Tab → Port wählen → `esp-hub-base.bin` → ⚡ Flashen
2. **Serieller Monitor** verbinden (115200 Baud) → Debug-Output sehen
3. ESP startet WLAN-Hotspot **"ESP-Hub-Setup"**
4. Mit Hotspot verbinden → WLAN + Hub-IP eingeben
5. ESP erscheint im Geräte-Tab

> **WLAN zurücksetzen:** BOOT-Taste beim Einschalten 3 Sekunden halten

> **Web-UI am ESP:** Nach dem Flashen erreichbar unter `http://<ESP-IP>/` — Status + OTA-Tab

> **ESP32-S3:** Rechten USB-Port (mit **COM**-Beschriftung) verwenden. RST-Taste kurz drücken bevor du auf Flashen klickst — der S3 muss manuell in den Flash-Modus.

---

## USB-Durchreichung (LXC / Proxmox)

In `/etc/pve/lxc/<ID>.conf` ergänzen:
```
lxc.cgroup2.devices.allow: c 188:* rwm
lxc.mount.entry: /dev/ttyUSB0 dev/ttyUSB0 none bind,optional,create=file
```

udev-Regel auf Proxmox-Host (`/etc/udev/rules.d/99-usb-serial.rules`):
```
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", MODE="0666"
```

```bash
udevadm control --reload-rules && udevadm trigger
pct restart <ID>
```

---

## ioBroker States

```
esp-hub.0
├── info.connection          boolean  Adapter aktiv
├── info.deviceCount         number   Anzahl Geräte
└── devices.<MAC>/
    ├── name                 string   Gerätename (schreibbar)
    ├── ip                   string   IP-Adresse
    ├── mac                  string   MAC-Adresse
    ├── hwType               string   esp32 / esp8266
    ├── version              string   Firmware-Version
    ├── rssi                 number   WLAN-Signal (dBm)
    ├── uptime               number   Uptime (Sekunden)
    ├── freeHeap             number   Freier Heap (Bytes)
    ├── lastSeen             number   Timestamp letzter Heartbeat
    ├── online               boolean  < 120s seit lastSeen
    ├── ios                  string   IO-Werte als JSON
    └── otaUrl               string   OTA-URL (schreibbar)
```

---

## ESP-API

```
POST /api/register    Heartbeat {mac, name, hwType, version, ip, rssi, uptime, freeHeap, ios}
GET  /api/ota/check   OTA-Abfrage ?mac=XXX → {update:bool, url?}
GET  /firmware/*.bin  Firmware-Binary ausliefern
```

---

## Lizenz

GNU General Public License v3.0 © MPunktBPunkt — siehe [LICENSE](LICENSE)

[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)

---

## Changelog

### 0.4.2
- Fix: OTA-URL nutzt echte Server-IP aus ESP-Verbindung (nicht Config)

### 0.4.1
- Bugfix: JS SyntaxError in Geraetekarte

### 0.4.0
- Neu: Chip-Typ (ESP32-S3/ESP32/ESP8266) im Dashboard-Badge
- Neu: Freier Flash-Speicher als Fortschrittsbalken in Geraetekarte
- Neu: Aufklappbares Pinout-Panel pro Geraet
- Fix: Delete-Button immer sichtbar
- Firmware v1.4.0: chipModel + freeSketch im Heartbeat

### Firmware v1.5.0
- Neu: Web-UI direkt am ESP (Port 80) mit Status + OTA-Tab
- Status: Chip, IP, RSSI, Uptime, RAM/Flash-Balken
- OTA: .bin Drag+Drop direkt auf ESP hochladen

### 0.3.6
- Fix: Partition min_spiffs fuer ESP32-S3 und D1 Mini (~57% statt 89% Flash-Auslastung)
- Neu: ESP32-S3 USB-Hinweis im Programmieren-Tab

### 0.3.5
- Neu: ESP32-S3 WROOM-1 (4MB) mit korrekter FQBN im Board-Dropdown
- Neu: CH343-Treiber-Hinweis

### 0.3.4
- Bugfix: JS-Fehler in Event-Handlern behoben

### 0.3.1
- Neu: Bibliotheks-Manager — 6 Kategorien, 20+ Bibliotheken mit Checkboxen (Display, Sensoren, LED, Energie...)
- Neu: Alle/Keine/Standard Auswahlbuttons

### 0.3.0
- Neu: Serieller Monitor im Programmieren-Tab — Live-Debug-Ausgabe vom ESP
- Neu: Bibliotheken-Button (WiFiManager + ArduinoJson)
- Fix: ANSI-Farbcodes aus Compiler-Ausgabe gefiltert

### 0.2.8
- Neu: Standard-Firmware esp-hub-base für Wemos D1 Mini ESP32 direkt mitgeliefert

### 0.2.7
- Neu: Wemos D1 Mini ESP32 als Standard-Board, 921600 Baud als Standard

### 0.2.6
- Bugfix: JS-Syntaxfehler im Kompilieren-Tab

### 0.2.5
- Neu: Kompilieren-Tab mit arduino-cli, .ino Upload, Board-Auswahl

### 0.2.4
- Fix: pip3 ohne Flags (Ubuntu pip22 kompatibel)

### 0.2.0
- Neu: Programmieren-Tab mit USB-Flash, ESP erkennen, esptool Auto-Install

### 0.1.0
- Erstveröffentlichung
