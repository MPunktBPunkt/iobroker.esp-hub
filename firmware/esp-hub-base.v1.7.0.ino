// ╔══════════════════════════════════════════════════════════════╗
// ║  esp-hub-base.ino — ESP-Hub Standard-Firmware für ESP32     ║
// ║  Version: 1.7.0                                             ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  Bibliotheken (Arduino Library Manager):                    ║
// ║    - WiFiManager  von tablatronix / tzapu                   ║
// ║    - ArduinoJson  von bblanchon (v6 oder v7)                ║
// ║  Built-in:                                                  ║
// ║    - HTTPClient, Update, WebServer, Preferences, ESPmDNS    ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  Quickstart:                                                ║
// ║    1. KONFIGURATION anpassen (HUB_HOST!)                    ║
// ║    2. Sketch flashen                                        ║
// ║    3. Hotspot "ESP-Hub-Setup" -> WLAN + Hub-IP eingeben     ║
// ║    4. Geraet erscheint im ESP-Hub Dashboard                 ║
// ║    5. Web-UI: http://<ESP-IP>/                              ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  WLAN zuruecksetzen:                                        ║
// ║    BOOT-Taste 3s beim Einschalten gedrueckt halten          ║
// ║  ESP32-S3: Rechten USB-Port + RST vor dem Flashen           ║
// ╚══════════════════════════════════════════════════════════════╝

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WiFiManager.h>    // https://github.com/tzapu/WiFiManager
#include <ArduinoJson.h>    // https://arduinojson.org/


// ================================================================
//  KONFIGURATION  <-- Diese Werte anpassen
// ================================================================

#define DEVICE_NAME            "Mein ESP32"
#define FW_VERSION             "1.7.0"
#define HUB_HOST               "192.168.178.113"
#define HUB_PORT               8093
#define WIFI_AP_NAME           "ESP-Hub-Setup"
#define WIFI_PORTAL_TIMEOUT_S  180
#define DEFAULT_INTERVAL_S     30
#define WATCHDOG_TIMEOUT_S     300
#define RESET_BUTTON_PIN       0
#define RESET_HOLD_SEC         3


// ================================================================
//  EIGENE HARDWARE  <-- Pins und Sensoren hier definieren
// ================================================================
//
//  #define RELAY1_PIN    12
//  #define DIN1_PIN      14
//  #define USE_TEMPERATURE  1
//  #define TEMP_PIN         4


// ================================================================
//  IO-TABELLE  <-- Messwerte die im Dashboard angezeigt werden
// ================================================================

struct IoValue {
    String key;
    String type;
    float  value;
    String unit;
};

IoValue ioTable[] = {
    // { "temperature", "sensor", 0.0, "C"   },
    // { "humidity",    "sensor", 0.0, "%"   },
    // { "relay1",      "output", 0.0, ""    },
};

const int IO_COUNT = sizeof(ioTable) / sizeof(ioTable[0]);


// ================================================================
//  MESSWERTE EINLESEN  <-- Eigene Sensor-Logik hier implementieren
// ================================================================

void updateIoValues() {
    // Eigene Sensor-Logik hier:
    // for (int i = 0; i < IO_COUNT; i++) {
    //     if (ioTable[i].key == "temperature") ioTable[i].value = readTemp();
    // }
}


// ================================================================
//  AB HIER NICHT VERAENDERN  vvv  INTERNER CODE
// ================================================================

// ── Forward Declarations ─────────────────────────────────────────

String getMac();
String getLocalIp();
String fmtUptime(unsigned long s);
String buildStatusJson();
String buildHeartbeat();
void   sendHeartbeat();
void   performOta(const String& url);
void   checkResetButton();
void   setupWifi();
void   setupWebServer();
void   handleRoot();
void   handleStatus();
void   handleEvents();
void   handleOtaPage();
void   handleOtaUpload();
void   handleOtaUploadFinish();
void   handleNotFound();
void   sseSend(const String& data);

// ── Globale PROGMEM HTML-Strings (muss global sein!) ─────────────

// --- Status-Seite ---
const char PAGE_CSS[] PROGMEM = R"HTML(
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:sans-serif;font-size:14px}
header{background:#161b22;border-bottom:1px solid #30363d;padding:14px 20px;display:flex;align-items:center;gap:12px}
h1{font-size:18px;color:#58a6ff}
.badge{background:rgba(88,166,255,.15);color:#58a6ff;border:1px solid rgba(88,166,255,.3);padding:2px 8px;border-radius:10px;font-size:11px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.dot-on{background:#3fb950;box-shadow:0 0 6px #3fb950}.dot-off{background:#f85149}
.tabs{display:flex;background:#161b22;border-bottom:1px solid #30363d;padding:0 20px}
.tab{padding:10px 20px;border-bottom:2px solid transparent;color:#8b949e;text-decoration:none;font-weight:500}
.tab.active,.tab:hover{color:#58a6ff;border-bottom-color:#58a6ff}
.content{padding:20px;max-width:800px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:14px}
.card h3{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:7px 10px;border-bottom:1px solid #21262d}
td:first-child{color:#8b949e;width:40%}
.bar{height:6px;background:#21262d;border-radius:3px;margin-top:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;transition:width .5s}
.green{background:#3fb950}.yellow{background:#e3b341}.red{background:#f85149}
.mono{font-family:monospace;color:#58a6ff}
.io-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.io-card{background:#1c2128;border:1px solid #30363d;border-radius:6px;padding:10px;text-align:center}
.io-val{font-size:22px;font-weight:700;color:#58a6ff}
.io-key{font-size:11px;color:#8b949e;margin-top:4px}
)HTML";

const char PAGE_BODY[] PROGMEM = R"HTML(
<header>
  <h1>&#128225; <span id="h-name"></span></h1>
  <span class="badge" id="h-ver"></span>
  <span style="margin-left:auto;font-size:12px;color:#8b949e">
    <span class="dot dot-off" id="sse-dot"></span>
    <span id="sse-lbl">Verbinde...</span>
  </span>
</header>
<div class="tabs">
  <a class="tab active" href="/">&#128200; Status</a>
  <a class="tab" href="/ota">&#128640; OTA Update</a>
</div>
<div class="content">
  <div class="card"><h3>Geraet</h3><table>
    <tr><td>Name</td><td id="d-name">-</td></tr>
    <tr><td>Chip</td><td id="d-chip">-</td></tr>
    <tr><td>MAC</td><td class="mono" id="d-mac">-</td></tr>
    <tr><td>IP-Adresse</td><td class="mono" id="d-ip">-</td></tr>
    <tr><td>WLAN RSSI</td><td id="d-rssi">-</td></tr>
    <tr><td>Uptime</td><td id="d-uptime">-</td></tr>
    <tr><td>Firmware</td><td id="d-ver">-</td></tr>
  </table></div>
  <div class="card"><h3>Speicher</h3><table>
    <tr><td>Freier RAM</td><td>
      <span id="d-heap">-</span>
      <div class="bar"><div class="bar-fill" id="b-heap"></div></div>
    </td></tr>
    <tr><td>Freier Flash (OTA)</td><td>
      <span id="d-sketch">-</span>
      <div class="bar"><div class="bar-fill" id="b-sketch"></div></div>
    </td></tr>
  </table></div>
  <div class="card" id="io-card" style="display:none">
    <h3>IO-Werte</h3>
    <div class="io-grid" id="io-grid"></div>
  </div>
  <div class="card"><h3>ESP-Hub</h3><table>
    <tr><td>Hub-Adresse</td><td class="mono" id="d-hub">-</td></tr>
    <tr><td>Heartbeat</td><td id="d-interval">-</td></tr>
  </table></div>
</div>
<script>
function fmtKB(b){return Math.round(b/1024)+' KB';}
function barColor(p){return p>40?'green':p>20?'yellow':'red';}
function applyStatus(s){
  document.getElementById('h-name').textContent=s.name||'';
  document.getElementById('h-ver').textContent='v)HTML";

const char PAGE_SCRIPT[] PROGMEM = R"HTML(';
  document.getElementById('d-name').textContent=s.name||'';
  document.getElementById('d-chip').textContent=s.chip||'';
  document.getElementById('d-mac').textContent=s.mac||'';
  document.getElementById('d-ip').innerHTML='<a href="http://'+s.ip+'" style="color:#58a6ff">'+s.ip+'</a>';
  document.getElementById('d-rssi').textContent=(s.rssi||0)+' dBm';
  document.getElementById('d-uptime').textContent=s.uptime||'';
  document.getElementById('d-ver').textContent='v)HTML";

const char PAGE_SCRIPT2[] PROGMEM = R"HTML(';
  document.getElementById('d-hub').textContent=s.hub||'';
  document.getElementById('d-interval').textContent='alle '+(s.interval||30)+' Sekunden';
  var hp=s.heap||0,hpct=Math.min(100,Math.round(hp/3276));
  document.getElementById('d-heap').textContent=fmtKB(hp);
  var bh=document.getElementById('b-heap');bh.style.width=hpct+'%';bh.className='bar-fill '+barColor(hpct);
  var sk=s.sketch||0,spct=Math.min(100,Math.round(sk/19660));
  document.getElementById('d-sketch').textContent=fmtKB(sk);
  var bs=document.getElementById('b-sketch');bs.style.width=spct+'%';bs.className='bar-fill '+barColor(spct);
  var ios=s.ios||{},keys=Object.keys(ios);
  var card=document.getElementById('io-card'),grid=document.getElementById('io-grid');
  if(keys.length>0){
    card.style.display='';
    grid.innerHTML=keys.map(function(k){
      var io=ios[k];
      return '<div class="io-card"><div class="io-val">'+parseFloat(io.v).toFixed(1)+(io.u?' '+io.u:'')+
             '</div><div class="io-key">'+k+'</div></div>';
    }).join('');
  }
}
var es=new EventSource('/events');
var dot=document.getElementById('sse-dot'),lbl=document.getElementById('sse-lbl');
es.onopen=function(){dot.className='dot dot-on';lbl.textContent='Live';};
es.onerror=function(){dot.className='dot dot-off';lbl.textContent='Getrennt';setTimeout(pollStatus,3000);};
es.onmessage=function(e){try{applyStatus(JSON.parse(e.data));}catch(ex){}};
function pollStatus(){
  fetch('/api/status').then(function(r){return r.json();}).then(applyStatus).catch(function(){});
}
pollStatus();
</script></body></html>)HTML";

// --- OTA-Seite ---
const char OTA_PAGE[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTA Update</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:sans-serif;font-size:14px}
header{background:#161b22;border-bottom:1px solid #30363d;padding:14px 20px;display:flex;align-items:center;gap:12px}
h1{font-size:18px;color:#58a6ff}
.badge{background:rgba(88,166,255,.15);color:#58a6ff;border:1px solid rgba(88,166,255,.3);padding:2px 8px;border-radius:10px;font-size:11px}
.tabs{display:flex;background:#161b22;border-bottom:1px solid #30363d;padding:0 20px}
.tab{padding:10px 20px;border-bottom:2px solid transparent;color:#8b949e;text-decoration:none;font-weight:500}
.tab.active,.tab:hover{color:#58a6ff;border-bottom-color:#58a6ff}
.content{padding:20px;max-width:800px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;margin-bottom:14px}
.drop{border:2px dashed #30363d;border-radius:8px;padding:32px;text-align:center;cursor:pointer;color:#8b949e}
.drop:hover{border-color:#58a6ff;color:#e6edf3}
input[type=file]{display:none}
.btn{background:#238636;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;margin-top:14px;width:100%}
.btn:hover{background:#2ea043}
.prog{display:none;margin-top:14px}
.bar{height:8px;background:#21262d;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;background:#58a6ff;border-radius:4px;width:0%;transition:width .3s}
.msg{margin-top:10px;font-size:13px;color:#8b949e;text-align:center}
.warn{background:rgba(227,179,65,.1);border:1px solid rgba(227,179,65,.3);border-radius:6px;padding:12px;color:#e3b341;font-size:13px;margin-bottom:14px}
</style></head><body>
<header><h1>&#128225; )HTML";

const char OTA_SCRIPT[] PROGMEM = R"HTML(</h1><span class="badge">v)HTML";

const char OTA_SCRIPT2[] PROGMEM = R"HTML(</span></header>
<div class="tabs">
  <a class="tab" href="/">&#128200; Status</a>
  <a class="tab active" href="/ota">&#128640; OTA Update</a>
</div>
<div class="content"><div class="card">
  <h3>&#128640; Firmware hochladen</h3>
  <div class="warn">&#9888; Nach dem Hochladen startet der ESP neu.</div>
  <div class="drop" id="drop" onclick="document.getElementById('fw').click()">
    &#128190; <b>.bin</b> Datei hierher ziehen oder klicken
  </div>
  <input type="file" id="fw" accept=".bin">
  <div id="fname" style="margin-top:8px;font-size:12px;color:#8b949e;text-align:center"></div>
  <button class="btn" onclick="startUpload()">&#9889; Flashen</button>
  <div class="prog" id="prog">
    <div class="bar"><div class="bar-fill" id="bar"></div></div>
    <div class="msg" id="msg">Lade hoch...</div>
  </div>
</div></div>
<script>
var inp=document.getElementById('fw'),drop=document.getElementById('drop');
inp.addEventListener('change',function(){
  if(inp.files[0])document.getElementById('fname').textContent=inp.files[0].name+' ('+Math.round(inp.files[0].size/1024)+' KB)';
});
drop.addEventListener('dragover',function(e){e.preventDefault();drop.style.borderColor='#58a6ff';});
drop.addEventListener('dragleave',function(){drop.style.borderColor='#30363d';});
drop.addEventListener('drop',function(e){
  e.preventDefault();drop.style.borderColor='#30363d';
  var f=e.dataTransfer.files[0];
  if(f&&f.name.endsWith('.bin')){var dt=new DataTransfer();dt.items.add(f);inp.files=dt.files;
    document.getElementById('fname').textContent=f.name+' ('+Math.round(f.size/1024)+' KB)';}
});
function startUpload(){
  if(!inp.files[0]){alert('Bitte zuerst eine .bin Datei auswaehlen!');return;}
  var fd=new FormData();fd.append('firmware',inp.files[0]);
  var xhr=new XMLHttpRequest();xhr.open('POST','/ota-upload');
  document.getElementById('prog').style.display='block';
  xhr.upload.onprogress=function(e){
    if(e.lengthComputable){var pct=Math.round(e.loaded/e.total*100);
      document.getElementById('bar').style.width=pct+'%';
      document.getElementById('msg').textContent='Hochladen: '+pct+'%';}
  };
  xhr.onload=function(){
    if(xhr.status===200){document.getElementById('bar').style.width='100%';
      document.getElementById('bar').style.background='#3fb950';
      document.getElementById('msg').textContent='Erfolgreich! ESP startet neu...';}
    else{document.getElementById('msg').textContent='Fehler: '+xhr.responseText;
      document.getElementById('bar').style.background='#f85149';}
  };
  xhr.onerror=function(){document.getElementById('msg').textContent='Verbindungsfehler.';};
  xhr.send(fd);
}
</script></body></html>)HTML";

// ── Globale Variablen ────────────────────────────────────────────

Preferences   prefs;
WiFiManager   wifiManager;
WebServer     webServer(80);

unsigned long lastHeartbeat     = 0;
unsigned long heartbeatInterval = (unsigned long)DEFAULT_INTERVAL_S * 1000UL;
unsigned long lastSuccess       = 0;
unsigned long lastSseSend       = 0;
bool          otaPending        = false;
String        otaUrl            = "";
String        deviceName        = DEVICE_NAME;
String        hubHost           = HUB_HOST;
int           hubPort           = HUB_PORT;
WiFiClient    sseClient;

// ── Hilfsfunktionen ──────────────────────────────────────────────

String getMac() {
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    mac.toUpperCase();
    return mac;
}

String getLocalIp() { return WiFi.localIP().toString(); }

String fmtUptime(unsigned long s) {
    if (s < 60)   return String(s) + "s";
    if (s < 3600) return String(s/60) + "min " + String(s%60) + "s";
    return String(s/3600) + "h " + String((s%3600)/60) + "min";
}

// ── Status JSON ──────────────────────────────────────────────────

String buildStatusJson() {
    updateIoValues();
    String ios = "{";
    for (int i = 0; i < IO_COUNT; i++) {
        if (i > 0) ios += ",";
        ios += "\"" + ioTable[i].key + "\":{\"v\":" + String(ioTable[i].value,2)
             + ",\"u\":\"" + ioTable[i].unit + "\",\"t\":\"" + ioTable[i].type + "\"}";
    }
    ios += "}";
    String j = "{";
    j += "\"name\":\"" + deviceName + "\"";
    j += ",\"chip\":\"" + String(ESP.getChipModel()) + "\"";
    j += ",\"mac\":\"" + getMac() + "\"";
    j += ",\"ip\":\"" + getLocalIp() + "\"";
    j += ",\"rssi\":" + String(WiFi.RSSI());
    j += ",\"uptime\":\"" + fmtUptime(millis()/1000UL) + "\"";
    j += ",\"heap\":" + String(ESP.getFreeHeap());
    j += ",\"sketch\":" + String(ESP.getFreeSketchSpace());
    j += ",\"hub\":\"" + hubHost + ":" + String(hubPort) + "\"";
    j += ",\"interval\":" + String(heartbeatInterval/1000);
    j += ",\"ios\":" + ios + "}";
    return j;
}

// ── SSE ──────────────────────────────────────────────────────────

void sseSend(const String& data) {
    if (!sseClient || !sseClient.connected()) return;
    sseClient.print("data: ");
    sseClient.print(data);
    sseClient.print("\n\n");
    sseClient.flush();
}

// ── Web-Handler ──────────────────────────────────────────────────

void handleRoot() {
    // Baue die Seite aus globalen PROGMEM-Teilen + dynamischen Werten zusammen
    String page = F("<!DOCTYPE html><html lang=\"de\"><head>"
                    "<meta charset=\"UTF-8\">"
                    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                    "<title>ESP-Hub</title><style>");
    page += FPSTR(PAGE_CSS);
    page += F("</style></head><body>");
    page += FPSTR(PAGE_BODY);
    page += FW_VERSION;           // inject into JS string
    page += FPSTR(PAGE_SCRIPT);
    page += FW_VERSION;           // inject into JS string
    page += FPSTR(PAGE_SCRIPT2);
    webServer.send(200, "text/html", page);
}

void handleStatus() {
    webServer.sendHeader(F("Access-Control-Allow-Origin"), F("*"));
    webServer.send(200, F("application/json"), buildStatusJson());
}

void handleEvents() {
    if (sseClient && sseClient.connected()) sseClient.stop();
    sseClient = webServer.client();
    sseClient.print(F("HTTP/1.1 200 OK\r\n"
                       "Content-Type: text/event-stream\r\n"
                       "Cache-Control: no-cache\r\n"
                       "Connection: keep-alive\r\n"
                       "Access-Control-Allow-Origin: *\r\n"
                       "\r\n"));
    sseClient.flush();
    sseSend(buildStatusJson());
    Serial.println("[SSE] Client: " + sseClient.remoteIP().toString());
}

void handleOtaPage() {
    String page = FPSTR(OTA_PAGE);
    page += deviceName;
    page += FPSTR(OTA_SCRIPT);
    page += FW_VERSION;
    page += FPSTR(OTA_SCRIPT2);
    webServer.send(200, "text/html", page);
}

void handleOtaUpload() {
    HTTPUpload& upload = webServer.upload();
    if (upload.status == UPLOAD_FILE_START) {
        Serial.printf("[WEB-OTA] Start: %s\n", upload.filename.c_str());
        if (!Update.begin(UPDATE_SIZE_UNKNOWN)) Update.printError(Serial);
    } else if (upload.status == UPLOAD_FILE_WRITE) {
        if (Update.write(upload.buf, upload.currentSize) != upload.currentSize)
            Update.printError(Serial);
    } else if (upload.status == UPLOAD_FILE_END) {
        if (Update.end(true))
            Serial.printf("\n[WEB-OTA] OK %u Bytes\n", upload.totalSize);
        else
            Update.printError(Serial);
    }
}

void handleOtaUploadFinish() {
    if (Update.hasError())
        webServer.send(500, F("text/plain"), F("OTA fehlgeschlagen!"));
    else
        webServer.send(200, F("text/plain"), F("OK - Neustart..."));
    delay(500);
    ESP.restart();
}

void handleNotFound() {
    webServer.sendHeader(F("Location"), F("/"), true);
    webServer.send(302, F("text/plain"), F(""));
}

void setupWebServer() {
    webServer.on("/",           HTTP_GET,  handleRoot);
    webServer.on("/events",     HTTP_GET,  handleEvents);
    webServer.on("/api/status", HTTP_GET,  handleStatus);
    webServer.on("/ota",        HTTP_GET,  handleOtaPage);
    webServer.on("/ota-upload", HTTP_POST, handleOtaUploadFinish, handleOtaUpload);
    webServer.onNotFound(handleNotFound);
    webServer.begin();
    Serial.println("[WEB] http://" + getLocalIp() + "/");
}

// ── Reset-Taste ──────────────────────────────────────────────────

void checkResetButton() {
    pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
    if (digitalRead(RESET_BUTTON_PIN) == HIGH) return;
    Serial.println("[RESET] Halte " + String(RESET_HOLD_SEC) + "s...");
    unsigned long t = millis();
    while (digitalRead(RESET_BUTTON_PIN) == LOW) {
        if (millis() - t > (unsigned long)RESET_HOLD_SEC * 1000UL) {
            Serial.println("[RESET] Geloescht! Neustart...");
            wifiManager.resetSettings();
            prefs.begin("esphub", false); prefs.clear(); prefs.end();
            delay(500); ESP.restart();
        }
        delay(100);
    }
}

// ── Heartbeat ────────────────────────────────────────────────────

String buildHeartbeat() {
    updateIoValues();
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
    String out; serializeJson(doc, out); return out;
}

void performOta(const String& url) {
    Serial.println("[OTA] " + url);
    HTTPClient http; http.begin(url); http.setTimeout(30000);
    int code = http.GET();
    if (code != 200) { Serial.printf("[OTA] Fehler: %d\n", code); http.end(); return; }
    int len = http.getSize();
    if (!Update.begin(len > 0 ? len : UPDATE_SIZE_UNKNOWN)) { Update.printError(Serial); http.end(); return; }
    WiFiClient* s = http.getStreamPtr();
    uint8_t buf[512]; size_t w = 0;
    while (http.connected() && (len <= 0 || w < (size_t)len)) {
        size_t a = s->available();
        if (!a) { delay(1); continue; }
        size_t r = s->readBytes(buf, min(a, sizeof(buf)));
        if (!r) break;
        Update.write(buf, r); w += r;
        if (len > 0) Serial.printf("[OTA] %d/%d\r", w, len);
    }
    Serial.println();
    if (Update.end(true)) { Serial.println("[OTA] OK! Neustart..."); http.end(); delay(500); ESP.restart(); }
    else Update.printError(Serial);
    http.end();
}

void sendHeartbeat() {
    if (WiFi.status() != WL_CONNECTED) { Serial.println("[HB] Kein WLAN"); return; }
    String payload = buildHeartbeat();
    String url = "http://" + hubHost + ":" + String(hubPort) + "/api/register";
    Serial.println("[HB] -> " + url);
    HTTPClient http; http.begin(url);
    http.addHeader(F("Content-Type"), F("application/json"));
    http.setTimeout(8000);
    int code = http.POST(payload);
    if (code == 200) {
        String body = http.getString(); lastSuccess = millis();
        #if ARDUINOJSON_VERSION_MAJOR >= 7
          JsonDocument resp;
        #else
          DynamicJsonDocument resp(512);
        #endif
        if (deserializeJson(resp, body) == DeserializationError::Ok) {
            if (resp.containsKey("interval")) {
                unsigned long ni = (unsigned long)(int)resp["interval"] * 1000UL;
                if (ni != heartbeatInterval && ni >= 5000UL) { heartbeatInterval = ni; }
            }
            if (resp.containsKey("otaUrl") && !resp["otaUrl"].isNull()) {
                String u = resp["otaUrl"].as<String>();
                if (u.length() > 0) { otaPending = true; otaUrl = u; Serial.println("[HB] OTA: " + u); }
            }
        }
    } else { Serial.printf("[HB] HTTP %d\n", code); }
    http.end();
}

// ── WiFiManager Setup ────────────────────────────────────────────

void setupWifi() {
    prefs.begin("esphub", false);
    String sName = prefs.getString("name",     deviceName);
    String sHost = prefs.getString("hub_host", hubHost);
    int    sPort = prefs.getInt   ("hub_port", hubPort);
    prefs.end();
    deviceName = sName; hubHost = sHost; hubPort = sPort;

    WiFiManagerParameter pName("name",     "Geraetename", deviceName.c_str(), 32);
    WiFiManagerParameter pHost("hub_host", "ESP-Hub IP",  hubHost.c_str(),    40);
    WiFiManagerParameter pPort("hub_port", "Port",        String(hubPort).c_str(), 6);
    wifiManager.addParameter(&pName);
    wifiManager.addParameter(&pHost);
    wifiManager.addParameter(&pPort);
    wifiManager.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_S);
    wifiManager.setAPCallback([](WiFiManager*){
        Serial.println("[WiFi] Portal: " WIFI_AP_NAME);
    });
    if (!wifiManager.autoConnect(WIFI_AP_NAME)) { delay(1000); ESP.restart(); }

    prefs.begin("esphub", false);
    prefs.putString("name",     String(pName.getValue()));
    prefs.putString("hub_host", String(pHost.getValue()));
    prefs.putInt   ("hub_port", String(pPort.getValue()).toInt());
    prefs.end();
    deviceName = String(pName.getValue());
    hubHost    = String(pHost.getValue());
    hubPort    = String(pPort.getValue()).toInt();
    Serial.println("[WiFi] IP: " + WiFi.localIP().toString() +
                   " Name: " + deviceName + " Hub: " + hubHost + ":" + String(hubPort));
}

// ── Setup & Loop ─────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=== ESP-Hub v" FW_VERSION " ===");
    checkResetButton();
    setupWifi();
    String mdns = "esphub-" + getMac().substring(6);
    if (MDNS.begin(mdns.c_str())) Serial.println("[mDNS] " + mdns + ".local");
    setupWebServer();
    lastSuccess = millis();
    sendHeartbeat();
    lastHeartbeat = millis();
}

void loop() {
    webServer.handleClient();
    unsigned long now = millis();
    if (now - lastSseSend >= 4000UL) {
        lastSseSend = now;
        if (sseClient && sseClient.connected()) sseSend(buildStatusJson());
    }
    if (now - lastHeartbeat >= heartbeatInterval) { lastHeartbeat = now; sendHeartbeat(); }
    if (otaPending) { otaPending = false; performOta(otaUrl); otaUrl = ""; }
    #if WATCHDOG_TIMEOUT_S > 0
    if (now - lastSuccess > (unsigned long)WATCHDOG_TIMEOUT_S * 1000UL) {
        Serial.println("[WDT] Neustart"); delay(500); ESP.restart();
    }
    #endif
    if (WiFi.status() != WL_CONNECTED) { delay(5000); if (WiFi.status() != WL_CONNECTED) WiFi.reconnect(); }
    delay(10);
}

// ================================================================
//  ^^^ ENDE DES INTERNEN CODES
// ================================================================
