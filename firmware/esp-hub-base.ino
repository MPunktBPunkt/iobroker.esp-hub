// ╔══════════════════════════════════════════════════════════════╗
// ║  esp-hub-base.ino — ESP-Hub Standard-Firmware für ESP32     ║
// ║  Version: 1.4.0                                             ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  Bibliotheken (Arduino Library Manager):                    ║
// ║    - WiFiManager  von tablatronix / tzapu                   ║
// ║    - ArduinoJson  von bblanchon (v6 oder v7, beide supported)║
// ║  Built-in (kein separater Download nötig):                  ║
// ║    - HTTPClient, Update, Preferences, ESPmDNS, WiFi         ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  Quickstart:                                                ║
// ║    1. Abschnitt KONFIGURATION anpassen (HUB_HOST!)          ║
// ║    2. Sketch auf ESP32 flashen                              ║
// ║    3. ESP startet als WLAN-Hotspot "ESP-Hub-Setup"          ║
// ║    4. Browser öffnet Captive Portal → WLAN + Hub-IP         ║
// ║    5. Gerät erscheint im ESP-Hub Dashboard                  ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  WLAN zurücksetzen:                                         ║
// ║    BOOT/RESET-Taste beim Einschalten 3 Sek. gedrückt halten ║
// ║    → Hotspot erscheint wieder                               ║
// ╚══════════════════════════════════════════════════════════════╝

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <WiFiManager.h>   // https://github.com/tzapu/WiFiManager
#include <ArduinoJson.h>   // https://arduinojson.org/


// ================================================================
//  KONFIGURATION  <-- Diese Werte anpassen
// ================================================================

// Gerätename — erscheint im ESP-Hub Dashboard
#define DEVICE_NAME            "Mein ESP32"

// Firmware-Version — bei jeder Änderung erhöhen
#define FW_VERSION             "1.4.0"

// IP-Adresse des ioBroker-Hosts (NICHT die FritzBox!)
// Beispiel: "192.168.178.113" wenn ioBroker auf .113 läuft
// Wird im Captive Portal abgefragt und gespeichert
#define HUB_HOST               "192.168.178.113"
#define HUB_PORT               8093

// WLAN-Hotspot-Name beim Erststart (Captive Portal)
#define WIFI_AP_NAME           "ESP-Hub-Setup"
// Sekunden bis das Captive Portal abbricht (0 = kein Timeout)
#define WIFI_PORTAL_TIMEOUT_S  180

// Heartbeat-Intervall in Sekunden (wird vom Hub dynamisch überschrieben)
#define DEFAULT_INTERVAL_S     30
// Sekunden ohne Heartbeat-Erfolg bis Neustart (0 = deaktiviert)
#define WATCHDOG_TIMEOUT_S     300

// Pin der BOOT-Taste zum Zurücksetzen der WLAN-Einstellungen
// Wemos D1 Mini ESP32: GPIO 0 (BOOT-Taste)
#define RESET_BUTTON_PIN       0
// Sekunden gedrückt halten zum Zurücksetzen
#define RESET_HOLD_SEC         3


// ================================================================
//  EIGENE HARDWARE  <-- Pins und Sensoren hier definieren
// ================================================================
//
//  Digitale Ausgänge (Relais, LEDs)
//  #define RELAY1_PIN    12
//  #define RELAY2_PIN    13
//
//  Digitale Eingänge (Taster, Reed-Kontakte)
//  #define DIN1_PIN      14
//  #define DIN2_PIN      15
//
//  DS18B20 Temperatursensor (benötigt OneWire + DallasTemperature)
//  #define USE_TEMPERATURE  1
//  #define TEMP_PIN         4
//
//  DHT22 Temperatur + Feuchtigkeit (benötigt DHT-Bibliothek)
//  #define USE_DHT     1
//  #define DHT_PIN     5
//  #define DHT_TYPE    DHT22


// ================================================================
//  IO-TABELLE  <-- Messwerte die im Dashboard angezeigt werden
// ================================================================
//
//  Format:  { "schluessel", "typ",    startwert, "einheit" }
//  Typen:   "sensor" = Messwert (nur lesen)
//           "input"  = Digitaler Eingang
//           "output" = Ausgang / Relais

struct IoValue {
    String key;
    String type;
    float  value;
    String unit;
};

IoValue ioTable[] = {
    // { "temperature", "sensor", 0.0, "°C"  },
    // { "humidity",    "sensor", 0.0, "%"   },
    // { "relay1",      "output", 0.0, ""    },
};

const int IO_COUNT = sizeof(ioTable) / sizeof(ioTable[0]);


// ================================================================
//  MESSWERTE EINLESEN  <-- Eigene Sensor-Logik hier implementieren
// ================================================================
//
//  Wird vor jedem Heartbeat aufgerufen.
//  Werte aus ioTable[] hier mit echten Messwerten füllen.

void updateIoValues() {
    // Eigene Sensor-Logik hier einfügen:
    //
    // for (int i = 0; i < IO_COUNT; i++) {
    //     if (ioTable[i].key == "temperature") {
    //         ioTable[i].value = sensor.getTempCByIndex(0);
    //     }
    // }
}


// ================================================================
//  AB HIER NICHT VERÄNDERN  ▼▼▼  INTERNER CODE
// ================================================================

Preferences   prefs;
WiFiManager   wifiManager;
unsigned long lastHeartbeat     = 0;
unsigned long heartbeatInterval = (unsigned long)DEFAULT_INTERVAL_S * 1000UL;
unsigned long lastSuccess       = 0;
bool          otaPending        = false;
String        otaUrl            = "";
String        deviceName        = DEVICE_NAME;
String        hubHost           = HUB_HOST;
int           hubPort           = HUB_PORT;

// ── Hilfsfunktionen ─────────────────────────────────────────────

String getMac() {
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    mac.toUpperCase();
    return mac;
}

String getLocalIp() {
    return WiFi.localIP().toString();
}

// ── Reset-Taste prüfen ──────────────────────────────────────────
// BOOT-Taste beim Start gedrückt halten → WLAN-Einstellungen löschen

void checkResetButton() {
    pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
    if (digitalRead(RESET_BUTTON_PIN) == HIGH) return;  // nicht gedrückt

    Serial.println("[RESET] Taste gedrückt — halte " + String(RESET_HOLD_SEC) + "s zum Zurücksetzen...");
    unsigned long start = millis();
    while (digitalRead(RESET_BUTTON_PIN) == LOW) {
        if (millis() - start > (unsigned long)RESET_HOLD_SEC * 1000UL) {
            Serial.println("[RESET] WLAN-Einstellungen werden gelöscht!");
            wifiManager.resetSettings();
            prefs.begin("esphub", false);
            prefs.clear();
            prefs.end();
            Serial.println("[RESET] Neustart...");
            delay(500);
            ESP.restart();
        }
        delay(100);
    }
    Serial.println("[RESET] Zu kurz gedrückt — weiter...");
}

// ── Heartbeat-JSON aufbauen ─────────────────────────────────────

String buildHeartbeat() {
    #if ARDUINOJSON_VERSION_MAJOR >= 7
      JsonDocument doc;
    #else
      DynamicJsonDocument doc(1024);
    #endif

    doc["mac"]        = getMac();
    doc["name"]       = deviceName;
    doc["hwType"]     = "esp32";
    doc["chipModel"]  = ESP.getChipModel();
    doc["version"]    = FW_VERSION;
    doc["ip"]         = getLocalIp();
    doc["rssi"]       = WiFi.RSSI();
    doc["uptime"]     = millis() / 1000UL;
    doc["freeHeap"]   = ESP.getFreeHeap();
    doc["freeSketch"] = ESP.getFreeSketchSpace();

    JsonObject ios = doc["ios"].to<JsonObject>();
    for (int i = 0; i < IO_COUNT; i++) {
        JsonObject io = ios[ioTable[i].key].to<JsonObject>();
        io["type"]  = ioTable[i].type;
        io["value"] = ioTable[i].value;
        if (ioTable[i].unit.length() > 0) io["unit"] = ioTable[i].unit;
    }

    String out;
    serializeJson(doc, out);
    return out;
}

// ── HTTP OTA Update ─────────────────────────────────────────────

void performOta(const String& url) {
    Serial.println("[OTA] Starte Update von: " + url);
    HTTPClient http;
    http.begin(url);
    http.setTimeout(30000);
    int code = http.GET();
    if (code != 200) {
        Serial.printf("[OTA] HTTP-Fehler: %d\n", code);
        http.end();
        return;
    }
    int totalLen = http.getSize();
    if (!Update.begin(totalLen > 0 ? totalLen : UPDATE_SIZE_UNKNOWN)) {
        Update.printError(Serial);
        http.end();
        return;
    }
    WiFiClient* stream = http.getStreamPtr();
    uint8_t buf[512];
    size_t  written = 0;
    while (http.connected() && (totalLen <= 0 || written < (size_t)totalLen)) {
        size_t avail = stream->available();
        if (avail == 0) { delay(1); continue; }
        size_t r = stream->readBytes(buf, min(avail, sizeof(buf)));
        if (r == 0) break;
        Update.write(buf, r);
        written += r;
        if (totalLen > 0)
            Serial.printf("[OTA] %d/%d (%.0f%%)\r", written, totalLen, 100.0f * written / totalLen);
    }
    Serial.println();
    if (Update.end(true)) {
        Serial.println("[OTA] Erfolgreich! Neustart...");
        http.end();
        delay(500);
        ESP.restart();
    } else {
        Update.printError(Serial);
    }
    http.end();
}

// ── Heartbeat senden ────────────────────────────────────────────

void sendHeartbeat() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[HB] Kein WLAN - ueberspringe");
        return;
    }
    updateIoValues();
    String payload = buildHeartbeat();
    String url = "http://" + hubHost + ":" + String(hubPort) + "/api/register";
    Serial.println("[HB] POST -> " + url);

    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);
    int code = http.POST(payload);

    if (code == 200) {
        String body = http.getString();
        Serial.println("[HB] OK: " + body);
        lastSuccess = millis();

        #if ARDUINOJSON_VERSION_MAJOR >= 7
          JsonDocument resp;
        #else
          DynamicJsonDocument resp(512);
        #endif

        if (deserializeJson(resp, body) == DeserializationError::Ok) {
            if (resp.containsKey("interval")) {
                unsigned long newInterval = (unsigned long)(int)resp["interval"] * 1000UL;
                if (newInterval != heartbeatInterval && newInterval >= 5000UL) {
                    Serial.printf("[HB] Intervall -> %lu s\n", newInterval / 1000UL);
                    heartbeatInterval = newInterval;
                }
            }
            if (resp.containsKey("otaUrl") && !resp["otaUrl"].isNull()) {
                String url2 = resp["otaUrl"].as<String>();
                if (url2.length() > 0) {
                    otaPending = true;
                    otaUrl     = url2;
                    Serial.println("[HB] OTA angefordert: " + otaUrl);
                }
            }
        }
    } else {
        Serial.printf("[HB] Fehler HTTP %d\n", code);
    }
    http.end();
}

// ── WiFiManager Setup ───────────────────────────────────────────

void setupWifi() {
    prefs.begin("esphub", false);
    String savedName = prefs.getString("name",     deviceName);
    String savedHost = prefs.getString("hub_host", hubHost);
    int    savedPort = prefs.getInt   ("hub_port", hubPort);
    prefs.end();

    deviceName = savedName;
    hubHost    = savedHost;
    hubPort    = savedPort;

    WiFiManagerParameter paramName("name",     "Geraetename", deviceName.c_str(), 32);
    WiFiManagerParameter paramHost("hub_host", "ESP-Hub IP",  hubHost.c_str(),    40);
    WiFiManagerParameter paramPort("hub_port", "ESP-Hub Port",String(hubPort).c_str(), 6);

    wifiManager.addParameter(&paramName);
    wifiManager.addParameter(&paramHost);
    wifiManager.addParameter(&paramPort);

    wifiManager.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_S);
    wifiManager.setAPCallback([](WiFiManager* mgr) {
        Serial.println("[WiFi] Captive Portal aktiv: " WIFI_AP_NAME);
        Serial.println("[WiFi] AP-IP: " + WiFi.softAPIP().toString());
    });

    if (!wifiManager.autoConnect(WIFI_AP_NAME)) {
        Serial.println("[WiFi] Timeout - Neustart");
        delay(1000);
        ESP.restart();
    }

    prefs.begin("esphub", false);
    prefs.putString("name",     String(paramName.getValue()));
    prefs.putString("hub_host", String(paramHost.getValue()));
    prefs.putInt   ("hub_port", String(paramPort.getValue()).toInt());
    prefs.end();

    deviceName = String(paramName.getValue());
    hubHost    = String(paramHost.getValue());
    hubPort    = String(paramPort.getValue()).toInt();

    Serial.println("[WiFi] Verbunden! IP: " + WiFi.localIP().toString());
    Serial.println("[WiFi] Name: " + deviceName + " | Hub: " + hubHost + ":" + String(hubPort));
}

// ── Setup & Loop ────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=== ESP-Hub Firmware v" FW_VERSION " ===");
    Serial.println("BOOT-Taste 3s gedrückt halten = WLAN zurücksetzen");

    checkResetButton();   // Reset vor WiFi-Setup!
    setupWifi();

    String mdnsName = "esphub-" + getMac().substring(6);
    if (MDNS.begin(mdnsName.c_str())) {
        Serial.println("[mDNS] " + mdnsName + ".local");
    }

    lastSuccess = millis();
    sendHeartbeat();
    lastHeartbeat = millis();
}

void loop() {
    unsigned long now = millis();

    if (now - lastHeartbeat >= heartbeatInterval) {
        lastHeartbeat = now;
        sendHeartbeat();
    }

    if (otaPending) {
        otaPending = false;
        performOta(otaUrl);
        otaUrl = "";
    }

    #if WATCHDOG_TIMEOUT_S > 0
    if (now - lastSuccess > (unsigned long)WATCHDOG_TIMEOUT_S * 1000UL) {
        Serial.println("[WDT] Kein Heartbeat-Erfolg - Neustart");
        delay(500);
        ESP.restart();
    }
    #endif

    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WiFi] Verbindung verloren - warte...");
        delay(5000);
        if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
    }

    delay(100);
}

// ================================================================
//  ▲▲▲  ENDE DES INTERNEN CODES
// ================================================================
