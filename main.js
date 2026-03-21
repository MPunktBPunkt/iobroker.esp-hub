'use strict';

const utils    = require('@iobroker/adapter-core');
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

const ADAPTER_VERSION = '0.1.0';
const NODE_ONLINE_SEC = 120;
const FIRMWARE_DIR    = '/tmp/iobroker-esphub-fw';

// ─── Helper ────────────────────────────────────────────────────────────────

function sanitizeMac(mac) {
    return (mac || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 12);
}

// ─── Adapter ───────────────────────────────────────────────────────────────

class EspHub extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'esp-hub' });
        this.devices    = {};   // MAC → device object
        this.logs       = [];
        this.httpServer = null;
        this.pack       = {};
        try { this.pack = require('./package.json'); } catch (e) { /* ignore */ }

        this.on('ready',  this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── Logging ─────────────────────────────────────────────────────────

    _log(level, cat, msg) {
        const ts    = new Date().toISOString();
        const entry = { ts, level, cat, msg };
        this.logs.unshift(entry);
        if (this.logs.length > (this.config.logBuffer || 500)) this.logs.pop();
        if (!this.log) return;
        const line = '[' + cat + '] ' + msg;
        if (level === 'ERROR') this.log.error(line);
        else if (level === 'WARN')  this.log.warn(line);
        else if (level === 'DEBUG' && this.config.verbose) this.log.debug(line);
        else if (level === 'INFO')  this.log.info(line);
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    async onReady() {
        try {
            if (!fs.existsSync(FIRMWARE_DIR)) {
                fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
            }
            await this.setStateAsync('info.connection', true, true);
            await this._restoreDevices();
            this._startServer();
            this._log('INFO', 'SYSTEM', 'ESP-Hub v' + (this.pack.version || ADAPTER_VERSION) +
                ' gestartet — Port ' + (this.config.webPort || 8093));
        } catch (e) {
            if (this.log) this.log.error('onReady error: ' + e.message);
        }
    }

    async onUnload(callback) {
        try {
            await Promise.race([
                new Promise(res => { if (this.httpServer) this.httpServer.close(res); else res(); }),
                new Promise(res => setTimeout(res, 2500))
            ]);
            await this.setStateAsync('info.connection', false, true);
        } catch (e) { /* ignore */ }
        callback();
    }

    // ─── Device State Persistence ────────────────────────────────────────

    async _restoreDevices() {
        try {
            const states = await this.getStatesAsync('devices.*');
            for (const id in states) {
                const parts = id.split('.');
                // esp-hub.0.devices.AABBCCDDEEFF.field
                if (parts.length < 5) continue;
                const mac   = parts[3];
                const field = parts.slice(4).join('.');
                if (!this.devices[mac]) this.devices[mac] = { mac };
                if (states[id] && states[id].val !== null && states[id].val !== undefined) {
                    this.devices[mac][field] = states[id].val;
                }
            }
            const count = Object.keys(this.devices).length;
            this._log('INFO', 'SYSTEM', count + ' Gerät(e) aus States wiederhergestellt');
        } catch (e) {
            this._log('WARN', 'SYSTEM', 'Restore fehlgeschlagen: ' + e.message);
        }
    }

    async _ensureDeviceStates(mac) {
        const ch = 'devices.' + mac;
        // Channel
        await this.extendObjectAsync(ch, {
            type: 'channel',
            common: { name: 'ESP Device ' + mac },
            native: {}
        }).catch(() => {});

        const states = [
            { id: 'name',     type: 'string',  role: 'text',             write: true,  def: 'ESP-' + mac.slice(-4), desc: 'Gerätename' },
            { id: 'ip',       type: 'string',  role: 'info.ip',          write: false, def: '',     desc: 'IP-Adresse' },
            { id: 'mac',      type: 'string',  role: 'info.address',     write: false, def: '',     desc: 'MAC-Adresse' },
            { id: 'hwType',   type: 'string',  role: 'text',             write: false, def: 'esp32',desc: 'Hardware-Typ (esp32/esp8266)' },
            { id: 'version',  type: 'string',  role: 'text',             write: false, def: '',     desc: 'Firmware-Version' },
            { id: 'rssi',     type: 'number',  role: 'value',            write: false, def: 0,      desc: 'WLAN-Signal', unit: 'dBm' },
            { id: 'uptime',   type: 'number',  role: 'value',            write: false, def: 0,      desc: 'Uptime', unit: 's' },
            { id: 'freeHeap', type: 'number',  role: 'value',            write: false, def: 0,      desc: 'Freier Heap', unit: 'Bytes' },
            { id: 'lastSeen', type: 'number',  role: 'value.time',       write: false, def: 0,      desc: 'Letzter Heartbeat' },
            { id: 'online',   type: 'boolean', role: 'indicator.connected', write: false, def: false, desc: 'Online' },
            { id: 'ios',      type: 'string',  role: 'json',             write: false, def: '{}',   desc: 'IO-Status als JSON' },
            { id: 'otaUrl',   type: 'string',  role: 'url',              write: true,  def: '',     desc: 'OTA Firmware-URL (für nächsten Heartbeat)' },
        ];

        for (const s of states) {
            await this.extendObjectAsync(ch + '.' + s.id, {
                type: 'state',
                common: {
                    name: s.desc, type: s.type, role: s.role,
                    read: true, write: s.write,
                    def: s.def,
                    unit: s.unit || undefined
                },
                native: {}
            }).catch(() => {});
        }
    }

    // ─── Device Registration / Heartbeat ─────────────────────────────────

    async _handleRegister(body) {
        const mac = sanitizeMac(body.mac || '');
        if (!mac || mac.length < 6) return { ok: false, error: 'Invalid MAC' };

        const now   = Date.now();
        const isNew = !this.devices[mac];

        if (!this.devices[mac]) this.devices[mac] = { mac };
        const d = this.devices[mac];

        d.ip       = body.ip       || d.ip       || '';
        d.name     = d.name        || body.name   || ('ESP-' + mac.slice(-4));
        d.hwType   = body.hwType   || body.type   || d.hwType || 'esp32';
        d.version  = body.version  || d.version   || '0.0.0';
        d.rssi     = (typeof body.rssi    === 'number') ? body.rssi    : (d.rssi    || 0);
        d.uptime   = (typeof body.uptime  === 'number') ? body.uptime  : (d.uptime  || 0);
        d.freeHeap = (typeof body.freeHeap=== 'number') ? body.freeHeap: (d.freeHeap|| 0);
        d.lastSeen = now;
        d.online   = true;

        const rawIos = (body.ios && typeof body.ios === 'object') ? body.ios : {};
        d.ios = JSON.stringify(rawIos);

        // Create states on first seen
        if (isNew) await this._ensureDeviceStates(mac);

        // Write states
        const p = 'devices.' + mac + '.';
        await this.setStateAsync(p + 'ip',       d.ip,       true);
        await this.setStateAsync(p + 'name',     d.name,     true);
        await this.setStateAsync(p + 'mac',      mac,        true);
        await this.setStateAsync(p + 'hwType',   d.hwType,   true);
        await this.setStateAsync(p + 'version',  d.version,  true);
        await this.setStateAsync(p + 'rssi',     d.rssi,     true);
        await this.setStateAsync(p + 'uptime',   d.uptime,   true);
        await this.setStateAsync(p + 'freeHeap', d.freeHeap, true);
        await this.setStateAsync(p + 'lastSeen', now,        true);
        await this.setStateAsync(p + 'online',   true,       true);
        await this.setStateAsync(p + 'ios',      d.ios,      true);

        if (isNew) {
            this._log('INFO', 'DEVICE', 'Neues Gerät: ' + d.name + ' [' + mac + '] ' + d.ip + ' v' + d.version);
        } else {
            this._log('DEBUG', 'DEVICE', 'Heartbeat: ' + d.name + ' [' + mac + '] RSSI:' + d.rssi + ' Up:' + d.uptime + 's');
        }

        // Check pending OTA
        const otaState = await this.getStateAsync(p + 'otaUrl').catch(() => null);
        const otaUrl   = (otaState && otaState.val) ? String(otaState.val) : '';

        const reply = {
            ok:       true,
            name:     d.name,
            interval: this.config.heartbeatInterval || 30
        };

        if (otaUrl) {
            reply.otaUrl = otaUrl;
            await this.setStateAsync(p + 'otaUrl', '', true);
            this._log('INFO', 'OTA', 'OTA-URL an ' + d.name + ' gesendet: ' + otaUrl);
        }

        return reply;
    }

    // ─── Firmware File Management ────────────────────────────────────────

    _listFirmwares() {
        try {
            return fs.readdirSync(FIRMWARE_DIR)
                .filter(f => f.endsWith('.bin'))
                .map(f => {
                    const s = fs.statSync(path.join(FIRMWARE_DIR, f));
                    return { name: f, size: s.size, date: s.mtime.toISOString() };
                })
                .sort((a, b) => b.date.localeCompare(a.date));
        } catch (e) { return []; }
    }

    _parseMultipart(body, boundary) {
        const parts = [];
        const sep   = Buffer.from('--' + boundary);

        const bufIdxOf = (buf, search, start) => {
            for (let i = start || 0; i <= buf.length - search.length; i++) {
                let ok = true;
                for (let j = 0; j < search.length; j++) {
                    if (buf[i + j] !== search[j]) { ok = false; break; }
                }
                if (ok) return i;
            }
            return -1;
        };

        let start = 0;
        while (true) {
            const idx = bufIdxOf(body, sep, start);
            if (idx === -1) break;
            const after = idx + sep.length;
            if (body[after] === 45 && body[after + 1] === 45) break;
            const hStart = after + 2;
            const hEnd   = bufIdxOf(body, Buffer.from('\r\n\r\n'), hStart);
            if (hEnd === -1) break;
            const headers = body.slice(hStart, hEnd).toString();
            const cStart  = hEnd + 4;
            const nextSep = bufIdxOf(body, sep, cStart);
            if (nextSep === -1) break;
            const content  = body.slice(cStart, nextSep - 2);
            const nameM    = headers.match(/name="([^"]+)"/);
            const fileM    = headers.match(/filename="([^"]+)"/);
            parts.push({
                name:     nameM ? nameM[1] : '',
                filename: fileM ? fileM[1] : null,
                data:     content
            });
            start = nextSep;
        }
        return parts;
    }

    // ─── GitHub Version Check ────────────────────────────────────────────

    _checkGitHub(cb) {
        const opts = {
            hostname: 'api.github.com',
            path: '/repos/MPunktBPunkt/iobroker.esp-hub/releases/latest',
            headers: { 'User-Agent': 'iobroker.esp-hub' }
        };
        const req = https.get(opts, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); }
            });
        });
        req.setTimeout(8000, () => req.destroy());
        req.on('error', cb);
    }

    // ─── HTTP Server ─────────────────────────────────────────────────────

    _startServer() {
        const port = this.config.webPort || 8093;
        this.httpServer = http.createServer((req, res) => {
            this._route(req, res).catch(e => {
                this._log('ERROR', 'HTTP', 'Route error: ' + e.message);
                res.writeHead(500);
                res.end('Internal Error');
            });
        });
        this.httpServer.on('error', e => {
            if (e.code === 'EADDRINUSE') {
                this._log('ERROR', 'HTTP', 'Port ' + port + ' belegt! Anderen Port in den Einstellungen wählen.');
            } else {
                this._log('ERROR', 'HTTP', 'Server-Fehler: ' + e.message);
            }
        });
        this.httpServer.listen(port, () => {
            this._log('INFO', 'HTTP', 'Web-UI: http://localhost:' + port);
        });
    }

    async _route(req, res) {
        const rawUrl = req.url || '/';
        const url    = rawUrl.split('?')[0];
        const qs     = {};
        if (rawUrl.includes('?')) {
            rawUrl.split('?')[1].split('&').forEach(p => {
                const [k, v] = p.split('=');
                if (k) qs[decodeURIComponent(k)] = decodeURIComponent(v || '');
            });
        }

        const json = (data, code) => {
            res.writeHead(code || 200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(data));
        };

        const readBody = () => new Promise(resolve => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end',  () => resolve(Buffer.concat(chunks)));
        });

        // ── Web UI ──
        if (url === '/' || url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this._buildUI());
            return;
        }

        // ── Static ping ──
        if (url === '/api/ping') { json({ ok: true, ts: Date.now() }); return; }

        // ── Stats ──
        if (url === '/api/stats') {
            const total  = Object.keys(this.devices).length;
            const online = Object.values(this.devices).filter(
                d => (Date.now() - (d.lastSeen || 0)) < NODE_ONLINE_SEC * 1000
            ).length;
            json({ total, online, firmwares: this._listFirmwares().length });
            return;
        }

        // ── Device list ──
        if (url === '/api/devices') {
            const list = Object.values(this.devices).map(d => ({
                ...d,
                online: (Date.now() - (d.lastSeen || 0)) < NODE_ONLINE_SEC * 1000
            }));
            json(list);
            return;
        }

        // ── Logs ──
        if (url === '/api/logs') {
            json(this.logs.slice(0, 300));
            return;
        }

        // ── Firmware list ──
        if (url === '/api/firmwares') {
            json(this._listFirmwares());
            return;
        }

        // ── Version check ──
        if (url === '/api/version') {
            const current = this.pack.version || ADAPTER_VERSION;
            this._checkGitHub((err, data) => {
                const latest = (!err && data && data.tag_name) ? data.tag_name.replace(/^v/, '') : null;
                json({ current, latest, updateAvailable: latest ? latest !== current : false });
            });
            return;
        }

        // ── ESP Registration/Heartbeat ──
        if (url === '/api/register' && req.method === 'POST') {
            const body = await readBody();
            let data = {};
            try { data = JSON.parse(body.toString()); } catch (e) { /* ignore */ }
            json(await this._handleRegister(data));
            return;
        }

        // ── OTA check (polled by ESP) ──
        if (url === '/api/ota/check') {
            const mac = sanitizeMac(qs.mac || '');
            if (!mac) { json({ update: false }); return; }
            const state = await this.getStateAsync('devices.' + mac + '.otaUrl').catch(() => null);
            if (state && state.val) {
                json({ update: true, url: state.val });
            } else {
                json({ update: false });
            }
            return;
        }

        // ── Serve firmware binary ──
        if (url.startsWith('/firmware/')) {
            const fname = path.basename(url.slice(10));
            const fpath = path.join(FIRMWARE_DIR, fname);
            if (!fname || !fs.existsSync(fpath)) { res.writeHead(404); res.end('Not found'); return; }
            const data = fs.readFileSync(fpath);
            this._log('INFO', 'OTA', 'Firmware ausgeliefert: ' + fname + ' (' + data.length + ' Bytes)');
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(data.length),
                'Content-Disposition': 'attachment; filename="' + fname + '"'
            });
            res.end(data);
            return;
        }

        // ── Firmware upload ──
        if (url === '/api/firmware-upload' && req.method === 'POST') {
            const ct    = req.headers['content-type'] || '';
            const bm    = ct.match(/boundary=(.+)/);
            if (!bm) { json({ ok: false, error: 'Missing boundary' }); return; }
            const body  = await readBody();
            const parts = this._parseMultipart(body, bm[1].trim());
            const file  = parts.find(p => p.filename && p.filename.endsWith('.bin'));
            if (!file) { json({ ok: false, error: 'Keine .bin Datei gefunden' }); return; }
            const fname = path.basename(file.filename);
            fs.writeFileSync(path.join(FIRMWARE_DIR, fname), file.data);
            this._log('INFO', 'OTA', 'Firmware hochgeladen: ' + fname + ' (' + file.data.length + ' B)');
            json({ ok: true, name: fname, size: file.data.length });
            return;
        }

        // ── Firmware delete ──
        if (url === '/api/firmware-delete' && req.method === 'POST') {
            const body  = await readBody();
            let data = {};
            try { data = JSON.parse(body.toString()); } catch (e) { /* ignore */ }
            const fname = path.basename(data.name || '');
            const fpath = path.join(FIRMWARE_DIR, fname);
            if (fname && fs.existsSync(fpath)) {
                fs.unlinkSync(fpath);
                this._log('INFO', 'OTA', 'Firmware gelöscht: ' + fname);
                json({ ok: true });
            } else {
                json({ ok: false, error: 'Datei nicht gefunden' });
            }
            return;
        }

        // ── OTA Push (Adapter → ESP via next heartbeat) ──
        if (url === '/api/ota-push' && req.method === 'POST') {
            const body = await readBody();
            let data = {};
            try { data = JSON.parse(body.toString()); } catch (e) { /* ignore */ }
            const mac      = sanitizeMac(data.mac || '');
            const firmware = path.basename(data.firmware || '');
            if (!mac || !firmware) { json({ ok: false, error: 'mac + firmware erforderlich' }); return; }
            const host   = this.config.adapterHost || '127.0.0.1';
            const port   = this.config.webPort || 8093;
            const otaUrl = 'http://' + host + ':' + port + '/firmware/' + encodeURIComponent(firmware);
            await this.setStateAsync('devices.' + mac + '.otaUrl', otaUrl, true).catch(() => {});
            if (this.devices[mac]) this.devices[mac].otaUrl = otaUrl;
            this._log('INFO', 'OTA', 'OTA geplant → ' + mac + ': ' + firmware);
            json({ ok: true, url: otaUrl, info: 'Wird beim nächsten Heartbeat übertragen' });
            return;
        }

        // ── Rename device ──
        if (url === '/api/device-rename' && req.method === 'POST') {
            const body = await readBody();
            let data = {};
            try { data = JSON.parse(body.toString()); } catch (e) { /* ignore */ }
            const mac  = sanitizeMac(data.mac || '');
            const name = (data.name || '').trim();
            if (!mac || !name) { json({ ok: false, error: 'mac + name erforderlich' }); return; }
            if (this.devices[mac]) {
                this.devices[mac].name = name;
                await this.setStateAsync('devices.' + mac + '.name', name, true).catch(() => {});
                this._log('INFO', 'DEVICE', 'Umbenannt: ' + mac + ' → ' + name);
                json({ ok: true });
            } else {
                json({ ok: false, error: 'Gerät nicht gefunden' });
            }
            return;
        }

        // ── Delete device ──
        if (url === '/api/device-delete' && req.method === 'POST') {
            const body = await readBody();
            let data = {};
            try { data = JSON.parse(body.toString()); } catch (e) { /* ignore */ }
            const mac = sanitizeMac(data.mac || '');
            if (!mac) { json({ ok: false, error: 'mac erforderlich' }); return; }
            delete this.devices[mac];
            await this.delObjectAsync('devices.' + mac, { recursive: true }).catch(() => {});
            this._log('INFO', 'DEVICE', 'Gerät gelöscht: ' + mac);
            json({ ok: true });
            return;
        }

        // ── Self-update ──
        if (url === '/api/update' && req.method === 'POST') {
            this._log('INFO', 'SYSTEM', 'Self-Update wird gestartet...');
            exec('iobroker url https://github.com/MPunktBPunkt/iobroker.esp-hub && iobroker restart esp-hub.0',
                err => { if (err) this._log('ERROR', 'SYSTEM', 'Update-Fehler: ' + err.message); });
            json({ ok: true, message: 'Update gestartet — Adapter wird neu gestartet...' });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found: ' + url);
    }

    // ─── Web UI Builder ──────────────────────────────────────────────────

    _buildUI() {
        const ver = this.pack.version || ADAPTER_VERSION;
        const port = this.config.webPort || 8093;

        const CSS = [
            ':root{',
            '  --bg0:#0d1117;--bg1:#161b22;--bg2:#1c2128;--bg3:#262c36;',
            '  --border:#30363d;--border2:#3d444d;',
            '  --accent:#58a6ff;--green:#3fb950;--yellow:#e3b341;',
            '  --red:#f85149;--purple:#a371f7;--orange:#f0883e;',
            '  --text:#e6edf3;--muted:#8b949e;--dim:#656d76;',
            '  --mono:"JetBrains Mono","Fira Code","Consolas",monospace;',
            '}',
            '*{box-sizing:border-box;margin:0;padding:0}',
            'body{background:var(--bg0);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}',
            'a{color:var(--accent);text-decoration:none}',
            'header{background:var(--bg1);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;gap:12px}',
            'header h1{font-size:18px;color:var(--accent);font-weight:700}',
            '.hdr-stats{margin-left:auto;display:flex;gap:16px;align-items:center;font-size:12px;color:var(--muted)}',
            '.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}',
            '.badge-blue{background:rgba(88,166,255,.15);color:var(--accent);border:1px solid rgba(88,166,255,.3)}',
            '.badge-green{background:rgba(63,185,80,.15);color:var(--green);border:1px solid rgba(63,185,80,.3)}',
            '.badge-red{background:rgba(248,81,73,.15);color:var(--red);border:1px solid rgba(248,81,73,.3)}',
            '.badge-yellow{background:rgba(227,179,65,.15);color:var(--yellow);border:1px solid rgba(227,179,65,.3)}',
            '.badge-purple{background:rgba(163,113,247,.15);color:var(--purple);border:1px solid rgba(163,113,247,.3)}',
            '.tabs{display:flex;background:var(--bg1);border-bottom:1px solid var(--border);padding:0 20px}',
            '.tab{padding:12px 20px;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted);transition:all .2s;font-weight:500;user-select:none}',
            '.tab:hover{color:var(--text)}',
            '.tab.active{color:var(--accent);border-bottom-color:var(--accent)}',
            '.panel{display:none;padding:20px;max-width:1400px}',
            '.panel.active{display:block}',
            '.card{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}',
            '.card h3{font-size:12px;color:var(--muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}',
            '.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}',
            '.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}',
            '.stat-val{font-size:30px;font-weight:700}',
            '.stat-lbl{font-size:12px;color:var(--muted);margin-top:4px}',
            '.device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}',
            '.dc{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px}',
            '.dc.is-online{border-left:3px solid var(--green)}',
            '.dc.is-offline{border-left:3px solid var(--red)}',
            '.dc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}',
            '.dc-name{font-weight:600;font-size:15px}',
            '.dc-meta{font-size:12px;color:var(--muted);font-family:var(--mono);line-height:1.6;margin-bottom:8px}',
            '.dc-ios{border-top:1px solid var(--border);margin-top:8px;padding-top:8px}',
            '.io-row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0}',
            '.io-k{color:var(--muted)}',
            '.io-v{font-family:var(--mono);color:var(--accent)}',
            '.dc-actions{display:flex;gap:6px;align-items:center;margin-top:10px;border-top:1px solid var(--border);padding-top:10px}',
            '.dc-actions select{flex:1}',
            '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;flex-shrink:0}',
            '.dot-on{background:var(--green);box-shadow:0 0 6px var(--green)}',
            '.dot-off{background:var(--red)}',
            '.btn{padding:6px 14px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .2s}',
            '.btn:hover{opacity:.8}',
            '.btn:disabled{opacity:.4;cursor:default}',
            '.btn-blue{background:var(--accent);color:#000}',
            '.btn-green{background:var(--green);color:#000}',
            '.btn-red{background:var(--red);color:#fff}',
            '.btn-sm{padding:4px 10px;font-size:12px}',
            '.log-container{max-height:520px;overflow-y:auto;font-family:var(--mono);font-size:12px}',
            '.log-line{padding:3px 0;border-bottom:1px solid var(--border2)}',
            '.log-INFO{color:var(--text)}',
            '.log-DEBUG{color:var(--dim)}',
            '.log-WARN{color:var(--yellow)}',
            '.log-ERROR{color:var(--red)}',
            '.fw-list{display:flex;flex-direction:column;gap:8px}',
            '.fw-item{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;display:flex;align-items:center;gap:10px}',
            '.fw-name{flex:1;font-family:var(--mono);font-size:13px}',
            '.fw-size{color:var(--muted);font-size:12px}',
            'input,select{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px}',
            'input:focus,select:focus{outline:none;border-color:var(--accent)}',
            '.upload-area{border:2px dashed var(--border);border-radius:8px;padding:32px;text-align:center;cursor:pointer;color:var(--muted);transition:all .2s}',
            '.upload-area:hover{border-color:var(--accent);color:var(--text)}',
            '.upload-area.drag{border-color:var(--accent);background:rgba(88,166,255,.05)}',
            '.info-table{width:100%;border-collapse:collapse;font-size:13px}',
            '.info-table td{padding:6px 10px;border-bottom:1px solid var(--border2)}',
            '.info-table td:first-child{color:var(--muted);width:40%}',
            '.empty{text-align:center;padding:48px;color:var(--dim)}',
            '#rename-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}',
            '#rename-modal.show{display:flex}',
            '.modal-box{background:var(--bg1);border:1px solid var(--border);border-radius:10px;padding:24px;width:320px}',
            '.modal-box h3{margin-bottom:14px;font-size:16px}',
            '.modal-box input{width:100%;margin-bottom:12px}',
            '.modal-btns{display:flex;gap:8px;justify-content:flex-end}',
        ].join('\n');

        const BODY = [
            '<header>',
            '  <span style="font-size:26px">&#128225;</span>',
            '  <h1>ESP-Hub</h1>',
            '  <span class="badge badge-blue" id="hdr-ver">v' + ver + '</span>',
            '  <div class="hdr-stats">',
            '    <span id="hdr-online">&#9679; Verbinde...</span>',
            '    <span id="hdr-upd" style="display:none"></span>',
            '  </div>',
            '</header>',
            '<div class="tabs">',
            '  <div class="tab active" data-tab="devices">&#128267; Ger&auml;te</div>',
            '  <div class="tab" data-tab="logs">&#128203; Logs</div>',
            '  <div class="tab" data-tab="system">&#9881;&#65039; System</div>',
            '</div>',

            // ── Devices Panel ──
            '<div class="panel active" id="panel-devices">',
            '  <div class="stats-grid">',
            '    <div class="stat-card">',
            '      <div class="stat-val" id="st-total" style="color:var(--accent)">-</div>',
            '      <div class="stat-lbl">Ger&auml;te gesamt</div>',
            '    </div>',
            '    <div class="stat-card">',
            '      <div class="stat-val" id="st-online" style="color:var(--green)">-</div>',
            '      <div class="stat-lbl">Online</div>',
            '    </div>',
            '    <div class="stat-card">',
            '      <div class="stat-val" id="st-offline" style="color:var(--red)">-</div>',
            '      <div class="stat-lbl">Offline</div>',
            '    </div>',
            '  </div>',
            '  <div id="device-grid" class="device-grid"></div>',
            '</div>',

            // ── Logs Panel ──
            '<div class="panel" id="panel-logs">',
            '  <div class="card">',
            '    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">',
            '      <h3 style="margin:0">System-Logs</h3>',
            '      <select id="lf-level" style="margin-left:auto">',
            '        <option value="">Alle Level</option>',
            '        <option>INFO</option><option>WARN</option><option>ERROR</option><option>DEBUG</option>',
            '      </select>',
            '      <input id="lf-cat" placeholder="Kategorie..." style="width:130px">',
            '      <input id="lf-txt" placeholder="Suche..." style="width:130px">',
            '      <button class="btn btn-sm btn-blue" id="log-export-btn">Export</button>',
            '    </div>',
            '    <div class="log-container" id="log-container"></div>',
            '  </div>',
            '</div>',

            // ── System Panel ──
            '<div class="panel" id="panel-system">',
            '  <div class="card">',
            '    <h3>Firmware hochladen</h3>',
            '    <div class="upload-area" id="upload-area">',
            '      &#128190; <b>.bin</b> Datei hierher ziehen oder klicken',
            '    </div>',
            '    <input type="file" id="fw-input" accept=".bin" style="display:none">',
            '    <div id="fw-list" class="fw-list" style="margin-top:12px"></div>',
            '  </div>',
            '  <div class="card">',
            '    <h3>Adapter-Info</h3>',
            '    <table class="info-table">',
            '      <tr><td>Version</td><td><b>' + ver + '</b></td></tr>',
            '      <tr><td>Port</td><td><b>' + port + '</b></td></tr>',
            '      <tr><td>Firmware-Verzeichnis</td><td style="font-family:var(--mono);font-size:12px">' + FIRMWARE_DIR + '</td></tr>',
            '      <tr><td>GitHub</td><td><a href="https://github.com/MPunktBPunkt/iobroker.esp-hub" target="_blank">MPunktBPunkt/iobroker.esp-hub</a></td></tr>',
            '    </table>',
            '    <div style="margin-top:12px;display:flex;gap:10px;align-items:center">',
            '      <button class="btn btn-blue" id="upd-btn">&#128260; Adapter aktualisieren</button>',
            '      <span id="upd-msg" style="color:var(--muted);font-size:12px"></span>',
            '    </div>',
            '  </div>',
            '  <div class="card">',
            '    <h3>Unterst&uuml;tze dieses Projekt</h3>',
            '    <a href="https://www.paypal.com/donate/?business=martin%40bchmnn.de&currency_code=EUR" target="_blank">',
            '      <img src="https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal" alt="Donate via PayPal">',
            '    </a>',
            '  </div>',
            '</div>',

            // ── Rename Modal ──
            '<div id="rename-modal">',
            '  <div class="modal-box">',
            '    <h3>Ger&auml;t umbenennen</h3>',
            '    <input type="text" id="rename-inp" placeholder="Neuer Name">',
            '    <div class="modal-btns">',
            '      <button class="btn" onclick="closeRename()">Abbrechen</button>',
            '      <button class="btn btn-blue" onclick="confirmRename()">Speichern</button>',
            '    </div>',
            '  </div>',
            '</div>',
        ].join('\n');

        const JS = [
            'var devices=[], firmwares=[], logs=[], _renameMac="";',
            '',
            '// ── Tabs ──────────────────────────────────────────',
            'document.querySelectorAll(".tab").forEach(function(t){',
            '  t.addEventListener("click",function(){',
            '    document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active");});',
            '    document.querySelectorAll(".panel").forEach(function(x){x.classList.remove("active");});',
            '    t.classList.add("active");',
            '    var p=document.getElementById("panel-"+t.dataset.tab);',
            '    if(p)p.classList.add("active");',
            '  });',
            '});',
            '',
            '// ── Helpers ───────────────────────────────────────',
            'function fmtSize(b){',
            '  if(b<1024)return b+" B";',
            '  if(b<1048576)return (b/1024).toFixed(1)+" KB";',
            '  return (b/1048576).toFixed(1)+" MB";',
            '}',
            'function fmtAge(ts){',
            '  if(!ts)return "nie";',
            '  var s=Math.floor((Date.now()-ts)/1000);',
            '  if(s<5)return "gerade";',
            '  if(s<60)return "vor "+s+"s";',
            '  if(s<3600)return "vor "+Math.floor(s/60)+"min";',
            '  return "vor "+Math.floor(s/3600)+"h";',
            '}',
            'function esc(s){',
            '  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
            '}',
            '',
            '// ── Render Devices ────────────────────────────────',
            'function renderDevices(){',
            '  var grid=document.getElementById("device-grid");',
            '  var total=devices.length;',
            '  var online=devices.filter(function(d){return d.online;}).length;',
            '  var el=document.getElementById("st-total"); if(el)el.textContent=total;',
            '  var eo=document.getElementById("st-online"); if(eo)eo.textContent=online;',
            '  var ef=document.getElementById("st-offline"); if(ef)ef.textContent=total-online;',
            '  if(!grid)return;',
            '  if(!total){grid.innerHTML=\'<div class="empty">&#128267; Noch keine ESP-Ger\\u00e4te registriert.<br><small>Starte die ESP-Firmware und konfiguriere den Adapter-Host.</small></div>\';return;}',
            '  var fwOpts=\'<option value="">-- Firmware w\\u00e4hlen --</option>\';',
            '  firmwares.forEach(function(f){fwOpts+=\'<option value="\'+esc(f.name)+\'">\'+esc(f.name)+\' (\'+fmtSize(f.size)+\')</option>\';});',
            '  var h="";',
            '  devices.forEach(function(d){',
            '    var cls=d.online?"is-online":"is-offline";',
            '    var dot=d.online?\'<span class="dot dot-on"></span>\':\'<span class="dot dot-off"></span>\';',
            '    var ios={};try{ios=JSON.parse(d.ios||"{}");}catch(e){}',
            '    var ioH="";',
            '    Object.keys(ios).forEach(function(k){',
            '      var v=ios[k];',
            '      var val=(typeof v==="object")?(v.value!==undefined?v.value:JSON.stringify(v)):v;',
            '      ioH+=\'<div class="io-row"><span class="io-k">\'+esc(k)+\'</span><span class="io-v">\'+esc(val)+\'</span></div>\';',
            '    });',
            '    h+=\'<div class="dc \'+cls+\'">\';',
            '    h+=\'<div class="dc-head"><span class="dc-name">\'+dot+esc(d.name)+\'</span>\';',
            '    h+=\'<span class="badge badge-\'+((d.hwType||"esp32").indexOf("8266")>=0?"yellow":"blue")+\'">\'+esc(d.hwType||"esp32")+\'</span></div>\';',
            '    h+=\'<div class="dc-meta">MAC: \'+esc(d.mac)+\' &nbsp;|\';',
            '    h+=\' IP: <a href="http://\'+esc(d.ip)+\'" target="_blank">\'+esc(d.ip||"?")+\'</a>&nbsp;|\';',
            '    h+=\' v\'+esc(d.version||"?")+\'<br>\';',
            '    h+=\'RSSI: \'+esc(d.rssi||0)+\' dBm &nbsp;| Uptime: \'+esc(d.uptime||0)+\'s\';',
            '    h+=\' &nbsp;| Heap: \'+fmtSize(d.freeHeap||0)+\' &nbsp;| \'+fmtAge(d.lastSeen)+\'</div>\';',
            '    if(ioH)h+=\'<div class="dc-ios">\'+ioH+\'</div>\';',
            '    h+=\'<div class="dc-actions">\';',
            '    h+=\'<select class="fw-sel" data-mac="\'+esc(d.mac)+\'">\'+fwOpts+\'</select>\';',
            '    h+=\'<button class="btn btn-sm btn-green" data-mac="\'+esc(d.mac)+\'" onclick="otaPush(this.dataset.mac)">OTA</button>\';',
            '    h+=\'<button class="btn btn-sm" data-mac="\'+esc(d.mac)+\'" data-name="\'+esc(d.name)+\'" onclick="openRename(this.dataset.mac,this.dataset.name)" style="background:var(--bg3)">&#9998;</button>\';',
            '    h+=\'<button class="btn btn-sm btn-red" data-mac="\'+esc(d.mac)+\'" onclick="delDevice(this.dataset.mac)">&#128465;</button>\';',
            '    h+=\'</div></div>\';',
            '  });',
            '  grid.innerHTML=h;',
            '}',
            '',
            '// ── Render Firmware List ──────────────────────────',
            'function renderFirmwares(){',
            '  var el=document.getElementById("fw-list");',
            '  if(!el)return;',
            '  if(!firmwares.length){el.innerHTML=\'<div style="color:var(--muted);text-align:center;padding:12px">Keine Firmware hochgeladen</div>\';return;}',
            '  var h="";',
            '  firmwares.forEach(function(f){',
            '    h+=\'<div class="fw-item">\';',
            '    h+=\'<span class="fw-name">&#128190; \'+esc(f.name)+\'</span>\';',
            '    h+=\'<span class="fw-size">\'+fmtSize(f.size)+\'</span>\';',
            '    h+=\'<a href="/firmware/\'+encodeURIComponent(f.name)+\'" class="btn btn-sm" style="background:var(--bg3)">&#11015;</a>\';',
            '    h+=\'<button class="btn btn-sm btn-red" data-name="\'+esc(f.name)+\'" onclick="delFirmware(this.dataset.name)">&#128465;</button>\';',
            '    h+=\'</div>\';',
            '  });',
            '  el.innerHTML=h;',
            '}',
            '',
            '// ── Render Logs ───────────────────────────────────',
            'function renderLogs(){',
            '  var el=document.getElementById("log-container");',
            '  if(!el)return;',
            '  var lv=document.getElementById("lf-level")?document.getElementById("lf-level").value:"";',
            '  var cat=document.getElementById("lf-cat")?document.getElementById("lf-cat").value.toUpperCase():"";',
            '  var txt=document.getElementById("lf-txt")?document.getElementById("lf-txt").value.toLowerCase():"";',
            '  var f=logs.filter(function(l){',
            '    if(lv&&l.level!==lv)return false;',
            '    if(cat&&l.cat.indexOf(cat)<0)return false;',
            '    if(txt&&l.msg.toLowerCase().indexOf(txt)<0)return false;',
            '    return true;',
            '  });',
            '  var h="";',
            '  f.slice(0,300).forEach(function(l){',
            '    var t=l.ts?l.ts.slice(11,19):"";',
            '    h+=\'<div class="log-line log-\'+l.level+\'">[\'+ t +\'] [\'+l.level+\'] [\'+l.cat+\'] \'+esc(l.msg)+\'</div>\';',
            '  });',
            '  el.innerHTML=h||\'<div style="color:var(--dim);text-align:center;padding:20px">Keine Logs</div>\';',
            '}',
            '',
            '// ── Fetch All Data ────────────────────────────────',
            'function fetchAll(){',
            '  fetch("/api/stats").then(function(r){return r.json();}).then(function(s){',
            '    var h=document.getElementById("hdr-online");',
            '    if(h)h.innerHTML=\'<span style="color:var(--green)">&#9679;</span> \'+s.online+\'/\'+s.total+\' online | FW: \'+s.firmwares;',
            '  }).catch(function(){});',
            '  fetch("/api/devices").then(function(r){return r.json();}).then(function(d){',
            '    devices=d;renderDevices();',
            '  }).catch(function(){});',
            '  fetch("/api/firmwares").then(function(r){return r.json();}).then(function(f){',
            '    firmwares=f;renderFirmwares();',
            '  }).catch(function(){});',
            '  fetch("/api/logs").then(function(r){return r.json();}).then(function(l){',
            '    logs=l;renderLogs();',
            '  }).catch(function(){});',
            '}',
            '',
            '// ── OTA Push ──────────────────────────────────────',
            'function otaPush(mac){',
            '  var sel=document.querySelector(\'.fw-sel[data-mac="\'+mac+\'"]\');',
            '  var fw=sel?sel.value:"";',
            '  if(!fw){alert("Bitte eine Firmware-Datei ausw\\u00e4hlen!");return;}',
            '  fetch("/api/ota-push",{method:"POST",headers:{"Content-Type":"application/json"},',
            '    body:JSON.stringify({mac:mac,firmware:fw})})',
            '  .then(function(r){return r.json();})',
            '  .then(function(res){',
            '    if(res.ok)alert("\\u2705 OTA f\\u00fcr "+mac+" geplant!\\n"+res.info);',
            '    else alert("\\u274C Fehler: "+res.error);',
            '  }).catch(function(e){alert("Fehler: "+e);});',
            '}',
            '',
            '// ── Delete Device ─────────────────────────────────',
            'function delDevice(mac){',
            '  if(!confirm("Ger\\u00e4t "+mac+" wirklich l\\u00f6schen?"))return;',
            '  fetch("/api/device-delete",{method:"POST",headers:{"Content-Type":"application/json"},',
            '    body:JSON.stringify({mac:mac})})',
            '  .then(function(){fetchAll();}).catch(function(){});',
            '}',
            '',
            '// ── Rename ────────────────────────────────────────',
            'function openRename(mac,name){',
            '  _renameMac=mac;',
            '  var inp=document.getElementById("rename-inp");',
            '  if(inp)inp.value=name||"";',
            '  var m=document.getElementById("rename-modal");',
            '  if(m)m.classList.add("show");',
            '  if(inp)inp.focus();',
            '}',
            'function closeRename(){',
            '  var m=document.getElementById("rename-modal");',
            '  if(m)m.classList.remove("show");',
            '}',
            'function confirmRename(){',
            '  var inp=document.getElementById("rename-inp");',
            '  var name=inp?inp.value.trim():"";',
            '  if(!name||!_renameMac)return;',
            '  fetch("/api/device-rename",{method:"POST",headers:{"Content-Type":"application/json"},',
            '    body:JSON.stringify({mac:_renameMac,name:name})})',
            '  .then(function(){closeRename();fetchAll();}).catch(function(){});',
            '}',
            '',
            '// ── Delete Firmware ───────────────────────────────',
            'function delFirmware(name){',
            '  if(!confirm("Firmware "+name+" l\\u00f6schen?"))return;',
            '  fetch("/api/firmware-delete",{method:"POST",headers:{"Content-Type":"application/json"},',
            '    body:JSON.stringify({name:name})})',
            '  .then(function(){fetchAll();}).catch(function(){});',
            '}',
            '',
            '// ── Firmware Upload ───────────────────────────────',
            'function setupUpload(){',
            '  var inp=document.getElementById("fw-input");',
            '  var area=document.getElementById("upload-area");',
            '  if(!inp||!area)return;',
            '  area.addEventListener("click",function(){inp.click();});',
            '  inp.addEventListener("change",function(){',
            '    if(!inp.files.length)return;',
            '    uploadFile(inp.files[0]);',
            '    inp.value="";',
            '  });',
            '  area.addEventListener("dragover",function(e){e.preventDefault();area.classList.add("drag");});',
            '  area.addEventListener("dragleave",function(){area.classList.remove("drag");});',
            '  area.addEventListener("drop",function(e){',
            '    e.preventDefault();area.classList.remove("drag");',
            '    var f=e.dataTransfer.files[0];',
            '    if(!f||!f.name.endsWith(".bin")){alert("Nur .bin Dateien!");return;}',
            '    uploadFile(f);',
            '  });',
            '}',
            'function uploadFile(file){',
            '  var area=document.getElementById("upload-area");',
            '  if(area)area.textContent="\\u23F3 Uploade "+file.name+"...";',
            '  var fd=new FormData();fd.append("firmware",file);',
            '  fetch("/api/firmware-upload",{method:"POST",body:fd})',
            '  .then(function(r){return r.json();})',
            '  .then(function(res){',
            '    if(area)area.innerHTML=\'&#128190; <b>.bin</b> Datei hierher ziehen oder klicken\';',
            '    if(res.ok)fetchAll();',
            '    else alert("Upload-Fehler: "+res.error);',
            '  }).catch(function(e){',
            '    if(area)area.innerHTML=\'&#128190; <b>.bin</b> Datei hierher ziehen oder klicken\';',
            '    alert("Fehler: "+e);',
            '  });',
            '}',
            '',
            '// ── Self Update ───────────────────────────────────',
            'document.getElementById("upd-btn").addEventListener("click",function(){',
            '  if(!confirm("Adapter aktualisieren und neu starten?"))return;',
            '  fetch("/api/update",{method:"POST"}).then(function(r){return r.json();})',
            '  .then(function(res){',
            '    var el=document.getElementById("upd-msg");',
            '    if(el)el.textContent=res.message||"Update gestartet...";',
            '  });',
            '});',
            '',
            '// ── Log Filters ───────────────────────────────────',
            'document.getElementById("lf-level").addEventListener("change",renderLogs);',
            'document.getElementById("lf-cat").addEventListener("input",renderLogs);',
            'document.getElementById("lf-txt").addEventListener("input",renderLogs);',
            '',
            '// ── Log Export ────────────────────────────────────',
            'document.getElementById("log-export-btn").addEventListener("click",function(){',
            '  var txt=logs.map(function(l){return l.ts+" ["+l.level+"] ["+l.cat+"] "+l.msg;}).join("\\n");',
            '  var a=document.createElement("a");',
            '  a.href="data:text/plain;charset=utf-8,"+encodeURIComponent(txt);',
            '  a.download="esphub-logs.txt";a.click();',
            '});',
            '',
            '// ── Version Check ─────────────────────────────────',
            'fetch("/api/version").then(function(r){return r.json();}).then(function(v){',
            '  if(v.updateAvailable){',
            '    var el=document.getElementById("hdr-upd");',
            '    if(el){el.style.display="";el.innerHTML=\'<span class="badge badge-yellow">&#11014; v\'+v.latest+\' verf\\u00fcgbar</span>\';}',
            '  }',
            '}).catch(function(){});',
            '',
            '// ── Rename modal close on backdrop ────────────────',
            'document.getElementById("rename-modal").addEventListener("click",function(e){',
            '  if(e.target===this)closeRename();',
            '});',
            '',
            '// ── Init ──────────────────────────────────────────',
            'setupUpload();',
            'fetchAll();',
            'setInterval(fetchAll,15000);',
        ].join('\n');

        return '<!DOCTYPE html>\n<html lang="de">\n<head>\n<meta charset="UTF-8">\n' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
            '<title>ESP-Hub</title>\n<style>\n' + CSS + '\n</style>\n</head>\n<body>\n' +
            BODY + '\n<script>\n' + JS + '\n</script>\n</body>\n</html>';
    }
}

// ─── Entry Point ───────────────────────────────────────────────────────────

if (require.main !== module) {
    module.exports = (options) => new EspHub(options);
} else {
    new EspHub();
}
