require('dotenv').config();

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOP = process.env.SHOPIFY_SHOP;

const PORT = Number(process.env.DASHBOARD_PORT || 3001);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';

const STATUS_FILE = process.env.STATUS_FILE || 'C:\\docmorris-auto\\status.json';

const SCOPES = [
  'read_orders',
  'write_orders',
  'read_fulfillments',
  'write_fulfillments',
  'read_locations',
  'read_assigned_fulfillment_orders',
  'write_assigned_fulfillment_orders'
].join(',');

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return {
      status: 'UNBEKANNT',
      lastError: 'status.json konnte nicht gelesen werden'
    };
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function runCommand(command) {
  return new Promise((resolve) => {
    exec(command, { cwd: 'C:\\docmorris-auto' }, (error, stdout, stderr) => {
      resolve({
        command,
        success: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? error.message : ''
      });
    });
  });
}

function renderDashboard(status, actionResult = null) {
  const statusClass =
    status.status === 'OK'
      ? 'ok'
      : status.status === 'FEHLER'
        ? 'error'
        : 'unknown';

  return `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>DocMorris AutoPrint Dashboard</title>
  <meta http-equiv="refresh" content="30">
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      margin: 0;
      color: #1f2937;
    }

    .container {
      max-width: 1050px;
      margin: 40px auto;
      padding: 20px;
    }

    .header {
      background: #111827;
      color: white;
      padding: 26px;
      border-radius: 14px;
      margin-bottom: 20px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.12);
    }

    .header h1 {
      margin: 0;
      font-size: 28px;
    }

    .header p {
      margin: 8px 0 0;
      color: #d1d5db;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }

    .card {
      background: white;
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
    }

    .full {
      grid-column: 1 / -1;
    }

    .label {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 6px;
    }

    .value {
      font-size: 20px;
      font-weight: bold;
      word-break: break-word;
    }

    .ok { color: #059669; }
    .error { color: #dc2626; }
    .unknown { color: #d97706; }

    pre {
      background: #111827;
      color: #f9fafb;
      padding: 16px;
      border-radius: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 360px;
      overflow: auto;
    }

    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
    }

    button, a.button {
      border: none;
      border-radius: 8px;
      padding: 11px 16px;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      color: white;
      background: #111827;
    }

    button:hover, a.button:hover {
      opacity: 0.88;
    }

    .green { background: #059669; }
    .red { background: #dc2626; }
    .orange { background: #d97706; }
    .blue { background: #2563eb; }
    .dark { background: #111827; }

    form {
      display: inline;
    }

    .footer {
      margin-top: 20px;
      text-align: center;
      color: #6b7280;
      font-size: 13px;
    }

    @media (max-width: 750px) {
      .grid {
        grid-template-columns: 1fr;
      }

      .full {
        grid-column: auto;
      }
    }
  </style>
</head>
<body>
  <div class="container">

    <div class="header">
      <h1>DocMorris AutoPrint Dashboard</h1>
      <p>Lokales Monitoring & Steuerung für Shopify · Sendcloud · PrintNode</p>
    </div>

    <div class="grid">
      <div class="card">
        <div class="label">Systemstatus</div>
        <div class="value ${statusClass}">
          ${escapeHtml(status.status || 'UNBEKANNT')}
        </div>
      </div>

      <div class="card">
        <div class="label">Letzte Bestellung</div>
        <div class="value">${escapeHtml(status.lastOrder || '-')}</div>
      </div>

      <div class="card">
        <div class="label">Letzter Scan</div>
        <div class="value">${escapeHtml(status.lastScan || '-')}</div>
      </div>

      <div class="card">
        <div class="label">Nächster Scan</div>
        <div class="value">${escapeHtml(status.nextScan || '-')}</div>
      </div>

      <div class="card">
        <div class="label">Letzter Druck</div>
        <div class="value">${escapeHtml(status.lastPrint || '-')}</div>
      </div>

      <div class="card">
        <div class="label">Statusdatei</div>
        <div class="value">${escapeHtml(STATUS_FILE)}</div>
      </div>

      <div class="card full">
        <div class="label">Steuerung</div>

        <div class="buttons">
          <form method="POST" action="/control/start-autoprint">
            <button class="green" type="submit">Autoprint starten</button>
          </form>

          <form method="POST" action="/control/stop-autoprint">
            <button class="red" type="submit">Autoprint stoppen</button>
          </form>

          <form method="POST" action="/control/restart-autoprint">
            <button class="orange" type="submit">Autoprint neu starten</button>
          </form>

          <form method="POST" action="/control/restart-all">
            <button class="blue" type="submit">Alle Prozesse neu starten</button>
          </form>

          <form method="POST" action="/control/pm2-list">
            <button class="dark" type="submit">PM2 Status anzeigen</button>
          </form>

          <a class="button" href="/api/status" target="_blank">Status JSON</a>
          <a class="button" href="/auth">Shopify Auth</a>
        </div>
      </div>

      ${
        actionResult
          ? `
      <div class="card full">
        <div class="label">Letzte Aktion</div>
        <pre>${escapeHtml(
          `Befehl: ${actionResult.command}\n\nErfolg: ${actionResult.success}\n\nSTDOUT:\n${actionResult.stdout}\n\nSTDERR:\n${actionResult.stderr}\n\nERROR:\n${actionResult.error}`
        )}</pre>
      </div>
      `
          : ''
      }

      <div class="card full">
        <div class="label">Letzter Fehler</div>
        <pre>${escapeHtml(status.lastError || 'Kein Fehler vorhanden')}</pre>
      </div>

      <div class="card full">
        <div class="label">Rohdaten</div>
        <pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre>
      </div>
    </div>

    <div class="footer">
      Automatische Aktualisierung alle 30 Sekunden · http://${HOST}:${PORT}
    </div>

  </div>
</body>
</html>
  `;
}

app.get('/', (req, res) => {
  res.send(renderDashboard(readStatus()));
});

app.get('/api/status', (req, res) => {
  res.json(readStatus());
});

app.post('/control/start-autoprint', async (req, res) => {
  const result = await runCommand('pm2 start autopilot.js --name autoprint');
  res.send(renderDashboard(readStatus(), result));
});

app.post('/control/stop-autoprint', async (req, res) => {
  const result = await runCommand('pm2 stop autoprint');
  res.send(renderDashboard(readStatus(), result));
});

app.post('/control/restart-autoprint', async (req, res) => {
  const result = await runCommand('pm2 restart autoprint --update-env');
  res.send(renderDashboard(readStatus(), result));
});

app.post('/control/restart-all', async (req, res) => {
  const result = await runCommand('pm2 restart all --update-env');
  res.send(renderDashboard(readStatus(), result));
});

app.post('/control/pm2-list', async (req, res) => {
  const result = await runCommand('pm2 list');
  res.send(renderDashboard(readStatus(), result));
});

app.get('/auth', (req, res) => {
  const redirectUri = `http://${HOST}:${PORT}/auth/callback`;

  const installUrl =
    `https://${SHOP}/admin/oauth/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    res.send('Fehler: Kein Shopify-Code erhalten.');
    return;
  }

  try {
    const response = await axios.post(`https://${SHOP}/admin/oauth/access_token`, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code
    });

    console.log('ACCESS TOKEN:');
    console.log(response.data.access_token);

    res.send(`
      <h1>Token erfolgreich erstellt</h1>
      <p>Der Access Token wurde im Terminal ausgegeben.</p>
      <p><a href="/">Zurück zum Dashboard</a></p>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);

    res.send(`
      <h1>Fehler beim Erstellen des Tokens</h1>
      <pre>${escapeHtml(JSON.stringify(err.response?.data || err.message, null, 2))}</pre>
      <p><a href="/">Zurück zum Dashboard</a></p>
    `);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Dashboard läuft auf http://${HOST}:${PORT}`);
  console.log(`Shopify Auth läuft auf http://${HOST}:${PORT}/auth`);
});