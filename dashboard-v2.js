require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { getWooCommerceOrders, fulfillWooOrder, getSendcloudParcels } = require('./marketplace-woocommerce');

const app = express();

const PORT = 3002;
const STATUS_FILE = process.env.STATUS_FILE || 'C:\\docmorris-auto\\status.json';

const INVOICE_DIR = process.env.INVOICE_DIR || 'C:\\DocMorris-Rechnungen';
const PRINT_ARCHIVE_DIR = process.env.PRINT_ARCHIVE_DIR || 'C:\\DocMorris-Druckarchiv';
const LABEL_ARCHIVE_DIR = path.join(PRINT_ARCHIVE_DIR, 'labels');
const SLIP_ARCHIVE_DIR = path.join(PRINT_ARCHIVE_DIR, 'lieferscheine');
const RETURN_ARCHIVE_DIR = process.env.RETURN_ARCHIVE_DIR || path.join(PRINT_ARCHIVE_DIR, 'retouren');

const LOG_DIR = process.env.LOG_DIR || 'C:\\DocMorris-Logs';
const ERROR_DIR = process.env.ERROR_DIR || 'C:\\DocMorris-Fehler';
const SKIP_FILE = process.env.SKIP_FILE || path.join(ERROR_DIR, 'skip-orders.json');

const APP_DIR = process.env.APP_DIR || 'C:\\docmorris-auto';
const AUTOPRINT_PROCESS = process.env.AUTOPRINT_PROCESS || 'autoprint';
const DASHBOARD_PROCESS = process.env.DASHBOARD_PROCESS || 'dashboard';

const APP_VERSION = process.env.APP_VERSION || '1.0.0';
const APP_BUILD = process.env.APP_BUILD || 'v2';

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

  if (!fs.existsSync(file)) return [];

  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-120);
}

function readPdfList(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(file => file.toLowerCase().endsWith('.pdf'))
    .map(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      return {
        file,
        created: stat.mtime
      };
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

function getOrderFromInvoiceFile(file) {
  const name = String(file || '').replace(/\.pdf$/i, '');
  const parts = name.split('_');

  if (parts.length >= 3) return parts[2];
  if (parts.length >= 2) return parts[1];

  return name;
}

function runCommand(command) {
  return new Promise(resolve => {
    exec(command, { cwd: APP_DIR }, (error, stdout, stderr) => {
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
  return renderPage({
    command: 'GET ' + route,
    ok: false,
    stdout: '',
    stderr: '',
    error: 'Diese Aktion muss ueber den Button im Dashboard ausgefuehrt werden.'
  });
}

app.post('/control/start', async (req, res) => {
  const result = await runCommand('pm2 start autopilot.js --name ' + AUTOPRINT_PROCESS);
  res.send(renderPage(result));
});

app.post('/control/stop', async (req, res) => {
  const result = await runCommand('pm2 stop ' + AUTOPRINT_PROCESS);
  res.send(renderPage(result));
});

app.post('/control/restart', async (req, res) => {
  const result = await runCommand('pm2 restart ' + AUTOPRINT_PROCESS + ' --update-env');
  res.send(renderPage(result));
});

app.post('/control/restart-dashboard', async (req, res) => {
  const result = await runCommand('pm2 restart ' + DASHBOARD_PROCESS + ' --update-env');
  res.send(renderPage(result));
});

app.post('/control/restart-all', async (req, res) => {
  const result = await runCommand('pm2 restart all --update-env');
  res.send(renderPage(result));
});

app.post('/control/pm2-list', async (req, res) => {
  const result = await runCommand('pm2 list');
  res.send(renderPage(result));
});

app.post('/control/git-status', async (req, res) => {
  const result = await runCommand('git status');
  res.send(renderPage(result));
});

app.post('/control/git-log', async (req, res) => {
  const result = await runCommand('git log --oneline -8');
  res.send(renderPage(result));
});

app.post('/control/git-backup', async (req, res) => {
  const result = await runCommand('git add . && git commit -m "manual dashboard backup" && git push');
  res.send(renderPage(result));
});

app.post('/control/retry-order', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({ command: 'retry order', ok: false, error: 'Keine Bestellnummer.' }));
  }

  const skips = readSkips().filter(x => x !== order);
  writeJson(SKIP_FILE, skips);

  const result = await runCommand('pm2 restart ' + AUTOPRINT_PROCESS + ' --update-env');
  res.send(renderPage({
    command: 'retry ' + order,
    ok: result.ok,
    stdout: 'Bestellung wurde freigegeben: ' + order + '\n\n' + result.stdout,
    stderr: result.stderr,
    error: result.error
  }));
});

app.post('/control/remove-skip', (req, res) => {
  const order = String(req.body.order || '').trim();
  const skips = readSkips().filter(x => x !== order);
  writeJson(SKIP_FILE, skips);

  res.send(renderPage({
    command: 'remove skip ' + order,
    ok: true,
    stdout: 'Bestellung wurde aus der Skip-Liste entfernt: ' + order,
    stderr: '',
    error: ''
  }));
});

app.post('/control/clear-skips', (req, res) => {
  writeJson(SKIP_FILE, []);
  res.send(renderPage({
    command: 'clear skip-orders.json',
    ok: true,
    stdout: 'Skip-Liste wurde geleert.',
    stderr: '',
    error: ''
  }));
});

app.post('/control/reprint-invoice', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({ command: 'node reprint-invoice.js', ok: false, error: 'Keine Bestellnummer.' }));
  }

  const result = await runCommand('node reprint-invoice.js ' + order);
  res.send(renderPage(result));
});

app.post('/control/reprint-packing-slip', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({ command: 'node reprint-packing-slip.js', ok: false, error: 'Keine Bestellnummer.' }));
  }

  const result = await runCommand('node reprint-packing-slip.js ' + order);
  res.send(renderPage(result));
});

app.post('/control/create-return-label', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({ command: 'node create-return-label.js', ok: false, error: 'Keine Bestellnummer.' }));
  }

  const result = await runCommand('node create-return-label.js ' + order);
  res.send(renderPage(result));
});

app.post('/control/fulfill-woo', async (req, res) => {
  const orderId = String(req.body.orderId || '').trim();
  const tracking = String(req.body.tracking || '').trim();
  const trackingUrl = String(req.body.url || '').trim();

  if (!orderId || !tracking || tracking === '-') {
    return res.send(renderPage({
      command: 'fulfill woo',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Keine gueltige Trackingnummer vorhanden.'
    }));
  }

  try {
    await fulfillWooOrder(orderId, tracking, trackingUrl);

    res.send(renderPage({
      command: 'fulfill woo ' + orderId,
      ok: true,
      stdout: 'WooCommerce-Bestellung wurde auf completed gesetzt.',
      stderr: '',
      error: ''
    }));
  } catch (err) {
    res.send(renderPage({
      command: 'fulfill woo',
      ok: false,
      stdout: '',
      stderr: '',
      error: JSON.stringify((err.response && err.response.data) || err.message, null, 2)
    }));
  }
});

[
  '/control/start',
  '/control/stop',
  '/control/restart',
  '/control/restart-dashboard',
  '/control/restart-all',
  '/control/pm2-list',
  '/control/git-status',
  '/control/git-log',
  '/control/git-backup',
  '/control/retry-order',
  '/control/remove-skip',
  '/control/clear-skips',
  '/control/reprint-invoice',
  '/control/reprint-packing-slip',
  '/control/create-return-label',
  '/control/fulfill-woo'
].forEach(route => {
  app.get(route, (req, res) => res.send(renderPostOnlyError(route)));
});

app.get('/api/woocommerce/orders', async (req, res) => {
  try {
    const orders = await getWooCommerceOrders(20);
    res.json({ ok: true, orders });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: (err.response && err.response.data) || err.message
    });
  }
});

app.use('/invoices', express.static(INVOICE_DIR));
app.use('/labels', express.static(LABEL_ARCHIVE_DIR));
app.use('/slips', express.static(SLIP_ARCHIVE_DIR));
app.use('/returns', express.static(RETURN_ARCHIVE_DIR));

app.get('/api/status', (req, res) => res.json(readStatus()));
app.get('/api/errors', (req, res) => res.json({ errors: readErrors() }));
app.get('/api/skips', (req, res) => res.json({ skips: readSkips() }));
app.get('/api/logs', (req, res) => res.json({ logs: readLogs() }));

function renderStatusHeader(s, health, color) {
  return [
    '<div class="card hero-card">',
      '<div>',
        '<h1>Fulfillment Dashboard V2</h1>',
        '<p class="small">Version ' + esc(APP_VERSION) + ' | Build ' + esc(APP_BUILD) + ' | Test-Port ' + PORT + '</p>',
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
        '<form method="POST" action="/control/start"><button class="green" type="submit">Autoprint starten</button></form>',
        '<form method="POST" action="/control/stop"><button class="red" type="submit">Autoprint stoppen</button></form>',
        '<form method="POST" action="/control/restart"><button class="orange" type="submit">Autoprint neu starten</button></form>',
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
  if (errors.length === 0) {
    return '<div class="card"><h2>Fehler</h2><p class="empty">Keine Fehler vorhanden.</p></div>';
  }

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
  if (skips.length === 0) {
    return '<div class="card"><h2>Uebersprungene Bestellungen</h2><p class="empty">Keine uebersprungenen Bestellungen.</p></div>';
  }

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
  if (invoices.length === 0) {
    return '<div class="card"><h2>Letzte Rechnungen</h2><p class="empty">Keine Rechnungen vorhanden.</p></div>';
  }

  const rows = invoices.map(inv => {
    const order = getOrderFromInvoiceFile(inv.file);

    return [
      '<tr>',
        '<td>' + esc(inv.file) + '</td>',
        '<td>' + esc(new Date(inv.created).toLocaleString('de-DE')) + '</td>',
        '<td>',
          '<a href="/invoices/' + encodeURIComponent(inv.file) + '" target="_blank">PDF oeffnen</a>',
          '<form method="POST" action="/control/reprint-invoice">',
            '<input type="hidden" name="order" value="' + esc(order) + '">',
            '<button class="blue" type="submit">Rechnung neu erzeugen</button>',
          '</form>',
          '<form method="POST" action="/control/reprint-packing-slip">',
            '<input type="hidden" name="order" value="' + esc(order) + '">',
            '<button class="orange" type="submit">Lieferschein drucken</button>',
          '</form>',
          '<form method="POST" action="/control/create-return-label">',
            '<input type="hidden" name="order" value="' + esc(order) + '">',
            '<button class="red" type="submit">Retourenlabel erstellen</button>',
          '</form>',
        '</td>',
      '</tr>'
    ].join('');
  }).join('');

  return '<div class="card"><h2>Letzte Rechnungen</h2><p class="small">Maximal 50 Rechnungen.</p><div class="pdf-list"><table><thead><tr><th>Datei</th><th>Geaendert</th><th>Aktion</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

function renderPdfArchiveCard(title, description, items, baseUrl, emptyText) {
  if (items.length === 0) {
    return '<div class="card"><h2>' + esc(title) + '</h2><p class="small">' + esc(description) + '</p><p class="empty">' + esc(emptyText) + '</p></div>';
  }

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

function renderHelpCard() {
  return [
    '<div class="card">',
      '<h2>Hilfe / Notfallablauf</h2>',
      '<div class="row"><span class="label">Druckerproblem:</span>C:\\DocMorris-Druckarchiv pruefen</div>',
      '<div class="row"><span class="label">Label fehlt:</span>labels-Ordner pruefen</div>',
      '<div class="row"><span class="label">Lieferschein fehlt:</span>lieferscheine-Ordner pruefen</div>',
      '<div class="row"><span class="label">Bestellung haengt:</span>Skip-Liste pruefen</div>',
    '</div>'
  ].join('');
}

function renderPlaceholderCard(title, subtitle, items) {
  items = items || [];
  return [
    '<div class="card">',
      '<h2>' + esc(title) + '</h2>',
      '<p class="small">' + esc(subtitle) + '</p>',
      items.length ? '<ul>' + items.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>' : '<p class="empty">Noch kein aktives Modul angebunden.</p>',
    '</div>'
  ].join('');
}

function renderWooCommerceCard() {
  return [
    '<div class="card">',
      '<h2>WooCommerce - Letzte Bestellungen</h2>',
      '<p class="small">Live-Daten aus WooCommerce, Tracking ergaenzt ueber Sendcloud.</p>',
      '<div id="woo-loading">Lade WooCommerce-Daten...</div>',
      '<div id="woo-table" style="display:none;">',
        '<table>',
          '<thead>',
            '<tr>',
              '<th>Bestellung</th>',
              '<th>Name</th>',
              '<th>Ort</th>',
              '<th>Status</th>',
              '<th>Carrier</th>',
              '<th>Tracking</th>',
              '<th>Datum</th>',
              '<th>Aktion</th>',
            '</tr>',
          '</thead>',
          '<tbody id="woo-body"></tbody>',
        '</table>',
      '</div>',
    '</div>'
  ].join('');
}

function renderPage(actionResult) {
  const s = readStatus();
  const errors = readErrors();
  const skips = readSkips();
  const logs = readLogs();
  const invoices = readPdfList(INVOICE_DIR);
  const labels = readPdfList(LABEL_ARCHIVE_DIR);
  const slips = readPdfList(SLIP_ARCHIVE_DIR);
  const returns = readPdfList(RETURN_ARCHIVE_DIR);
  const health = getHealthStats();

  const color = s.status === 'OK' ? '#16a34a' : s.status === 'FEHLER' ? '#dc2626' : '#ca8a04';

  return [
    '<!DOCTYPE html>',
    '<html lang="de">',
    '<head>',
      '<meta charset="UTF-8">',
      '<meta http-equiv="refresh" content="15">',
      '<title>Fulfillment Dashboard V2</title>',
      '<style>',
        'body{font-family:Arial,sans-serif;background:#f6f7f9;padding:40px;color:#111827;}',
        '.wrap{max-width:1600px;margin:0 auto;}',
        '.tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;position:sticky;top:0;z-index:10;background:#f6f7f9;padding:10px 0;}',
        '.tab{display:none;}',
        '.tab.active{display:block;}',
        '.tab-button{background:#111827;}',
        '.tab-button.active{background:#2563eb;}',
        '.card{background:white;border-radius:16px;padding:28px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,.08);}',
        '.hero-card{display:flex;justify-content:space-between;align-items:center;gap:20px;}',
        '.status{font-size:28px;font-weight:bold;white-space:nowrap;}',
        '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;}',
        '.row{margin:14px 0;font-size:17px;}',
        '.label{color:#555;width:180px;display:inline-block;}',
        '.small{color:#6b7280;font-size:13px;}',
        'pre{background:#111827;color:#f9fafb;padding:16px;border-radius:12px;white-space:pre-wrap;max-height:380px;overflow:auto;font-size:12px;}',
        'table{width:100%;border-collapse:collapse;margin-top:12px;}',
        'th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:14px;}',
        'th{background:#f3f4f6;font-weight:bold;}',
        '.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#fee2e2;color:#991b1b;font-weight:bold;font-size:12px;}',
        '.empty{color:#16a34a;font-weight:bold;}',
        '.buttons{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;}',
        '.pdf-list{max-height:420px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:12px;padding:10px;background:#fafafa;}',
        'button{border:none;border-radius:10px;padding:11px 16px;font-size:14px;cursor:pointer;color:white;font-weight:bold;margin-top:7px;}',
        'a{color:#2563eb;font-weight:bold;text-decoration:none;}',
        '.green{background:#16a34a;}',
        '.red{background:#dc2626;}',
        '.orange{background:#d97706;}',
        '.blue{background:#2563eb;}',
        '.dark{background:#111827;}',
        '.gray{background:#4b5563;}',
        'form{display:block;margin:0;}',
        '.danger-note{color:#991b1b;font-size:13px;margin-top:8px;}',
        '@media(max-width:850px){.grid{grid-template-columns:1fr;}.hero-card{align-items:flex-start;flex-direction:column;}body{padding:20px;}}',
      '</style>',
    '</head>',
    '<body>',
      '<div class="wrap">',
        '<div class="tabs">',
          '<button class="tab-button active" data-tab="overview" onclick="showTab(\'overview\')">Uebersicht</button>',
          '<button class="tab-button" data-tab="docmorris" onclick="showTab(\'docmorris\')">DocMorris</button>',
          '<button class="tab-button" data-tab="woocommerce" onclick="showTab(\'woocommerce\')">WooCommerce</button>',
          '<button class="tab-button" data-tab="cdiscount" onclick="showTab(\'cdiscount\')">Cdiscount</button>',
          '<button class="tab-button" data-tab="mirakl" onclick="showTab(\'mirakl\')">Mirakl</button>',
          '<button class="tab-button" data-tab="system" onclick="showTab(\'system\')">System</button>',
        '</div>',

        renderActionResult(actionResult),

        '<div id="overview" class="tab active">',
          renderStatusHeader(s, health, color),
          renderLogsCard(logs),
        '</div>',

        '<div id="docmorris" class="tab">',
          '<div class="grid">',
            renderErrorsCard(errors),
            renderSkipsCard(skips),
          '</div>',
          renderInvoicesCard(invoices),
          renderPdfArchiveCard('DHL Labels (Archiv)', 'Maximal 50 Labels.', labels, '/labels', 'Keine Labels vorhanden.'),
          renderPdfArchiveCard('Lieferscheine (Archiv)', 'Maximal 50 Lieferscheine.', slips, '/slips', 'Keine Lieferscheine vorhanden.'),
          renderPdfArchiveCard('Retourenlabels (Archiv)', 'Maximal 50 Retourenlabels.', returns, '/returns', 'Keine Retourenlabels vorhanden.'),
        '</div>',

        '<div id="woocommerce" class="tab">',
          renderWooCommerceCard(),
        '</div>',

        '<div id="cdiscount" class="tab">',
          renderPlaceholderCard('Cdiscount', 'Vorbereiteter Bereich fuer Cdiscount Operations.', [
            'Offer-Status',
            'Preis-/Bestandsupdates',
            'Upload- und Fehlerlogs'
          ]),
        '</div>',

        '<div id="mirakl" class="tab">',
          renderPlaceholderCard('Mirakl / ShopApotheke', 'Vorbereiteter Bereich fuer Mirakl- und ShopApotheke-Prozesse.', [
            'Versandstatus',
            'Tracking-Rueckmeldung',
            'Fehlerkontrolle'
          ]),
        '</div>',

        '<div id="system" class="tab">',
          renderControlCard(),
          renderGitCard(),
          renderHelpCard(),
        '</div>',

      '</div>',

      '<script>',
        'function showTab(id){',
          'var tab=document.getElementById(id);',
          'var button=document.querySelector("[data-tab=\\"" + id + "\\"]");',
          'if(!tab||!button){return;}',
          'document.querySelectorAll(".tab").forEach(function(el){el.classList.remove("active");});',
          'document.querySelectorAll(".tab-button").forEach(function(el){el.classList.remove("active");});',
          'tab.classList.add("active");',
          'button.classList.add("active");',
          'localStorage.setItem("activeDashboardTab",id);',
          'if(id==="woocommerce"){loadWooCommerce();}',
        '}',
        'document.addEventListener("DOMContentLoaded",function(){',
          'showTab(localStorage.getItem("activeDashboardTab")||"overview");',
        '});',
        'function html(value){',
          'return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\\\'/g,"&#039;");',
        '}',
        'async function loadWooCommerce(){',
          'try{',
            'var res=await fetch("/api/woocommerce/orders");',
            'var data=await res.json();',
            'var loading=document.getElementById("woo-loading");',
            'var table=document.getElementById("woo-table");',
            'var body=document.getElementById("woo-body");',
            'if(!data.ok){loading.innerText="Fehler beim Laden: "+JSON.stringify(data.error||"Unbekannt");return;}',
            'loading.style.display="none";',
            'table.style.display="block";',
            'if(!data.orders||data.orders.length===0){body.innerHTML="<tr><td colspan=\\"8\\">Keine WooCommerce-Bestellungen gefunden.</td></tr>";return;}',
            'body.innerHTML=data.orders.map(function(p){',
              'var bg="";',
              'if(!p.trackingNumber||p.trackingNumber==="-"){bg="#fee2e2";}',
              'else if(p.status==="processing"||p.status==="pending"){bg="#fef3c7";}',
              'else{bg="#dcfce7";}',
              'var trackingCell=p.trackingUrl?("<a href=\\""+html(p.trackingUrl)+"\\" target=\\"_blank\\">Tracking</a>"):"-";',
              'return "<tr style=\\"background:"+bg+"\\">"+',
                '"<td>"+html(p.orderNumber)+"</td>"+',
                '"<td>"+html(p.name)+"</td>"+',
                '"<td>"+html(p.city)+" ("+html(p.country)+")</td>"+',
                '"<td>"+html(p.status)+"</td>"+',
                '"<td>"+html(p.carrier)+"</td>"+',
                '"<td>"+trackingCell+"</td>"+',
                '"<td>"+html(new Date(p.createdAt).toLocaleString("de-DE"))+"</td>"+',
                '"<td>"+',
                  '"<form method=\\"POST\\" action=\\"/control/reprint-invoice\\">"+',
                    '"<input type=\\"hidden\\" name=\\"order\\" value=\\""+html(p.orderNumber)+"\\">"+',
                    '"<button class=\\"blue\\" type=\\"submit\\">Rechnung</button>"+',
                  '"</form>"+',
                  '"<form method=\\"POST\\" action=\\"/control/reprint-packing-slip\\">"+',
                    '"<input type=\\"hidden\\" name=\\"order\\" value=\\""+html(p.orderNumber)+"\\">"+',
                    '"<button class=\\"orange\\" type=\\"submit\\">Lieferschein</button>"+',
                  '"</form>"+',
                  '"<form method=\\"POST\\" action=\\"/control/create-return-label\\">"+',
                    '"<input type=\\"hidden\\" name=\\"order\\" value=\\""+html(p.orderNumber)+"\\">"+',
                    '"<button class=\\"red\\" type=\\"submit\\">Retoure</button>"+',
                  '"</form>"+',



                  '"<form method=\\"POST\\" action=\\"/control/fulfill-woo\\">"+',
                    '"<input type=\\"hidden\\" name=\\"orderId\\" value=\\""+html(p.id)+"\\">"+',



                    '"<input type=\\"hidden\\" name=\\"tracking\\" value=\\""+html(p.trackingNumber)+"\\">"+',
                    '"<input type=\\"hidden\\" name=\\"url\\" value=\\""+html(p.trackingUrl)+"\\">"+',
                    '"<button class=\\"green\\" type=\\"submit\\">Fulfill</button>"+',
                  '"</form>"+',
                '"</td>"+',
              '"</tr>";',
            '}).join("");',
          '}catch(err){',
            'var loading=document.getElementById("woo-loading");',
            'if(loading){loading.innerText="Fehler beim Laden: "+err.message;}',
          '}',
        '}',
      '</script>',
    '</body>',
    '</html>'
  ].join('');
}

app.get('/', (req, res) => {
  res.send(renderPage(null));
});

const axios = require('axios');

app.get('/api/mirakl/debug', async (req, res) => {
  try {
    const base = process.env.MIRAKL_BASE_URL;
    const key = process.env.MIRAKL_API_KEY;

    const r = await axios.get(base + '/api/orders', {
      headers: {
        'Authorization': key
      },
      params: {
        max: 10
      }
    });

    res.json({
      ok: true,
      count: r.data.orders ? r.data.orders.length : 0,
      sample: (r.data.orders || []).map(o => ({
        order_id: o.order_id,
        status: o.status,
        customer: o.customer?.firstname + ' ' + o.customer?.lastname,
        email: o.customer?.email,
        shipping_type: o.shipping_type,
        created: o.created_date
      }))
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.response?.data || err.message
    });
  }
});

app.get('/api/mirakl/tracking-debug', async (req, res) => {
  try {
    const base = process.env.MIRAKL_BASE_URL;
    const key = process.env.MIRAKL_API_KEY;

    const ordersRes = await axios.get(base + '/api/orders', {
      headers: { 'Authorization': key },
      params: { max: 20 }
    });

    const parcels = await getSendcloudParcels(200);

    const result = (ordersRes.data.orders || []).map(order => {
      const email = (order.customer?.email || '').toLowerCase();
      const name = (order.customer?.lastname || '').toLowerCase();

      const parcel = parcels.find(p => {
        const pEmail = String(p.email || p.to_email || '').toLowerCase();
        const pName = String(p.name || '').toLowerCase();

        return pEmail === email && pName.includes(name);
      });

      return {
        order_id: order.order_id,
        customer: order.customer?.firstname + ' ' + order.customer?.lastname,
        email,
        tracking: parcel ? parcel.tracking_number : null,
        carrier: parcel?.carrier?.code || null
      };
    });

    res.json({ ok: true, result });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.response?.data || err.message
    });
  }
});

app.get('/api/sendcloud/debug', async (req, res) => {
  try {
    const parcels = await getSendcloudParcels(200);

    res.json({
      ok: true,
      parcels: parcels.map(p => ({
        id: p.id,
order_number: p.order_number,
external_order_id: p.external_order_id,
external_reference: p.external_reference,
external_shipment_id: p.external_shipment_id,
reference: p.reference,
name: p.name,
email: p.email,
city: p.city,
postal_code: p.postal_code,
tracking_number: p.tracking_number,
tracking_url: p.tracking_url,
carrier: p.carrier,
status: p.status,
data: p.data,
parcel_items: p.parcel_items,
keys: Object.keys(p)
      }))
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.response?.data || err.message
    });
  }
});

Dann:

app.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard V2 laeuft auf http://0.0.0.0:' + PORT);
});
