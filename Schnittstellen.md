# Schnittstellen.md — iobroker.esp-hub v0.1.0

> API-Dokumentation für ESP-Firmware-Entwickler und ioBroker-Nutzer.

---

## 1. ESP → Adapter

### POST /api/register

Heartbeat und Registrierung. Wird vom ESP zyklisch gesendet (Standard: alle 30 Sekunden).

**Request-Body (JSON):**
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

| Feld | Typ | Pflicht | Beschreibung |
|---|---|---|---|
| `mac` | string | ✓ | MAC-Adresse (mit oder ohne Doppelpunkte) |
| `name` | string | | Gerätename (wird nur beim ersten Heartbeat gesetzt) |
| `hwType` | string | | `esp32` oder `esp8266` |
| `version` | string | | Firmware-Version |
| `ip` | string | | Aktuelle IP-Adresse |
| `rssi` | number | | WLAN-Signalstärke in dBm |
| `uptime` | number | | Laufzeit in Sekunden |
| `freeHeap` | number | | Freier Heap-Speicher in Bytes |
| `ios` | object | | IO-Zustände (beliebige Struktur) |

**Response (JSON):**
```json
{
  "ok":       true,
  "name":     "Sensor-Keller",
  "interval": 30,
  "otaUrl":   null
}
```

| Feld | Typ | Beschreibung |
|---|---|---|
| `ok` | boolean | Erfolg |
| `name` | string | Im Adapter gespeicherter Gerätename |
| `interval` | number | Gewünschtes Heartbeat-Intervall (Sekunden) |
| `otaUrl` | string\|null | OTA-URL wenn Update verfügbar, sonst null |

**Wenn `otaUrl` nicht null:**
Der ESP soll sofort einen HTTP OTA-Update von dieser URL starten.

---

### GET /api/ota/check

Alternativer OTA-Poll (optional, wenn ESP nicht auf Heartbeat-Response reagiert).

**Query-Parameter:** `mac=<MAC>`

**Response:**
```json
{ "update": false }
```
oder:
```json
{ "update": true, "url": "http://192.168.178.1:8093/firmware/firmware-v1.1.0.bin" }
```

---

### GET /firmware/<filename>.bin

Liefert die Firmware-Binary-Datei für OTA-Updates.

- Dateien liegen in `/tmp/iobroker-esphub-fw/`
- Nur `.bin`-Dateien werden ausgeliefert
- Path-Traversal ist durch `path.basename()` verhindert

---

## 2. Browser → Adapter

### GET /api/ping

Health-Check.

**Response:** `{ "ok": true, "ts": 1710000000000 }`

---

### GET /api/stats

Zusammenfassung.

**Response:** `{ "total": 5, "online": 3, "firmwares": 2 }`

---

### GET /api/devices

Alle registrierten Geräte.

**Response:** Array von Device-Objekten:
```json
[
  {
    "mac":      "C8C9A3CB7B08",
    "name":     "Sensor-Keller",
    "ip":       "192.168.178.200",
    "hwType":   "esp32",
    "version":  "1.0.0",
    "rssi":     -62,
    "uptime":   7200,
    "freeHeap": 180000,
    "lastSeen": 1710000000000,
    "online":   true,
    "ios":      "{\"temperature\":{\"type\":\"sensor\",\"value\":21.5}}"
  }
]
```

`online = (Date.now() - lastSeen) < 120000`

---

### GET /api/firmwares

Liste der hochgeladenen Firmware-Dateien.

**Response:**
```json
[
  { "name": "firmware-v1.1.0.bin", "size": 512000, "date": "2026-03-21T10:00:00.000Z" }
]
```

---

### GET /api/logs

Log-Buffer (max. 300 Einträge, neueste zuerst).

**Response:**
```json
[
  { "ts": "2026-03-21T10:00:00.000Z", "level": "INFO", "cat": "DEVICE", "msg": "Neues Gerät: ..." }
]
```

Level: `INFO`, `WARN`, `ERROR`, `DEBUG`
Kategorien: `SYSTEM`, `HTTP`, `DEVICE`, `OTA`

---

### GET /api/version

GitHub-Versionsvergleich.

**Response:** `{ "current": "0.1.0", "latest": "0.1.0", "updateAvailable": false }`

---

### POST /api/firmware-upload

Firmware-Datei hochladen (Multipart Form-Data).

**Content-Type:** `multipart/form-data`
**Field:** `firmware` (Dateiname muss `.bin` enden)

**Response:** `{ "ok": true, "name": "firmware-v1.1.0.bin", "size": 512000 }`

---

### POST /api/firmware-delete

Firmware-Datei löschen.

**Body:** `{ "name": "firmware-v1.1.0.bin" }`

**Response:** `{ "ok": true }`

---

### POST /api/ota-push

OTA-Update für ein Gerät planen. Der ESP empfängt die URL beim nächsten Heartbeat.

**Body:** `{ "mac": "C8C9A3CB7B08", "firmware": "firmware-v1.1.0.bin" }`

**Response:**
```json
{
  "ok":   true,
  "url":  "http://192.168.178.1:8093/firmware/firmware-v1.1.0.bin",
  "info": "Wird beim nächsten Heartbeat übertragen"
}
```

---

### POST /api/device-rename

Gerät umbenennen.

**Body:** `{ "mac": "C8C9A3CB7B08", "name": "Neuer Name" }`

**Response:** `{ "ok": true }`

---

### POST /api/device-delete

Gerät und alle States löschen.

**Body:** `{ "mac": "C8C9A3CB7B08" }`

**Response:** `{ "ok": true }`

---

### POST /api/update

Adapter selbst aktualisieren (iobroker url + restart).

**Response:** `{ "ok": true, "message": "Update gestartet — Adapter wird neu gestartet..." }`

---

## 3. ioBroker States

### Feste States (instanceObjects)

| ID | Typ | Beschreibung |
|---|---|---|
| `esp-hub.0.info.connection` | boolean | Adapter läuft |
| `esp-hub.0.info.deviceCount` | number | Anzahl registrierter Geräte |

### Dynamische States (pro Gerät)

Werden beim ersten Heartbeat via `extendObjectAsync` angelegt.
MAC-Adresse: nur Hex-Zeichen, keine Doppelpunkte, Großbuchstaben.

| State | Typ | Write | Beschreibung |
|---|---|---|---|
| `devices.MAC.name` | string | ✓ | Gerätename |
| `devices.MAC.ip` | string | | IP-Adresse |
| `devices.MAC.mac` | string | | MAC-Adresse (normalisiert) |
| `devices.MAC.hwType` | string | | esp32 / esp8266 |
| `devices.MAC.version` | string | | Firmware-Version |
| `devices.MAC.rssi` | number | | WLAN dBm |
| `devices.MAC.uptime` | number | | Uptime Sekunden |
| `devices.MAC.freeHeap` | number | | Freier Heap Bytes |
| `devices.MAC.lastSeen` | number | | Timestamp ms |
| `devices.MAC.online` | boolean | | Online-Status |
| `devices.MAC.ios` | string | | IO-JSON |
| `devices.MAC.otaUrl` | string | ✓ | OTA-URL (write → triggert Update) |

---

## 4. Netzwerktopologie

```
Heimnetz 192.168.178.0/24

  ioBroker-Host (192.168.178.1)
    └── Port 8093 ← Heartbeat POST + OTA-Binary GET
         ↑
  ESP32 (192.168.178.200)
  ESP32 (192.168.178.201)
  ESP8266 (192.168.178.202)
```

**Wichtig:** Alle ESPs müssen den ioBroker-Host unter der in `adapterHost` konfigurierten IP erreichen können. Diese IP wird in OTA-URLs eingebettet.

---

## 5. Sicherheitshinweise

| Aspekt | Stand v0.1.0 |
|---|---|
| Auth für `/api/register` | Keine (offenes lokales Netz vorausgesetzt) |
| Path-Traversal (Firmware) | Geschützt via `path.basename()` |
| `mac`-Sanitierung | `sanitizeMac()`: nur Hex, keine Sonderzeichen |
| State-Namespace | Alle dynamischen States unter `devices.*` |

**Empfehlung:** Den ESP-Hub Adapter nur im lokalen Netz betreiben. Kein direkter Internetzugang empfohlen.
