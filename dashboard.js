require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { getWooCommerceOrders, fulfillWooOrder } = require('./marketplace-woocommerce');

const app = express();

const PORT = Number(process.env.DASHBOARD_PORT || 3002);
const STATUS_FILE = process.env.STATUS_FILE || 'C:\\docmorris-auto\\status.json';

const INVOICE_DIR = process.env.INVOICE_DIR || 'G:\\DocMorris-Rechnungen';
const PRINT_ARCHIVE_DIR = process.env.PRINT_ARCHIVE_DIR || 'G:\\DocMorris-Druckarchiv';
const LABEL_ARCHIVE_DIR = path.join(PRINT_ARCHIVE_DIR, 'labels');
const SLIP_ARCHIVE_DIR = path.join(PRINT_ARCHIVE_DIR, 'lieferscheine');
const RETURN_ARCHIVE_DIR = process.env.RETURN_ARCHIVE_DIR || path.join(PRINT_ARCHIVE_DIR, 'retouren');

const LOG_DIR = process.env.LOG_DIR || 'G:\\DocMorris-Logs';
const ERROR_DIR = process.env.ERROR_DIR || 'G:\\DocMorris-Fehler';
const SKIP_FILE = process.env.SKIP_FILE || path.join(ERROR_DIR, 'skip-orders.json');

const APP_DIR = process.env.APP_DIR || 'C:\\docmorris-auto';
const DOCMORRIS_PROCESS = process.env.DOCMORRIS_PROCESS || 'docmorris-autoprint';
const MIRAKL_DE_PROCESS = process.env.MIRAKL_DE_PROCESS || 'mirakl-autoprint-de';
const MIRAKL_UPS_PROCESS = process.env.MIRAKL_UPS_PROCESS || 'mirakl-ups';
const DASHBOARD_PROCESS = process.env.DASHBOARD_PROCESS || 'docmorris-dashboard';

const MIRAKL_LOG_FILE = process.env.MIRAKL_LOG_FILE || 'G:\\DocMorris-Logs\\mirakl-autoprint.log';
const PRINTED_MIRAKL_FILE = process.env.PRINTED_MIRAKL_FILE || 'C:\\docmorris-auto\\printed-mirakl.json';
const CARRIER_CONFIG_FILE =
  process.env.CARRIER_CONFIG_FILE ||
  'C:\\docmorris-auto\\carrier-config.json';

const APP_VERSION = process.env.APP_VERSION || '1.1.0';
const APP_BUILD = process.env.APP_BUILD || 'v3';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function esc(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readCarrierConfig() {
  return readJson(CARRIER_CONFIG_FILE, {
    DE: 'DHL',
    AT: 'DHL',
    IT: 'DHL',
    BE: 'UPS'
  });
}

function writeCarrierConfig(config) {
  writeJson(CARRIER_CONFIG_FILE, config);
}


function safeReadText(file) {
  try {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function tailLines(text, count = 120) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-count);
}

function readStatus() {
  return readJson(STATUS_FILE, {
    status: 'WARTET',
    lastScan: null,
    nextScan: null,
    lastOrder: null,
    lastPrint: null,
    lastError: null,
    lastErrorFile: null
  });
}

function readErrors() {
  if (!fs.existsSync(ERROR_DIR)) return [];

  return fs.readdirSync(ERROR_DIR)
    .filter(file => file.startsWith('error_') && file.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 10)
    .map(file => {
      const data = readJson(path.join(ERROR_DIR, file), null);
      if (!data) return null;

      return {
        file,
        order: data.orderName || '-',
        time: data.time || '-',
        message: data.errorMessage || '-'
      };
    })
    .filter(Boolean);
}

function readSkips() {
  const skips = readJson(SKIP_FILE, []);
  return Array.isArray(skips) ? skips : [];
}

function readLogs() {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, 'autoprint_' + today + '.log');
  return tailLines(safeReadText(file), 120);
}

function readMiraklLogs() {
  return tailLines(safeReadText(MIRAKL_LOG_FILE), 160);
}

function readPdfList(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(file => file.toLowerCase().endsWith('.pdf'))
    .map(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      return { file, created: stat.mtime };
    })
    .sort((a, b) => b.created - a.created)
    .slice(0, 50);
}

function getHealthStats() {
  const logs = readLogs();
  const status = readStatus();

  return {
    successToday: logs.filter(line => line.includes('Fertig:')).length,
    errorsToday: logs.filter(line => line.includes('Fehler') || line.includes('[ERROR]') || line.toLowerCase().includes('fehler')).length,
    skipped: readSkips().length,
    lastErrorActive: Boolean(status.lastError)
  };
}

function getMiraklStats() {
  const lines = readMiraklLogs();
  const printed = readJson(PRINTED_MIRAKL_FILE, []);
  const safePrinted = Array.isArray(printed) ? printed : [];

  return {
    ready: lines.filter(x => x.includes('READY ')).length,
    done: lines.filter(x => x.includes('DONE ')).length,
    skip: lines.filter(x => x.includes('SKIP ')).length,
    wait: lines.filter(x => x.includes('WAIT ')).length,
    print: lines.filter(x => x.includes('PRINT ')).length,
    error: lines.filter(x => x.toLowerCase().includes('error') || x.toLowerCase().includes('fehler')).length,
    printedTotal: safePrinted.length,
    lastLines: lines
  };
}

function getOrderFromInvoiceFile(file) {
  const name = String(file || '').replace(/\.pdf$/i, '');
  const parts = name.split('_');
  if (parts.length >= 3) return parts[2];
  if (parts.length >= 2) return parts[1];
  return name;
}

function runCommand(command) {
  return new Promise(resolve => {
    exec(command, { cwd: APP_DIR, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        command,
        ok: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? error.message : ''
      });
    });
  });
}

async function getPm2Processes() {
  const result = await runCommand('pm2.cmd jlist');
  if (!result.ok) return [];

  try {
    const list = JSON.parse(result.stdout || '[]');
    return list.map(p => ({
      id: p.pm_id,
      name: p.name,
      status: p.pm2_env?.status || '-',
      restarts: p.pm2_env?.restart_time || 0,
      memory: p.monit?.memory || 0,
      cpu: p.monit?.cpu || 0,
      script: p.pm2_env?.pm_exec_path || '-'
    }));
  } catch {
    return [];
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value = value / 1024;
    i++;
  }
  return value.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

async function getDiskStats() {
  const command = 'powershell -NoProfile -Command "Get-PSDrive -Name C,G | Select-Object Name,Used,Free | ConvertTo-Json -Compress"';
  const result = await runCommand(command);
  if (!result.ok) return [];

  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function renderActionResult(result) {
  if (!result) return '';

  const text =
    'Befehl: ' + (result.command || '-') + '\n\n' +
    'Erfolg: ' + String(Boolean(result.ok)) + '\n\n' +
    'STDOUT:\n' + (result.stdout || '') + '\n\n' +
    'STDERR:\n' + (result.stderr || '') + '\n\n' +
    'ERROR:\n' + (typeof result.error === 'string' ? result.error : JSON.stringify(result.error || '', null, 2));

  return '<div class="card"><h2>Letzte Aktion</h2><pre>' + esc(text) + '</pre></div>';
}

function renderPostOnlyError(route) {
  return renderPage({ command: 'GET ' + route, ok: false, stdout: '', stderr: '', error: 'Diese Aktion muss ueber den Button im Dashboard ausgefuehrt werden.' });
}

async function renderPageAsync(actionResult) {
  const processes = await getPm2Processes();
  const disks = await getDiskStats();
  return renderPage(actionResult, { processes, disks });
}

function processCommand(processName, action) {
  const safe = String(processName || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  if (!['start', 'stop', 'restart'].includes(action)) return null;
  if (action === 'restart') return 'pm2.cmd restart ' + safe + ' --update-env';
  return 'pm2.cmd ' + action + ' ' + safe;
}

app.post('/control/process/:action/:process', async (req, res) => {
  const command = processCommand(req.params.process, req.params.action);
  if (!command) return res.send(await renderPageAsync({ command: 'process control', ok: false, error: 'Ungueltige Aktion.' }));
  const result = await runCommand(command);
  res.send(await renderPageAsync(result));
});

app.post('/control/start', async (req, res) => res.send(await renderPageAsync(await runCommand('pm2.cmd start autopilot.js --name ' + DOCMORRIS_PROCESS))));
app.post('/control/stop', async (req, res) => res.send(await renderPageAsync(await runCommand('pm2.cmd stop ' + DOCMORRIS_PROCESS))));
app.post('/control/restart', async (req, res) => res.send(await renderPageAsync(await runCommand('pm2.cmd restart ' + DOCMORRIS_PROCESS + ' --update-env'))));
app.post('/control/restart-dashboard', async (req, res) => res.send(await renderPageAsync(await runCommand('pm2.cmd restart ' + DASHBOARD_PROCESS + ' --update-env'))));
app.post('/control/restart-all', async (req, res) => res.send(await renderPageAsync(await runCommand('pm2.cmd restart all --update-env'))));
app.post('/control/pm2-list', async (req, res) => res.send(await renderPageAsync(await runCommand('pm2.cmd list'))));
app.post('/control/git-status', async (req, res) => res.send(await renderPageAsync(await runCommand('git status'))));
app.post('/control/git-log', async (req, res) => res.send(await renderPageAsync(await runCommand('git log --oneline -8'))));
app.post('/control/git-backup', async (req, res) => res.send(await renderPageAsync(await runCommand('git add . && git commit -m "manual dashboard backup" && git push'))));

app.post('/control/retry-order', async (req, res) => {
  const order = String(req.body.order || '').trim();
  if (!order) return res.send(await renderPageAsync({ command: 'retry order', ok: false, error: 'Keine Bestellnummer.' }));

  const skips = readSkips().filter(x => x !== order);
  writeJson(SKIP_FILE, skips);

  const result = await runCommand('pm2.cmd restart ' + DOCMORRIS_PROCESS + ' --update-env');
  res.send(await renderPageAsync({
    command: 'retry ' + order,
    ok: result.ok,
    stdout: 'Bestellung wurde freigegeben: ' + order + '\n\n' + result.stdout,
    stderr: result.stderr,
    error: result.error
  }));
});

app.post('/control/remove-skip', async (req, res) => {
  const order = String(req.body.order || '').trim();
  const skips = readSkips().filter(x => x !== order);
  writeJson(SKIP_FILE, skips);
  res.send(await renderPageAsync({ command: 'remove skip ' + order, ok: true, stdout: 'Bestellung wurde aus der Skip-Liste entfernt: ' + order, stderr: '', error: '' }));
});

app.post('/control/clear-skips', async (req, res) => {
  writeJson(SKIP_FILE, []);
  res.send(await renderPageAsync({ command: 'clear skip-orders.json', ok: true, stdout: 'Skip-Liste wurde geleert.', stderr: '', error: '' }));
});

app.post('/control/reprint-invoice', async (req, res) => {
  const order = String(req.body.order || '').trim();
  if (!order) return res.send(await renderPageAsync({ command: 'node reprint-invoice.js', ok: false, error: 'Keine Bestellnummer.' }));
  res.send(await renderPageAsync(await runCommand('node reprint-invoice.js ' + order)));
});

app.post('/control/reprint-packing-slip', async (req, res) => {
  const order = String(req.body.order || '').trim();
  if (!order) return res.send(await renderPageAsync({ command: 'node reprint-packing-slip.js', ok: false, error: 'Keine Bestellnummer.' }));
  res.send(await renderPageAsync(await runCommand('node reprint-packing-slip.js ' + order)));
});

app.post('/control/create-return-label', async (req, res) => {
  const order = String(req.body.order || '').trim();
  if (!order) return res.send(await renderPageAsync({ command: 'node create-return-label.js', ok: false, error: 'Keine Bestellnummer.' }));
  res.send(await renderPageAsync(await runCommand('node create-return-label.js ' + order)));
});

app.post('/control/fulfill-woo', async (req, res) => {
  const orderId = String(req.body.orderId || '').trim();
  const tracking = String(req.body.tracking || '').trim();
  const trackingUrl = String(req.body.url || '').trim();

  if (!orderId || !tracking || tracking === '-') {
    return res.send(await renderPageAsync({
      command: 'fulfill woo',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Keine gueltige Trackingnummer vorhanden.'
    }));
  }

  try {
    await fulfillWooOrder(orderId, tracking, trackingUrl);
    res.send(await renderPageAsync({
      command: 'fulfill woo ' + orderId,
      ok: true,
      stdout: 'WooCommerce-Bestellung wurde auf completed gesetzt.',
      stderr: '',
      error: ''
    }));
  } catch (err) {
    res.send(await renderPageAsync({
      command: 'fulfill woo',
      ok: false,
      stdout: '',
      stderr: '',
      error: JSON.stringify((err.response && err.response.data) || err.message, null, 2)
    }));
  }
});

app.post('/control/set-carrier', async (req, res) => {
  const country = String(req.body.country || '').toUpperCase();
  const carrier = String(req.body.carrier || '').toUpperCase();

  const allowedCountries = ['DE', 'AT', 'IT', 'BE'];
  const allowedCarriers = ['DHL', 'UPS'];

  if (!allowedCountries.includes(country) || !allowedCarriers.includes(carrier)) {
    return res.send(await renderPageAsync({
      command: 'set carrier',
      ok: false,
      error: 'Ungueltiges Land oder ungueltiger Carrier.'
    }));
  }

  const config = readCarrierConfig();
  config[country] = carrier;
  writeCarrierConfig(config);

  res.send(await renderPageAsync({
    command: 'carrier switch',
    ok: true,
    stdout: country + ' → ' + carrier + ' gesetzt',
    stderr: '',
    error: ''
  }));
});
[
  '/control/start', '/control/stop', '/control/restart', '/control/restart-dashboard', '/control/restart-all',
  '/control/pm2-list', '/control/git-status', '/control/git-log', '/control/git-backup', '/control/retry-order',
  '/control/remove-skip', '/control/clear-skips', '/control/reprint-invoice', '/control/reprint-packing-slip',
  '/control/create-return-label', '/control/fulfill-woo'
].forEach(route => app.get(route, async (req, res) => res.send(await renderPageAsync({ command: 'GET ' + route, ok: false, error: 'Diese Aktion muss ueber den Button im Dashboard ausgefuehrt werden.' }))));

app.get('/api/woocommerce/orders', async (req, res) => {
  try {
    const orders = await getWooCommerceOrders(20);
    res.json({ ok: true, orders });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err.response && err.response.data) || err.message });
  }
});

app.get('/api/pm2', async (req, res) => res.json({ ok: true, processes: await getPm2Processes() }));
app.get('/api/disk', async (req, res) => res.json({ ok: true, disks: await getDiskStats() }));
app.get('/api/status', (req, res) => res.json(readStatus()));
app.get('/api/errors', (req, res) => res.json({ errors: readErrors() }));
app.get('/api/skips', (req, res) => res.json({ skips: readSkips() }));
app.get('/api/logs', (req, res) => res.json({ logs: readLogs() }));
app.get('/api/mirakl', (req, res) => res.json({ ok: true, stats: getMiraklStats() }));

app.use('/invoices', express.static(INVOICE_DIR));
app.use('/labels', express.static(LABEL_ARCHIVE_DIR));
app.use('/slips', express.static(SLIP_ARCHIVE_DIR));
app.use('/returns', express.static(RETURN_ARCHIVE_DIR));

function renderStatusPill(status) {
  const s = String(status || '-').toLowerCase();
  const cls = s === 'online' ? 'ok' : s === 'stopped' ? 'warn' : 'bad';
  return '<span class="pill ' + cls + '">' + esc(status || '-') + '</span>';
}

function renderProcessCards(processes) {
  const wanted = [DOCMORRIS_PROCESS, MIRAKL_DE_PROCESS, MIRAKL_UPS_PROCESS, DASHBOARD_PROCESS];
  const cards = wanted.map(name => {
    const p = processes.find(x => x.name === name);
    const status = p ? p.status : 'missing';
    const mem = p ? formatBytes(p.memory) : '-';
    const cpu = p ? String(p.cpu || 0) + '%' : '-';

    return [
      '<div class="mini-card">',
        '<div class="mini-title">' + esc(name) + '</div>',
        '<div class="mini-status">' + renderStatusPill(status) + '</div>',
        '<div class="small">CPU ' + esc(cpu) + ' · RAM ' + esc(mem) + '</div>',
        '<div class="mini-actions">',
          '<form method="POST" action="/control/process/start/' + esc(name) + '"><button class="green" type="submit">Start</button></form>',
          '<form method="POST" action="/control/process/stop/' + esc(name) + '"><button class="red" type="submit">Stop</button></form>',
          '<form method="POST" action="/control/process/restart/' + esc(name) + '"><button class="orange" type="submit">Restart</button></form>',
        '</div>',
      '</div>'
    ].join('');
  }).join('');

  return '<div class="card"><h2>Prozesse</h2><div class="mini-grid">' + cards + '</div></div>';
}

function renderDiskCards(disks) {
  if (!disks || disks.length === 0) return '<div class="card"><h2>Speicher</h2><p class="empty warn-text">Keine Laufwerksdaten.</p></div>';

  const html = disks.map(d => {
    const used = Number(d.Used || 0);
    const free = Number(d.Free || 0);
    const total = used + free;
    const percent = total ? Math.round((used / total) * 100) : 0;
    const cls = percent > 92 ? 'badbar' : percent > 80 ? 'warnbar' : 'okbar';

    return [
      '<div class="mini-card">',
        '<div class="mini-title">Laufwerk ' + esc(d.Name) + ':</div>',
        '<div class="bar"><div class="bar-fill ' + cls + '" style="width:' + percent + '%"></div></div>',
        '<div class="small">Belegt ' + esc(formatBytes(used)) + ' · Frei ' + esc(formatBytes(free)) + ' · ' + percent + '%</div>',
      '</div>'
    ].join('');
  }).join('');

  return '<div class="card"><h2>Speicherplatz</h2><div class="mini-grid">' + html + '</div></div>';
}

function renderStatusHeader(s, health, color) {
  return [
    '<div class="card hero-card">',
      '<div>',
        '<h1>Fulfillment Dashboard V3</h1>',
        '<p class="small">Version ' + esc(APP_VERSION) + ' | Build ' + esc(APP_BUILD) + ' | Port ' + PORT + '</p>',
      '</div>',
      '<div class="status" style="color:' + color + '">' + esc(s.status) + '</div>',
    '</div>',
    '<div class="card">',
      '<h2>System Health</h2>',
      '<div class="grid">',
        '<div>',
          '<div class="row"><span class="label">Autopilot:</span>' + (s.status === 'OK' ? 'Aktiv' : 'Pruefen') + '</div>',
          '<div class="row"><span class="label">Letzter Scan:</span>' + esc(s.lastScan || '-') + '</div>',
          '<div class="row"><span class="label">Naechster Scan:</span>' + esc(s.nextScan || '-') + '</div>',
          '<div class="row"><span class="label">Letzter Druck:</span>' + esc(s.lastPrint || '-') + '</div>',
          '<div class="row"><span class="label">Letzte Bestellung:</span>' + esc(s.lastOrder || '-') + '</div>',
        '</div>',
        '<div>',
          '<div class="row"><span class="label">Heute fertig:</span>' + health.successToday + '</div>',
          '<div class="row"><span class="label">Fehler heute:</span>' + health.errorsToday + '</div>',
          '<div class="row"><span class="label">Skip-Liste:</span>' + health.skipped + '</div>',
          '<div class="row"><span class="label">Fehlerstatus:</span>' + (health.lastErrorActive ? 'Fehler vorhanden' : 'Kein aktiver Fehler') + '</div>',
        '</div>',
      '</div>',
    '</div>'
  ].join('');
}

function renderControlCard() {
  return [
    '<div class="card">',
      '<h2>Systemsteuerung</h2>',
      '<div class="buttons">',
        '<form method="POST" action="/control/start"><button class="green" type="submit">DocMorris starten</button></form>',
        '<form method="POST" action="/control/stop"><button class="red" type="submit">DocMorris stoppen</button></form>',
        '<form method="POST" action="/control/restart"><button class="orange" type="submit">DocMorris neu starten</button></form>',
        '<form method="POST" action="/control/restart-dashboard"><button class="blue" type="submit">Dashboard neu starten</button></form>',
        '<form method="POST" action="/control/restart-all"><button class="dark" type="submit">Alles neu starten</button></form>',
        '<form method="POST" action="/control/pm2-list"><button class="gray" type="submit">PM2 Status</button></form>',
        '<form method="POST" action="/control/clear-skips"><button class="red" type="submit">Skip-Liste leeren</button></form>',
      '</div>',
      '<p class="danger-note">Skip-Liste leeren gibt alle uebersprungenen Bestellungen wieder frei.</p>',
    '</div>'
  ].join('');
}

function renderErrorsCard(errors) {
  if (errors.length === 0) return '<div class="card"><h2>Fehler</h2><p class="empty">Keine Fehler vorhanden.</p></div>';

  const rows = errors.map(e => [
    '<tr>',
      '<td>' + esc(e.time) + '</td>',
      '<td><span class="badge">' + esc(e.order) + '</span></td>',
      '<td>',
        esc(e.message),
        '<form method="POST" action="/control/retry-order">',
          '<input type="hidden" name="order" value="' + esc(e.order) + '">',
          '<button class="orange" type="submit">Erneut versuchen</button>',
        '</form>',
      '</td>',
    '</tr>'
  ].join('')).join('');

  return '<div class="card"><h2>Fehler</h2><table><thead><tr><th>Zeit</th><th>Bestellung</th><th>Fehler</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderSkipsCard(skips) {
  if (skips.length === 0) return '<div class="card"><h2>Uebersprungene Bestellungen</h2><p class="empty">Keine uebersprungenen Bestellungen.</p></div>';

  const rows = skips.map(order => [
    '<tr>',
      '<td><span class="badge">' + esc(order) + '</span></td>',
      '<td>',
        '<form method="POST" action="/control/remove-skip">',
          '<input type="hidden" name="order" value="' + esc(order) + '">',
          '<button class="orange" type="submit">Freigeben</button>',
        '</form>',
      '</td>',
    '</tr>'
  ].join('')).join('');

  return '<div class="card"><h2>Uebersprungene Bestellungen</h2><table><thead><tr><th>Bestellung</th><th>Aktion</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderInvoicesCard(invoices) {
  if (invoices.length === 0) return '<div class="card"><h2>Letzte Rechnungen</h2><p class="empty">Keine Rechnungen vorhanden.</p></div>';

  const rows = invoices.map(inv => {
    const order = getOrderFromInvoiceFile(inv.file);
    return [
      '<tr>',
        '<td>' + esc(inv.file) + '</td>',
        '<td>' + esc(new Date(inv.created).toLocaleString('de-DE')) + '</td>',
        '<td>',
          '<a href="/invoices/' + encodeURIComponent(inv.file) + '" target="_blank">PDF oeffnen</a>',
          '<form method="POST" action="/control/reprint-invoice"><input type="hidden" name="order" value="' + esc(order) + '"><button class="blue" type="submit">Rechnung neu erzeugen</button></form>',
          '<form method="POST" action="/control/reprint-packing-slip"><input type="hidden" name="order" value="' + esc(order) + '"><button class="orange" type="submit">Lieferschein drucken</button></form>',
          '<form method="POST" action="/control/create-return-label"><input type="hidden" name="order" value="' + esc(order) + '"><button class="red" type="submit">Retourenlabel erstellen</button></form>',
        '</td>',
      '</tr>'
    ].join('');
  }).join('');

  return '<div class="card"><h2>Letzte Rechnungen</h2><p class="small">Maximal 50 Rechnungen.</p><div class="pdf-list"><table><thead><tr><th>Datei</th><th>Geaendert</th><th>Aktion</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

function renderPdfArchiveCard(title, description, items, baseUrl, emptyText) {
  if (items.length === 0) return '<div class="card"><h2>' + esc(title) + '</h2><p class="small">' + esc(description) + '</p><p class="empty">' + esc(emptyText) + '</p></div>';

  const rows = items.map(item => [
    '<tr>',
      '<td>' + esc(item.file) + '</td>',
      '<td>' + esc(new Date(item.created).toLocaleString('de-DE')) + '</td>',
      '<td><a href="' + baseUrl + '/' + encodeURIComponent(item.file) + '" target="_blank">Oeffnen</a></td>',
    '</tr>'
  ].join('')).join('');

  return '<div class="card"><h2>' + esc(title) + '</h2><p class="small">' + esc(description) + '</p><div class="pdf-list"><table><thead><tr><th>Datei</th><th>Geaendert</th><th>Aktion</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

function renderLogsCard(logs) {
  return '<div class="card"><h2>Live-Log heute</h2><pre>' + esc(logs.join('\n') || 'Keine Logs vorhanden.') + '</pre></div>';
}

function renderMiraklCard(stats) {
  return [
    '<div class="card">',
      '<h2>Mirakl / ShopApotheke</h2>',
      '<div class="metric-grid">',
        '<div class="metric"><span>READY</span><b>' + stats.ready + '</b></div>',
        '<div class="metric"><span>DONE</span><b>' + stats.done + '</b></div>',
        '<div class="metric"><span>SKIP</span><b>' + stats.skip + '</b></div>',
        '<div class="metric"><span>WAIT</span><b>' + stats.wait + '</b></div>',
        '<div class="metric"><span>PRINT</span><b>' + stats.print + '</b></div>',
        '<div class="metric"><span>Printed JSON</span><b>' + stats.printedTotal + '</b></div>',
      '</div>',
      '<p class="small">Basis: ' + esc(MIRAKL_LOG_FILE) + ' und ' + esc(PRINTED_MIRAKL_FILE) + '</p>',
      '<pre>' + esc(stats.lastLines.join('\n') || 'Keine Mirakl-Logs vorhanden.') + '</pre>',
    '</div>'
  ].join('');
}

function renderGitCard() {
  return [
    '<div class="card">',
      '<h2>Git / Backup</h2>',
      '<div class="buttons">',
        '<form method="POST" action="/control/git-status"><button class="gray" type="submit">Git Status</button></form>',
        '<form method="POST" action="/control/git-log"><button class="blue" type="submit">Letzte Versionen</button></form>',
        '<form method="POST" action="/control/git-backup"><button class="green" type="submit">Manuelles Backup</button></form>',
      '</div>',
    '</div>'
  ].join('');
}


function renderCarrierCard() {
  const config = readCarrierConfig();

  const countries = ['DE', 'AT', 'IT', 'BE'];

  const rows = countries.map(country => {
    const current = String(config[country] || 'DHL').toUpperCase();

    return [
      '<tr>',
        '<td><b>' + esc(country) + '</b></td>',
        '<td>' + esc(current) + '</td>',
        '<td>',
          '<form method="POST" action="/control/set-carrier" style="display:inline-block;margin-right:8px;">',
            '<input type="hidden" name="country" value="' + esc(country) + '">',
            '<input type="hidden" name="carrier" value="DHL">',
            '<button class="blue" type="submit">DHL</button>',
          '</form>',
          '<form method="POST" action="/control/set-carrier" style="display:inline-block;">',
            '<input type="hidden" name="country" value="' + esc(country) + '">',
            '<input type="hidden" name="carrier" value="UPS">',
            '<button class="orange" type="submit">UPS</button>',
          '</form>',
        '</td>',
      '</tr>'
    ].join('');
  }).join('');

  return [
    '<div class="card">',
      '<h2>Carrier Routing</h2>',
      '<p class="small">Live-Steuerung fuer Sendcloud Carrier Routing.</p>',
      '<table>',
        '<thead>',
          '<tr>',
            '<th>Land</th>',
            '<th>Aktiver Carrier</th>',
            '<th>Umschalten</th>',
          '</tr>',
        '</thead>',
        '<tbody>',
          rows,
        '</tbody>',
      '</table>',
    '</div>'
  ].join('');
}

function renderHelpCard() {
  const commands = [
    ['PM2 Status', 'pm2.cmd list'],
    ['Logs Dashboard', 'pm2.cmd logs docmorris-dashboard --lines 100'],
    ['Logs DHL / DE', 'pm2.cmd logs mirakl-autoprint-de --lines 100'],
    ['Logs UPS / Ausland', 'pm2.cmd logs mirakl-ups --lines 100'],
    ['DE Worker starten', 'pm2.cmd start C:\\docmorris-auto\\mirakl-autoprint.js --name mirakl-autoprint-de'],
    ['UPS Worker starten', 'pm2.cmd start C:\\docmorris-auto\\mirakl-autoprint-ups.js --name mirakl-ups'],
    ['DE Worker neu starten', 'pm2.cmd restart mirakl-autoprint-de --update-env'],
    ['UPS Worker neu starten', 'pm2.cmd restart mirakl-ups --update-env'],
    ['Dashboard neu starten', 'pm2.cmd restart docmorris-dashboard --update-env'],
    ['PM2 speichern', 'pm2.cmd save'],
    ['Reconcile prüfen', 'node C:\\docmorris-auto\\reconcile-mirakl-shopify.js'],
    ['Repair ausführen', 'node C:\\docmorris-auto\\repair-mirakl-shopify.js'],
    ['UPS Syntax prüfen', 'node --check C:\\docmorris-auto\\mirakl-autoprint-ups.js'],
    ['DE Syntax prüfen', 'node --check C:\\docmorris-auto\\mirakl-autoprint.js'],
    ['Dashboard Syntax prüfen', 'node --check C:\\docmorris-auto\\dashboard.js'],
    ['Mirakl-State öffnen', 'notepad C:\\docmorris-auto\\mirakl-processing.json'],
    ['Printed-Liste öffnen', 'notepad C:\\docmorris-auto\\printed-mirakl.json'],
    ['ENV öffnen', 'notepad C:\\docmorris-auto\\.env']
  ];

  const rows = commands.map(([label, command]) => [
    '<tr>',
      '<td><b>' + esc(label) + '</b></td>',
      '<td><code>' + esc(command) + '</code></td>',
    '</tr>'
  ].join('')).join('');

  return [
    '<div class="card">',
      '<h2>PowerShell Hilfe / Notfallbefehle</h2>',
      '<p class="small">Diese Befehle kannst du direkt in PowerShell kopieren.</p>',
      '<table><thead><tr><th>Zweck</th><th>Befehl</th></tr></thead><tbody>',
        rows,
      '</tbody></table>',
    '</div>'
  ].join('');
}

function renderPlaceholderCard(title, subtitle, items) {
  items = items || [];
  return ['<div class="card"><h2>' + esc(title) + '</h2><p class="small">' + esc(subtitle) + '</p>', items.length ? '<ul>' + items.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>' : '<p class="empty">Noch kein aktives Modul angebunden.</p>', '</div>'].join('');
}

function renderWooCommerceCard() {
  return [
    '<div class="card">',
      '<h2>WooCommerce - Letzte Bestellungen</h2>',
      '<p class="small">Live-Daten aus WooCommerce, Tracking ergaenzt ueber Sendcloud.</p>',
      '<div id="woo-loading">Lade WooCommerce-Daten...</div>',
      '<div id="woo-table" style="display:none;">',
        '<table><thead><tr><th>Bestellung</th><th>Name</th><th>Ort</th><th>Status</th><th>Carrier</th><th>Tracking</th><th>Datum</th><th>Aktion</th></tr></thead><tbody id="woo-body"></tbody></table>',
      '</div>',
    '</div>'
  ].join('');
}

function renderPage(actionResult, dynamic = {}) {
  const s = readStatus();
  const errors = readErrors();
  const skips = readSkips();
  const logs = readLogs();
  const invoices = readPdfList(INVOICE_DIR);
  const labels = readPdfList(LABEL_ARCHIVE_DIR);
  const slips = readPdfList(SLIP_ARCHIVE_DIR);
  const returns = readPdfList(RETURN_ARCHIVE_DIR);
  const health = getHealthStats();
  const miraklStats = getMiraklStats();

  const color = s.status === 'OK' ? '#22c55e' : s.status === 'FEHLER' ? '#ef4444' : '#f59e0b';

  return [
    '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="20"><title>Fulfillment Dashboard V3</title>',
    '<style>',
      ':root{--bg:#0b1120;--panel:#111827;--panel2:#172033;--text:#e5e7eb;--muted:#94a3b8;--line:#263244;--blue:#3b82f6;--green:#22c55e;--red:#ef4444;--orange:#f59e0b;--gray:#64748b;}',
      '*{box-sizing:border-box}body{font-family:Inter,Arial,sans-serif;background:linear-gradient(180deg,#07111f 0%,#111827 100%);padding:28px;color:var(--text);margin:0;} .wrap{max-width:1700px;margin:0 auto;}',
      '.tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;position:sticky;top:0;z-index:10;background:rgba(11,17,32,.94);backdrop-filter:blur(8px);padding:10px 0;border-bottom:1px solid var(--line)}',
      '.tab{display:none}.tab.active{display:block}.tab-button{background:#1f2937;color:#e5e7eb;border:1px solid #334155}.tab-button.active{background:var(--blue);border-color:var(--blue)}',
      '.card{background:rgba(17,24,39,.92);border:1px solid var(--line);border-radius:18px;padding:24px;margin-bottom:20px;box-shadow:0 12px 34px rgba(0,0,0,.26)}',
      '.hero-card{display:flex;justify-content:space-between;align-items:center;gap:20px;background:linear-gradient(135deg,#101827 0%,#1d2b46 100%)}h1{margin:0;font-size:32px}h2{margin-top:0}.status{font-size:28px;font-weight:800;white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.mini-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.metric-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}.mini-card,.metric{background:var(--panel2);border:1px solid var(--line);border-radius:16px;padding:16px}.mini-title{font-weight:800;margin-bottom:10px}.mini-status{margin:8px 0}.mini-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.metric span{display:block;color:var(--muted);font-size:12px}.metric b{font-size:26px}',
      '.row{margin:12px 0;font-size:16px}.label{color:var(--muted);width:185px;display:inline-block}.small{color:var(--muted);font-size:13px}.empty{color:var(--green);font-weight:800}.warn-text{color:var(--orange)}',
      'pre{background:#020617;color:#d1d5db;padding:16px;border-radius:14px;white-space:pre-wrap;max-height:430px;overflow:auto;font-size:12px;border:1px solid #1f2937}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}th{background:#0f172a;font-weight:800}.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#3f1d1d;color:#fecaca;font-weight:800;font-size:12px}.pill{display:inline-block;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:900;text-transform:uppercase}.pill.ok{background:#064e3b;color:#bbf7d0}.pill.warn{background:#713f12;color:#fde68a}.pill.bad{background:#7f1d1d;color:#fecaca}',
      '.buttons{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.pdf-list{max-height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:12px;padding:10px;background:#0f172a}button{border:none;border-radius:10px;padding:10px 14px;font-size:13px;cursor:pointer;color:white;font-weight:800;margin-top:7px}a{color:#93c5fd;font-weight:800;text-decoration:none}.green{background:var(--green)}.red{background:var(--red)}.orange{background:var(--orange)}.blue{background:var(--blue)}.dark{background:#020617}.gray{background:var(--gray)}form{display:block;margin:0}.danger-note{color:#fecaca;font-size:13px;margin-top:8px}.bar{height:10px;background:#020617;border-radius:999px;overflow:hidden;border:1px solid #334155}.bar-fill{height:100%;border-radius:999px}.okbar{background:var(--green)}.warnbar{background:var(--orange)}.badbar{background:var(--red)}',
      '@media(max-width:1100px){.mini-grid,.metric-grid{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}}@media(max-width:700px){body{padding:16px}.mini-grid,.metric-grid{grid-template-columns:1fr}.hero-card{align-items:flex-start;flex-direction:column}}',
    '</style></head><body><div class="wrap">',
      '<div class="tabs">',
        '<button class="tab-button active" data-tab="overview" onclick="showTab(\'overview\')">Uebersicht</button>',
        '<button class="tab-button" data-tab="docmorris" onclick="showTab(\'docmorris\')">DocMorris</button>',
        '<button class="tab-button" data-tab="mirakl" onclick="showTab(\'mirakl\')">Mirakl</button>',
        '<button class="tab-button" data-tab="woocommerce" onclick="showTab(\'woocommerce\')">WooCommerce</button>',
        '<button class="tab-button" data-tab="cdiscount" onclick="showTab(\'cdiscount\')">Cdiscount</button>',
        '<button class="tab-button" data-tab="system" onclick="showTab(\'system\')">System</button>',
      '</div>',
      renderActionResult(actionResult),
      '<div id="overview" class="tab active">', renderStatusHeader(s, health, color), renderProcessCards(dynamic.processes || []), renderDiskCards(dynamic.disks || []), renderLogsCard(logs), '</div>',
      '<div id="docmorris" class="tab"><div class="grid">', renderErrorsCard(errors), renderSkipsCard(skips), '</div>', renderInvoicesCard(invoices), renderPdfArchiveCard('DHL Labels (Archiv)', 'Maximal 50 Labels.', labels, '/labels', 'Keine Labels vorhanden.'), renderPdfArchiveCard('Lieferscheine (Archiv)', 'Maximal 50 Lieferscheine.', slips, '/slips', 'Keine Lieferscheine vorhanden.'), renderPdfArchiveCard('Retourenlabels (Archiv)', 'Maximal 50 Retourenlabels.', returns, '/returns', 'Keine Retourenlabels vorhanden.'), '</div>',
      '<div id="mirakl" class="tab">', renderMiraklCard(miraklStats), '</div>',
      '<div id="woocommerce" class="tab">', renderWooCommerceCard(), '</div>',
      '<div id="cdiscount" class="tab">', renderPlaceholderCard('Cdiscount', 'Vorbereiteter Bereich fuer Cdiscount Operations.', ['Offer-Status', 'Preis-/Bestandsupdates', 'Upload- und Fehlerlogs']), '</div>',
      '<div id="system" class="tab">',
  renderControlCard(),
  renderCarrierCard(),
  renderGitCard(),
  renderHelpCard(),
'</div>',
    '<script>',
      'function showTab(id){var tab=document.getElementById(id);var button=document.querySelector("[data-tab=\\\""+id+"\\\"]");if(!tab||!button)return;document.querySelectorAll(".tab").forEach(function(el){el.classList.remove("active")});document.querySelectorAll(".tab-button").forEach(function(el){el.classList.remove("active")});tab.classList.add("active");button.classList.add("active");localStorage.setItem("activeDashboardTab",id);if(id==="woocommerce")loadWooCommerce();}',
      'document.addEventListener("DOMContentLoaded",function(){showTab(localStorage.getItem("activeDashboardTab")||"overview")});',
      'function html(value){return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\\\'/g,"&#039;")}',
      'async function loadWooCommerce(){try{var res=await fetch("/api/woocommerce/orders");var data=await res.json();var loading=document.getElementById("woo-loading");var table=document.getElementById("woo-table");var body=document.getElementById("woo-body");if(!data.ok){loading.innerText="Fehler beim Laden: "+JSON.stringify(data.error||"Unbekannt");return}loading.style.display="none";table.style.display="block";if(!data.orders||data.orders.length===0){body.innerHTML="<tr><td colspan=\\"8\\">Keine WooCommerce-Bestellungen gefunden.</td></tr>";return}body.innerHTML=data.orders.map(function(p){var bg="";if(!p.trackingNumber||p.trackingNumber==="-")bg="#3f1d1d";else if(p.status==="processing"||p.status==="pending")bg="#4a330d";else bg="#123524";var trackingCell=p.trackingUrl?("<a href=\\""+html(p.trackingUrl)+"\\" target=\\"_blank\\">Tracking</a>"):"-";return "<tr style=\\"background:"+bg+"\\"><td>"+html(p.orderNumber)+"</td><td>"+html(p.name)+"</td><td>"+html(p.city)+" ("+html(p.country)+")</td><td>"+html(p.status)+"</td><td>"+html(p.carrier)+"</td><td>"+trackingCell+"</td><td>"+html(new Date(p.createdAt).toLocaleString("de-DE"))+"</td><td><form method=\\"POST\\" action=\\"/control/reprint-invoice\\"><input type=\\"hidden\\" name=\\"order\\" value=\\""+html(p.orderNumber)+"\\"><button class=\\"blue\\" type=\\"submit\\">Rechnung</button></form><form method=\\"POST\\" action=\\"/control/reprint-packing-slip\\"><input type=\\"hidden\\" name=\\"order\\" value=\\""+html(p.orderNumber)+"\\"><button class=\\"orange\\" type=\\"submit\\">Lieferschein</button></form><form method=\\"POST\\" action=\\"/control/create-return-label\\"><input type=\\"hidden\\" name=\\"order\\" value=\\""+html(p.orderNumber)+"\\"><button class=\\"red\\" type=\\"submit\\">Retoure</button></form><form method=\\"POST\\" action=\\"/control/fulfill-woo\\"><input type=\\"hidden\\" name=\\"orderId\\" value=\\""+html(p.id)+"\\"><input type=\\"hidden\\" name=\\"tracking\\" value=\\""+html(p.trackingNumber)+"\\"><input type=\\"hidden\\" name=\\"url\\" value=\\""+html(p.trackingUrl)+"\\"><button class=\\"green\\" type=\\"submit\\">Fulfill</button></form></td></tr>"}).join("")}catch(err){var loading=document.getElementById("woo-loading");if(loading)loading.innerText="Fehler beim Laden: "+err.message}}',
    '</script></body></html>'
  ].join('');
}

app.get('/', async (req, res) => res.send(await renderPageAsync(null)));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard V3 laeuft auf http://0.0.0.0:' + PORT);
});
