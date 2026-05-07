require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DRY_RUN = false;
const ENABLE_PRINT = false; // erst wieder auf true, wenn Matching stabil ist

const PRINTED_FILE = 'C:\\docmorris-auto\\printed-mirakl.json';
const MIRAKL_LOG_FILE = 'C:\\DocMorris-Logs\\mirakl-autoprint.log';

const SHOP = process.env.SHOPIFY_MIRAKL_SHOP;
const CLIENT_ID = process.env.SHOPIFY_MIRAKL_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_MIRAKL_CLIENT_SECRET;

const SENDCLOUD_PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY;
const SENDCLOUD_PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY;

const MIRAKL_BASE_URL = process.env.MIRAKL_BASE_URL;
const MIRAKL_API_KEY = process.env.MIRAKL_API_KEY;

const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID_LABEL);

function logMirakl(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  fs.mkdirSync(path.dirname(MIRAKL_LOG_FILE), { recursive: true });
  fs.appendFileSync(MIRAKL_LOG_FILE, line + '\n', 'utf8');
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

function wasPrinted(orderId) {
  const list = readJson(PRINTED_FILE, []);
  return Array.isArray(list) && list.includes(orderId);
}

function markPrinted(orderId) {
  const list = readJson(PRINTED_FILE, []);
  const safeList = Array.isArray(list) ? list : [];

  if (!safeList.includes(orderId)) {
    safeList.push(orderId);
    writeJson(PRINTED_FILE, safeList);
  }
}

async function getShopifyToken() {
  const res = await axios.post(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  return res.data.access_token;
}

async function getShopifyOrders(limit = 50) {
  const token = await getShopifyToken();

  const res = await axios.get(`https://${SHOP}/admin/api/2026-01/orders.json`, {
    headers: { 'X-Shopify-Access-Token': token },
    params: {
      status: 'any',
      fulfillment_status: 'unfulfilled',
      limit
    }
  });

  return res.data.orders || [];
}

async function getSendcloudParcels(limit = 250) {
  const res = await axios.get('https://panel.sendcloud.sc/api/v2/parcels', {
    auth: {
      username: SENDCLOUD_PUBLIC_KEY,
      password: SENDCLOUD_PRIVATE_KEY
    },
    params: {
      limit,
      ordering: '-created_at'
    }
  });

  return res.data.parcels || [];
}

function extractMiraklOrderId(order) {
  const text = JSON.stringify(order || {});
  const match = text.match(/\b[A-Z]{2,3}-\d+-\d+-[A-Z]\b/);
  return match ? match[0] : null;
}

function findParcelForOrder(miraklOrderId, parcels) {
  const needle = String(miraklOrderId || '').toLowerCase();

  return parcels.find(p => {
    const parcelText = JSON.stringify({
      order_number: p.order_number,
      external_order_id: p.external_order_id,
      external_reference: p.external_reference,
      external_shipment_id: p.external_shipment_id,
      reference: p.reference,
      data: p.data,
      parcel_items: p.parcel_items
    }).toLowerCase();

    return parcelText.includes(needle);
  });
}

async function findMiraklOrderByReference(reference) {
  const res = await axios.get(`${MIRAKL_BASE_URL}/api/orders`, {
    headers: { Authorization: MIRAKL_API_KEY },
    params: { order_ids: reference }
  });

  const orders = res.data.orders || [];
  return orders[0] || null;
}

async function updateMiraklTracking(orderId, parcel) {
  await axios.put(
    `${MIRAKL_BASE_URL}/api/orders/${encodeURIComponent(orderId)}/tracking`,
    {
      carrier_code: 'dhl',
      carrier_name: 'DHL',
      tracking_number: parcel.tracking_number,
      tracking_url: parcel.tracking_url
    },
    {
      headers: {
        Authorization: MIRAKL_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function shipMiraklOrder(orderId) {
  try {
    await axios.put(
      `${MIRAKL_BASE_URL}/api/orders/${encodeURIComponent(orderId)}/ship`,
      {},
      {
        headers: {
          Authorization: MIRAKL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    return { ok: true, alreadyShipped: false, notReady: false };

  } catch (err) {
    const msg = JSON.stringify(err.response?.data || err.message);

    if (msg.includes('SHIPPED')) {
      return { ok: true, alreadyShipped: true, notReady: false };
    }

    if (msg.includes('WAITING_DEBIT_PAYMENT')) {
      return { ok: true, alreadyShipped: false, notReady: true, reason: 'WAITING_DEBIT_PAYMENT' };
    }

    throw err;
  }
}

async function downloadLabel(url) {
  if (!url) throw new Error('Keine Label-URL von Sendcloud erhalten.');

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: SENDCLOUD_PUBLIC_KEY,
      password: SENDCLOUD_PRIVATE_KEY
    }
  });

  return Buffer.from(res.data).toString('base64');
}

async function sendPdfToPrintNode({ printerId, title, base64 }) {
  await axios.post(
    'https://api.printnode.com/printjobs',
    {
      printerId,
      title,
      contentType: 'pdf_base64',
      content: base64,
      source: 'Mirakl AutoPrint'
    },
    {
      auth: {
        username: PRINTNODE_API_KEY,
        password: ''
      }
    }
  );
}

async function printLabel(base64, orderName) {
  await sendPdfToPrintNode({
    printerId: PRINTER_ID,
    title: `Mirakl DHL Label ${orderName}`,
    base64
  });
}

async function maybePrintLabel(order, miraklOrderId, parcel) {
  if (!ENABLE_PRINT) {
    return;
  }

  if (wasPrinted(miraklOrderId)) {
    logMirakl(`SKIP ${miraklOrderId}: Label bereits gedruckt`);
    return;
  }

  const labelUrl = parcel.label?.label_printer || parcel.label?.normal_printer?.[0];

  if (!labelUrl) {
    logMirakl(`WAIT ${order.name} / ${miraklOrderId}: keine Label-URL vorhanden`);
    return;
  }

  const labelBase64 = await downloadLabel(labelUrl);
  await printLabel(labelBase64, order.name);
  markPrinted(miraklOrderId);

  logMirakl(`PRINT ${order.name} / ${miraklOrderId}: Label gedruckt`);
}

async function main() {
  console.log('=== Mirakl AutoPrint LIVE ===');

  const orders = await getShopifyOrders(50);
  const parcels = await getSendcloudParcels(250);

  console.log('Shopify Orders:', orders.length);
  console.log('Sendcloud Parcels:', parcels.length);

  for (const order of orders) {
    const miraklOrderId = extractMiraklOrderId(order);

    if (!miraklOrderId) {
      console.log(`SKIP ${order.name}: keine Mirakl-ID gefunden`);
      continue;
    }

    const parcel = findParcelForOrder(miraklOrderId, parcels);

    if (!parcel) {
      logMirakl(`WAIT ${order.name} / ${miraklOrderId}: kein Sendcloud Parcel gefunden`);
      continue;
    }

    if (!parcel.tracking_number) {
      logMirakl(`WAIT ${order.name} / ${miraklOrderId}: Parcel da, aber kein Tracking`);
      continue;
    }

    logMirakl(`READY ${order.name} / ${miraklOrderId}: ${parcel.tracking_number}`);

    const miraklOrder = await findMiraklOrderByReference(miraklOrderId);

    if (!miraklOrder) {
      logMirakl(`WAIT ${miraklOrderId}: nicht in Mirakl gefunden`);
      continue;
    }

    const realMiraklId = miraklOrder.order_id || miraklOrder.id || miraklOrder.uuid;
    const status = String(miraklOrder.status || miraklOrder.order_state || '').toUpperCase();

    console.log(`→ Mirakl API ID: ${realMiraklId}`);
    console.log(`→ Mirakl Status: ${status || 'unbekannt'}`);

    if (status === 'SHIPPED') {
      logMirakl(`DONE ${miraklOrderId}: bereits SHIPPED`);
      await maybePrintLabel(order, miraklOrderId, parcel);
      continue;
    }

    if (status && status !== 'SHIPPING') {
      logMirakl(`WAIT ${miraklOrderId}: falscher Status (${status})`);
      continue;
    }

    if (!DRY_RUN) {
      await updateMiraklTracking(realMiraklId, parcel);

      const shipResult = await shipMiraklOrder(realMiraklId);

      if (shipResult.notReady) {
        logMirakl(`WAIT ${miraklOrderId}: ${shipResult.reason}`);
        continue;
      }

      if (shipResult.alreadyShipped) {
        logMirakl(`DONE ${miraklOrderId}: bereits SHIPPED`);
      } else {
        logMirakl(`DONE ${miraklOrderId}`);
      }

      await maybePrintLabel(order, miraklOrderId, parcel);
    }
  }

  console.log('=== Fertig ===');
}

async function loop() {
  while (true) {
    try {
      console.log('\n=== MIRAKL AUTOPRINT SCAN ===', new Date().toISOString());
      await main();
    } catch (err) {
      console.error('MIRAKL AUTOPRINT LOOP ERROR');
      console.error(err.response?.data || err.message);
    }

    await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));
  }
}

loop();