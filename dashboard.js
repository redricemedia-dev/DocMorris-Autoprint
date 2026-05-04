require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();

const PORT = Number(process.env.DASHBOARD_PORT || 3001);
const STATUS_FILE = process.env.STATUS_FILE || 'C:\\docmorris-auto\\status.json';

const INVOICE_DIR = process.env.INVOICE_DIR || 'C:\\DocMorris-Rechnungen';
const PRINT_ARCHIVE_DIR = process.env.PRINT_ARCHIVE_DIR || 'C:\\DocMorris-Druckarchiv';
const LABEL_ARCHIVE_DIR = path.join(PRINT_ARCHIVE_DIR, 'labels');
const SLIP_ARCHIVE_DIR = path.join(PRINT_ARCHIVE_DIR, 'lieferscheine');

const LOG_DIR = process.env.LOG_DIR || 'C:\\DocMorris-Logs';
const ERROR_DIR = process.env.ERROR_DIR || 'C:\\DocMorris-Fehler';
const SKIP_FILE = process.env.SKIP_FILE || path.join(ERROR_DIR, 'skip-orders.json');

const APP_DIR = process.env.APP_DIR || 'C:\\docmorris-auto';
const AUTOPRINT_PROCESS = process.env.AUTOPRINT_PROCESS || 'autoprint';
const DASHBOARD_PROCESS = process.env.DASHBOARD_PROCESS || 'dashboard';

const APP_VERSION = process.env.APP_VERSION || '1.0.0';
const APP_BUILD = process.env.APP_BUILD || 'dev';

const RETURN_ARCHIVE_DIR = process.env.RETURN_ARCHIVE_DIR || path.join(PRINT_ARCHIVE_DIR, 'retouren');

app.use(express.urlencoded({ extended: true }));

function esc(value) {
  return String(value ?? '')
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
  return readJson(SKIP_FILE, []);
}

function readLogs() {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `autoprint_${today}.log`);

  if (!fs.existsSync(file)) return [];

  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-100);
}

function getHealthStats() {
  const logs = readLogs();
  const status = readStatus();

  const successToday = logs.filter(line => line.includes('✅ Fertig:')).length;
  const errorsToday = logs.filter(line =>
    line.includes('❌ Fehler') ||
    line.includes('[ERROR]') ||
    line.toLowerCase().includes('fehler')
  ).length;

  const skipped = readSkips().length;

  const lastErrorActive = Boolean(status.lastError);

  return {
    successToday,
    errorsToday,
    skipped,
    lastErrorActive
  };
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

function getOrderFromInvoiceFile(file) {
  const parts = String(file || '').split('_');
  return parts[2] || '';
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

  return `
    <div class="card">
      <h2>Letzte Aktion</h2>
      <pre>${esc(
        `Befehl: ${result.command}\n\nErfolg: ${result.ok}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n\nERROR:\n${result.error}`
      )}</pre>
    </div>
  `;
}

app.post('/control/start', async (req, res) => {
  const result = await runCommand(`pm2 start autopilot.js --name ${AUTOPRINT_PROCESS}`);
  res.send(renderPage(result));
});

app.post('/control/stop', async (req, res) => {
  const result = await runCommand(`pm2 stop ${AUTOPRINT_PROCESS}`);
  res.send(renderPage(result));
});

app.post('/control/restart', async (req, res) => {
  const result = await runCommand(`pm2 restart ${AUTOPRINT_PROCESS} --update-env`);
  res.send(renderPage(result));
});

app.post('/control/restart-dashboard', (req, res) => {
  res.send(renderPage({
    command: `pm2 restart ${DASHBOARD_PROCESS} --update-env`,
    ok: true,
    stdout: 'Dashboard wird neu gestartet...',
    stderr: '',
    error: ''
  }));

  setTimeout(() => {
    exec(`pm2 restart ${DASHBOARD_PROCESS} --update-env`, { cwd: APP_DIR });
  }, 500);
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
  const result = await runCommand('git log --oneline -5');
  res.send(renderPage(result));
});

app.post('/control/git-backup', async (req, res) => {
  const result = await runCommand('git add . && git commit -m "Dashboard backup" && git push');
  res.send(renderPage(result));
});


app.post('/control/retry-order', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({
      command: 'retry order',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Keine Bestellnummer übergeben.'
    }));
  }

  const skips = readSkips().filter(x => x !== order);
  writeJson(SKIP_FILE, skips);

  const result = await runCommand(`pm2 restart ${AUTOPRINT_PROCESS} --update-env`);

  res.send(renderPage({
    command: `retry ${order}`,
    ok: result.ok,
    stdout: `Bestellung ${order} wurde freigegeben.\n\n${result.stdout}`,
    stderr: result.stderr,
    error: result.error
  }));
});



app.post('/control/git-rollback', async (req, res) => {
  const commit = String(req.body.commit || '').trim();

  if (!commit) {
    return res.send(renderPage({
      command: 'git rollback',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Kein Commit angegeben.'
    }));
  }

  if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
    return res.send(renderPage({
      command: 'git rollback',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Ungültiger Commit-Hash.'
    }));
  }

  const result = await runCommand(`git reset --hard ${commit} && pm2 restart all --update-env`);
  res.send(renderPage(result));
});


app.post('/control/reprint-invoice', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({
      command: 'node reprint-invoice.js',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Keine Bestellnummer übergeben.'
    }));
  }

  const result = await runCommand(`node reprint-invoice.js ${order}`);
  res.send(renderPage(result));
});



app.post('/control/create-return-label', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({
      command: 'create return label',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Keine Bestellnummer übergeben.'
    }));
  }

  const result = await runCommand(`node create-return-label.js ${order}`);

  res.send(renderPage({
    command: `create return label ${order}`,
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  }));
});

  

app.post('/control/reprint-packing-slip', async (req, res) => {
  const order = String(req.body.order || '').trim();

  if (!order) {
    return res.send(renderPage({
      command: 'node reprint-packing-slip.js',
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Keine Bestellnummer übergeben.'
    }));
  }

  const result = await runCommand(`node reprint-packing-slip.js ${order}`);
  res.send(renderPage(result));
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

app.post('/control/remove-skip', (req, res) => {
  const order = String(req.body.order || '');
  const skips = readSkips().filter(x => x !== order);
  writeJson(SKIP_FILE, skips);

  res.send(renderPage({
    command: `remove skip ${order}`,
    ok: true,
    stdout: `Bestellung ${order} wurde aus der Skip-Liste entfernt.`,
    stderr: '',
    error: ''
  }));
});

app.use('/invoices', express.static(INVOICE_DIR));
app.use('/labels', express.static(LABEL_ARCHIVE_DIR));
app.use('/slips', express.static(SLIP_ARCHIVE_DIR));
app.use('/returns', express.static(RETURN_ARCHIVE_DIR));

app.get('/api/status', (req, res) => res.json(readStatus()));
app.get('/api/errors', (req, res) => res.json({ errors: readErrors() }));
app.get('/api/skips', (req, res) => res.json({ skips: readSkips() }));
app.get('/api/logs', (req, res) => res.json({ logs: readLogs() }));

function renderPage(actionResult = null) {
  const s = readStatus();
  const errors = readErrors();
  const skips = readSkips();
  const logs = readLogs();
  const invoices = readPdfList(INVOICE_DIR);
  const labels = readPdfList(LABEL_ARCHIVE_DIR);
  const slips = readPdfList(SLIP_ARCHIVE_DIR);
  const returns = readPdfList(RETURN_ARCHIVE_DIR);
  const health = getHealthStats();

  const color =
    s.status === 'OK' ? '#16a34a' :
    s.status === 'FEHLER' ? '#dc2626' :
    '#ca8a04';

  return `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="15">
  <title>DocMorris AutoPrint</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f6f7f9;
      padding: 40px;
      color: #111827;
    }

    .wrap {
      max-width: 1600px;
      margin: 0 auto;
    }

    .card {
      background: white;
      border-radius: 16px;
      padding: 28px;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,.08);
    }

    .status {
      font-size: 28px;
      font-weight: bold;
      color: ${color};
    }

    .grid {
     display: grid;
     grid-template-columns: repeat(2, minmax(0, 1fr));
     gap: 18px;
    }

     .grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

    .row {
      margin: 14px 0;
      font-size: 17px;
    }

    .label {
      color: #555;
      width: 180px;
      display: inline-block;
    }

    .small {
      color: #6b7280;
      font-size: 13px;
    }

    pre {
      background: #111827;
      color: #f9fafb;
      padding: 16px;
      border-radius: 12px;
      white-space: pre-wrap;
      max-height: 380px;
      overflow: auto;
      font-size: 12px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }

    th, td {
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: top;
      font-size: 14px;
    }

    th {
      background: #f3f4f6;
      font-weight: bold;
    }

    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      background: #fee2e2;
      color: #991b1b;
      font-weight: bold;
      font-size: 12px;
    }

    .empty {
      color: #16a34a;
      font-weight: bold;
    }

    .buttons {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 18px;
    }

    .pdf-list {
      max-height: 420px;
      overflow-y: auto;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 10px;
      background: #fafafa;
    }

    button {
      border: none;
      border-radius: 10px;
      padding: 11px 16px;
      font-size: 14px;
      cursor: pointer;
      color: white;
      font-weight: bold;
      margin-top: 7px;
    }

    a {
      color: #2563eb;
      font-weight: bold;
      text-decoration: none;
    }

    .green { background: #16a34a; }
    .red { background: #dc2626; }
    .orange { background: #d97706; }
    .blue { background: #2563eb; }
    .dark { background: #111827; }
    .gray { background: #4b5563; }

    form {
      display: block;
      margin: 0;
    }

    .danger-note {
      color: #991b1b;
      font-size: 13px;
      margin-top: 8px;
    }

    @media (max-width: 850px) {
      .grid {
        grid-template-columns: 1fr;
      }

      body {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">

    <div class="card">
      <h1>DocMorris AutoPrint</h1>
      <p class="small">Version ${esc(APP_VERSION)} · Build ${esc(APP_BUILD)}</p>
      <div class="status">● ${esc(s.status)}</div>

<div class="card">
  <h2>System Health</h2>

  <div class="grid">
    <div>
      <div class="row"><span class="label">Autopilot:</span>${s.status === 'OK' ? '🟢 Aktiv' : '🔴 Prüfen'}</div>
      <div class="row"><span class="label">Letzter Scan:</span>${esc(s.lastScan || '-')}</div>
      <div class="row"><span class="label">Nächster Scan:</span>${esc(s.nextScan || '-')}</div>
      <div class="row"><span class="label">Letzter Druck:</span>${esc(s.lastPrint || '-')}</div>
      <div class="row"><span class="label">Letzte Bestellung:</span>${esc(s.lastOrder || '-')}</div>
    </div>

    <div>
      <div class="row"><span class="label">Heute fertig:</span>${health.successToday}</div>
      <div class="row"><span class="label">Fehler heute:</span>${health.errorsToday}</div>
      <div class="row"><span class="label">Skip-Liste:</span>${health.skipped}</div>
      <div class="row"><span class="label">Fehlerstatus:</span>${health.lastErrorActive ? '🔴 Fehler vorhanden' : '🟢 Kein aktiver Fehler'}</div>
    </div>
  </div>
</div>

     

      <p class="small">Aktualisiert automatisch alle 15 Sekunden · http://127.0.0.1:${PORT}</p>
    </div>

    <div class="card">
      <h2>Steuerung</h2>
      <div class="buttons">
        <form method="POST" action="/control/start">
          <button class="green" type="submit">Autoprint starten</button>
        </form>

        <form method="POST" action="/control/stop">
          <button class="red" type="submit">Autoprint stoppen</button>
        </form>

        <form method="POST" action="/control/restart">
          <button class="orange" type="submit">Autoprint neu starten</button>
        </form>

        <form method="POST" action="/control/restart-dashboard">
          <button class="blue" type="submit">Dashboard neu starten</button>
        </form>

        <form method="POST" action="/control/restart-all">
          <button class="dark" type="submit">Alles neu starten</button>
        </form>

        <form method="POST" action="/control/pm2-list">
          <button class="gray" type="submit">PM2 Status anzeigen</button>
        </form>

        <form method="POST" action="/control/clear-skips">
          <button class="red" type="submit">Skip-Liste leeren</button>
        </form>
      </div>
      <div class="danger-note">
        Hinweis: „Skip-Liste leeren“ gibt alle übersprungenen Bestellungen wieder frei.
      </div>
    </div>

    ${renderActionResult(actionResult)}

    <div class="grid">
      <div class="card">
        <h2>Fehler</h2>
        ${
          errors.length === 0
            ? `<p class="empty">Keine Fehler vorhanden.</p>`
            : `
              <table>
                <thead>
                  <tr>
                    <th>Zeit</th>
                    <th>Bestellung</th>
                    <th>Fehler</th>
                  </tr>
                </thead>
                <tbody>
                  ${errors.map(e => `
                    <tr>
                      <td>${esc(e.time)}</td>
                      <td><span class="badge">${esc(e.order)}</span></td>
                      <td>
  ${esc(e.message)}

  <form method="POST" action="/control/retry-order">
    <input type="hidden" name="order" value="${esc(e.order)}">
    <button class="orange" type="submit">Erneut versuchen</button>
  </form>
</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `
        }
      </div>

      <div class="card">
        <h2>Übersprungene Bestellungen</h2>
        ${
          skips.length === 0
            ? `<p class="empty">Keine übersprungenen Bestellungen.</p>`
            : `
              <table>
                <thead>
                  <tr>
                    <th>Bestellung</th>
                    <th>Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  ${skips.map(order => `
                    <tr>
                      <td><span class="badge">${esc(order)}</span></td>
                      <td>
                        <form method="POST" action="/control/remove-skip">
                          <input type="hidden" name="order" value="${esc(order)}">
                          <button class="orange" type="submit">Freigeben</button>
                        </form>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `
        }
      </div>
    </div>

    <div class="card">
      <h2>Letzte Rechnungen</h2>
      <p class="small">Es werden maximal die letzten 50 Rechnungen angezeigt.</p>

      ${
        invoices.length === 0
          ? `<p class="empty">Noch keine Rechnungen vorhanden.</p>`
          : `
            <div class="pdf-list">
              <table>
                <thead>
                  <tr>
                    <th>Datei</th>
                    <th>Geändert</th>
                    <th>Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  ${invoices.map(inv => {
                    const order = getOrderFromInvoiceFile(inv.file);

                    return `
                      <tr>
                        <td>${esc(inv.file)}</td>
                        <td>${esc(new Date(inv.created).toLocaleString('de-DE'))}</td>
                        <td>
                          <a href="/invoices/${encodeURIComponent(inv.file)}" target="_blank">PDF öffnen</a>

                          <form method="POST" action="/control/reprint-invoice">
                            <input type="hidden" name="order" value="${esc(order)}">
                            <button class="blue" type="submit">Rechnung neu erzeugen</button>
                          </form>

                          <form method="POST" action="/control/reprint-packing-slip">
                            <input type="hidden" name="order" value="${esc(order)}">
                            <button class="orange" type="submit">Lieferschein drucken</button>
                          </form>

<form method="POST" action="/control/create-return-label">
  <input type="hidden" name="order" value="${esc(order)}">
  <button class="red" type="submit">Retourenlabel erstellen</button>
</form>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `
      }
    </div>

    <div class="card">
      <h2>DHL Labels (Archiv)</h2>
      <p class="small">Es werden maximal die letzten 50 Labels angezeigt.</p>

      ${
        labels.length === 0
          ? `<p class="empty">Keine Labels vorhanden.</p>`
          : `
            <div class="pdf-list">
              <table>
                <thead>
                  <tr>
                    <th>Datei</th>
                    <th>Geändert</th>
                    <th>Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  ${labels.map(label => `
                    <tr>
                      <td>${esc(label.file)}</td>
                      <td>${esc(new Date(label.created).toLocaleString('de-DE'))}</td>
                      <td>
                        <a href="/labels/${encodeURIComponent(label.file)}" target="_blank">Öffnen</a>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `
      }
    </div>

    <div class="card">
      <h2>Lieferscheine (Archiv)</h2>
      <p class="small">Es werden maximal die letzten 50 Lieferscheine angezeigt.</p>

      ${
        slips.length === 0
          ? `<p class="empty">Keine Lieferscheine vorhanden.</p>`
          : `
            <div class="pdf-list">
              <table>
                <thead>
                  <tr>
                    <th>Datei</th>
                    <th>Geändert</th>
                    <th>Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  ${slips.map(slip => `
                    <tr>
                      <td>${esc(slip.file)}</td>
                      <td>${esc(new Date(slip.created).toLocaleString('de-DE'))}</td>
                      <td>
                        <a href="/slips/${encodeURIComponent(slip.file)}" target="_blank">Öffnen</a>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `
      }
    </div>
<div class="card">
  <h2>Retourenlabels (Archiv)</h2>
  <p class="small">Es werden maximal die letzten 50 Retourenlabels angezeigt.</p>

  ${
    returns.length === 0
      ? `<p class="empty">Keine Retourenlabels vorhanden.</p>`
      : `
        <div class="pdf-list">
          <table>
            <thead>
              <tr>
                <th>Datei</th>
                <th>Geändert</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody>
              ${returns.map(ret => `
                <tr>
                  <td>${esc(ret.file)}</td>
                  <td>${esc(new Date(ret.created).toLocaleString('de-DE'))}</td>
                  <td>
                    <a href="/returns/${encodeURIComponent(ret.file)}" target="_blank">Öffnen</a>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `
  }
</div>
    <div class="card">
      <h2>Live-Log heute</h2>
      <pre>${esc(logs.join('\n') || 'Noch keine Logs vorhanden.')}</pre>
    </div>
<div class="card">
  <h2>System-Backup / GitHub</h2>
  <div class="buttons">
    <form method="POST" action="/control/git-status">
      <button class="gray" type="submit">Git Status</button>
    </form>

    <form method="POST" action="/control/git-log">
      <button class="blue" type="submit">Letzte Versionen</button>
    </form>

    <form method="POST" action="/control/git-backup">
      <button class="green" type="submit">Änderungen sichern + pushen</button>
    </form>
  </div>

  <p class="small">
    Wichtig: Nur klicken, wenn das System gerade stabil läuft.
  </p>
</div>


<div class="card">
  <h2>Rollback / Wiederherstellung</h2>

  <p class="small">
    Nur nutzen, wenn eine Änderung das System beschädigt hat. Vorher über „Letzte Versionen“ den gewünschten Commit kopieren.
  </p>

  <form method="POST" action="/control/git-rollback">
    <input
      name="commit"
      placeholder="Commit-Hash einfügen, z. B. a1b2c3d"
      style="padding:11px; border:1px solid #d1d5db; border-radius:10px; min-width:320px;"
      required
    >
    <button class="red" type="submit">Rollback ausführen</button>
  </form>
</div>



    <div class="card">
      <h2>Hilfe / Notfallablauf</h2>

      <div class="row"><span class="label">Druckerproblem:</span>PDFs prüfen unter C:\\DocMorris-Druckarchiv</div>
      <div class="row"><span class="label">Label fehlt:</span>Ordner C:\\DocMorris-Druckarchiv\\labels prüfen</div>
      <div class="row"><span class="label">Lieferschein fehlt:</span>Ordner C:\\DocMorris-Druckarchiv\\lieferscheine prüfen</div>
      <div class="row"><span class="label">Bestellung hängt:</span>Dashboard → Skip-Liste → Freigeben</div>
      <div class="row"><span class="label">System hängt:</span>Button „Autoprint neu starten“ nutzen</div>
      <div class="row"><span class="label">Letzter Ausweg:</span>PM2 Status anzeigen und Fehler lesen</div>

      <p class="small">
        Grundregel: DHL-Label und Lieferschein werden vor dem Druck lokal archiviert. Bei Druckproblemen zuerst das Druckarchiv prüfen.
      </p>
    </div>

  </div>
</body>
</html>
  `;
}

app.get('/', (req, res) => {
  res.send(renderPage());
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard läuft auf http://0.0.0.0:${PORT}`);
});