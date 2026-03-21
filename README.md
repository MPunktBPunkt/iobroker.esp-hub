# iobroker.esp-hub

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)

> **ESP32 & ESP8266 Hub** für ioBroker — zentrale Verwaltung aller ESP-Geräte im Heimnetz.

---

## Übersicht

Der **ESP-Hub Adapter** empfängt regelmäßige Heartbeats von ESP32/ESP8266-Geräten, die mit der mitgelieferten Standard-Firmware ausgestattet sind. Er stellt alle Geräteinformationen als ioBroker-Datenpunkte bereit und bietet ein Web-Dashboard zur Verwaltung.

### Funktionen

- 📡 **Automatische Geräteregistrierung** — ESP sendet Heartbeat, Adapter erkennt und speichert Gerät
- 🔢 **Status-Dashboard** — Online/Offline-Status, IP, RSSI, Uptime, freier Heap
- 🔌 **IO-Status** — Anzeige benutzerdefinierter IO-Werte aus dem ESP
- 🔄 **OTA-Updates** — Firmware hochladen und per Klick auf Gerät übertragen
- 🌐 **Web-UI** auf Port 8093 (konfigurierbar)
- 🧩 **ioBroker States** für jedes Gerät (IP, Version, RSSI, uptime, IOs...)

---

## Installation

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.esp-hub
iobroker add esp-hub
iobroker start esp-hub
```

---

## Update

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.esp-hub
iobroker restart esp-hub
```

---

## Konfiguration

| Parameter | Standard | Beschreibung |
|---|---|---|
| Web-UI Port | `8093` | HTTP-Port für Web-Interface + ESP-API |
| Adapter-Host | `192.168.178.1` | IP des ioBroker-Hosts (erreichbar für ESPs — für OTA-URLs) |
| Heartbeat-Intervall | `30` | Gewünschtes Intervall in Sekunden (wird ESPs mitgeteilt) |
| Log-Buffer | `500` | Max. interne Log-Einträge |

### Wichtig: Adapter-Host

Der **Adapter-Host** muss die IP-Adresse sein, unter der der ioBroker-Server von den ESPs erreichbar ist. Diese wird für OTA-Update-URLs verwendet. Beim OTA-Update ruft der ESP die Firmware direkt von dieser Adresse ab.

---

## ESP-Firmware

Im Verzeichnis [`esp32.EspHub/esp-hub-base/`](https://github.com/MPunktBPunkt/esp32.EspHub) liegt die Standard-Firmware für ESP32 (ESP8266 analog). Sie benötigt folgende Arduino-Bibliotheken:

- **WiFiManager** (tablatronix / tzapu) — Captive Portal für WLAN-Konfiguration
- **ArduinoJson** (bblanchon) — JSON-Serialisierung
- **HTTPClient** (built-in ESP32) — HTTP-Kommunikation
- **Update** (built-in ESP32) — OTA-Updates

### Schnellstart ESP-Firmware

1. `config.h` öffnen und `HUB_HOST` + `HUB_PORT` anpassen
2. Sketch auf ESP32 flashen
3. ESP startet ein WLAN `ESP-Hub-Setup` → verbinden → WLAN-Zugangsdaten eingeben
4. ESP verbindet sich und erscheint im Dashboard

---

## Web-Dashboard

Das Web-Interface ist erreichbar unter `http://<ioBroker-IP>:8093`

| Tab | Inhalt |
|---|---|
| 📡 Geräte | Alle registrierten ESPs mit Status, IOs, OTA-Push |
| 📋 Logs | Adapter-Logs mit Filter |
| ⚙️ System | Firmware hochladen, Versionsprüfung |

---

## ioBroker States

Für jedes registrierte ESP-Gerät werden folgende States angelegt:

```
esp-hub.0.devices.<MAC>/
  ├── name        Gerätename (beschreibbar)
  ├── ip          IP-Adresse
  ├── mac         MAC-Adresse
  ├── hwType      esp32 / esp8266
  ├── version     Firmware-Version
  ├── rssi        WLAN-Signalstärke (dBm)
  ├── uptime      Laufzeit in Sekunden
  ├── freeHeap    Freier Heap-Speicher (Bytes)
  ├── lastSeen    Zeitstempel letzter Heartbeat
  ├── online      true = online (Heartbeat < 120s)
  ├── ios         IO-Werte als JSON-String
  └── otaUrl      OTA-URL (beschreibbar → triggert Update beim nächsten Heartbeat)
```

---

## API-Referenz

### ESP → Adapter

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/register` | Heartbeat / Registrierung |
| GET | `/api/ota/check?mac=XXX` | OTA-Status abfragen |
| GET | `/firmware/<name>.bin` | Firmware-Binary herunterladen |

#### Heartbeat-Body (JSON)
```json
{
  "mac":      "C8C9A3CB7B08",
  "name":     "Sensor-Keller",
  "hwType":   "esp32",
  "version":  "1.0.0",
  "ip":       "192.168.178.200",
  "rssi":     -62,
  "uptime":   3600,
  "freeHeap": 180000,
  "ios": {
    "temperature": { "type": "sensor", "value": 21.5, "unit": "°C" },
    "relay1":      { "type": "output", "value": 0 }
  }
}
```

#### Heartbeat-Response
```json
{
  "ok":       true,
  "name":     "Sensor-Keller",
  "interval": 30,
  "otaUrl":   null
}
```

Wenn `otaUrl` nicht null ist, soll der ESP die Firmware von dieser URL laden und einen OTA-Update durchführen.

### Browser → Adapter

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/devices` | Alle Geräte als JSON |
| GET | `/api/stats` | Statistiken |
| GET | `/api/firmwares` | Firmware-Dateiliste |
| GET | `/api/logs` | Log-Buffer |
| GET | `/api/version` | Version + GitHub-Check |
| POST | `/api/firmware-upload` | Firmware hochladen (multipart) |
| POST | `/api/firmware-delete` | Firmware löschen `{name}` |
| POST | `/api/ota-push` | OTA planen `{mac, firmware}` |
| POST | `/api/device-rename` | Gerät umbenennen `{mac, name}` |
| POST | `/api/device-delete` | Gerät löschen `{mac}` |
| POST | `/api/update` | Adapter selbst aktualisieren |

---

## Changelog

### 0.1.0 (2026-03-21)
- Erstveröffentlichung
- ESP-Geräteverwaltung mit Heartbeat-Registrierung
- OTA-Firmware-Update-Verwaltung
- Web-UI: Geräte / Logs / System
- ioBroker States pro Gerät
- Standard ESP32-Firmware (esp32.EspHub)

---

## Lizenz

GPL-3.0 © Martin Buchmann

[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR)
