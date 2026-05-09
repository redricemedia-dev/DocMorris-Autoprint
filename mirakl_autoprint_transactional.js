require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const QRCode = require('qrcode');

const DRY_RUN = false;
const ENABLE_PRINT = true;

const PRINTED_FILE = 'C:\\docmorris-auto\\printed-mirakl.json';
const MIRAKL_STATE_FILE = 'C:\\docmorris-auto\\mirakl-processing.json';
const MIRAKL_LOG_FILE = process.env.MIRAKL_LOG_FILE || 'G:\\DocMorris-Logs\\mirakl-autoprint.log';

const SHIPPING_METHOD = Number(process.env.SENDCLOUD_SHIPPING_METHOD_ID || 89);
const DEFAULT_WEIGHT = process.env.SENDCLOUD_DEFAULT_WEIGHT || '0.5';

const SHOP = process.env.SHOPIFY_MIRAKL_SHOP;
const CLIENT_ID = process.env.SHOPIFY_MIRAKL_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_MIRAKL_CLIENT_SECRET;

const SENDCLOUD_PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY;
const SENDCLOUD_PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY;

const MIRAKL_BASE_URL = process.env.MIRAKL_BASE_URL;
const MIRAKL_API_KEY = process.env.MIRAKL_API_KEY;

const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID_LABEL);
const SLIP_PRINTER_ID = Number(
  process.env.PRINTNODE_PRINTER_ID_SLIP || process.env.PRINTNODE_PRINTER_ID_LABEL
);

const PRINT_ARCHIVE_DIR = process.env.PRINT_ARCHIVE_DIR || 'G:\\DocMorris-Druckarchiv';
const BRAND_NAME = process.env.BRAND_NAME || 'VitaSanum';
const LOGO_URL = process.env.LOGO_URL || '';
const COMPANY_FOOTER =
  process.env.COMPANY_FOOTER ||
  'VitaSanum GmbH · Königsallee 27 · 40212 Düsseldorf · Germany';

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

function readState() {
  const state = readJson(MIRAKL_STATE_FILE, {});
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function writeState(state) {
  writeJson(MIRAKL_STATE_FILE, state);
}

function getState(orderId) {
  return readState()[orderId] || null;
}

function setState(orderId, update) {
  const state = readState();
  state[orderId] = {
    ...(state[orderId] || {}),
    ...update,
    updatedAt: new Date().toISOString()
  };
  writeState(state);
  return state[orderId];
}

function isDone(orderId) {
  const s = getState(orderId);
  return Boolean(s && s.status === 'done' && s.miraklShipped && s.shopifyFulfilled);
}

function isLocked(orderId) {
  const s = getState(orderId);
  if (!s || s.status !== 'processing') return false;

  const startedAt = s.startedAt ? new Date(s.startedAt).getTime() : 0;
  const maxAgeMs = 30 * 60 * 1000;
  return Date.now() - startedAt < maxAgeMs;
}

function lockOrder(orderId, orderName) {
  setState(orderId, {
    status: 'processing',
    orderName,
    startedAt: new Date().toISOString()
  });
}

function markError(orderId, error) {
  setState(orderId, {
    status: 'error',
    errorAt: new Date().toISOString(),
    error: typeof error === 'string' ? error : JSON.stringify(error, null, 2)
  });
}

function markDone(orderId, update) {
  setState(orderId, {
    ...update,
    status: 'done',
    doneAt: new Date().toISOString()
  });
}

function validateEnv() {
  const required = {
    SHOPIFY_MIRAKL_SHOP: SHOP,
    SHOPIFY_MIRAKL_CLIENT_ID: CLIENT_ID,
    SHOPIFY_MIRAKL_CLIENT_SECRET: CLIENT_SECRET,
    SENDCLOUD_PUBLIC_KEY,
    SENDCLOUD_PRIVATE_KEY,
    MIRAKL_BASE_URL,
    MIRAKL_API_KEY,
    PRINTNODE_API_KEY,
    PRINTNODE_PRINTER_ID_LABEL: process.env.PRINTNODE_PRINTER_ID_LABEL
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Fehlende .env Werte: ${missing.join(', ')}`);
  }

  if (!SHIPPING_METHOD || Number.isNaN(SHIPPING_METHOD)) {
    throw new Error('SENDCLOUD_SHIPPING_METHOD_ID ist leer oder ungueltig.');
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

async function getShopifyOrders(limit = 250) {
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

async function getShopifyFulfillmentOrders(order) {
  const token = await getShopifyToken();

  const res = await axios.get(
    `https://${SHOP}/admin/api/2026-01/orders/${order.id}/fulfillment_orders.json`,
    {
      headers: { 'X-Shopify-Access-Token': token }
    }
  );

  return res.data.fulfillment_orders || [];
}

function mergeTags(existingTags, tagToAdd) {
  const tags = String(existingTags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!tags.includes(tagToAdd)) tags.push(tagToAdd);
  return tags.join(', ');
}

async function tagShopifyOrder(order, tag) {
  const token = await getShopifyToken();

  await axios.put(
    `https://${SHOP}/admin/api/2026-01/orders/${order.id}.json`,
    {
      order: {
        id: order.id,
        tags: mergeTags(order.tags, tag)
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function fulfillShopifyOrder(order, parcel, miraklOrderId) {
  const token = await getShopifyToken();
  const fulfillmentOrders = await getShopifyFulfillmentOrders(order);

  const openFulfillmentOrders = fulfillmentOrders.filter(fo =>
    ['open', 'in_progress', 'scheduled'].includes(String(fo.status || '').toLowerCase())
  );

  if (openFulfillmentOrders.length === 0) {
    logMirakl(`SHOPIFY ${order.name} / ${miraklOrderId}: keine offenen Fulfillment Orders, vermutlich bereits fulfilled`);
    await tagShopifyOrder(order, 'AUTOPRINT_MIRAKL_DONE');
    return { ok: true, alreadyFulfilled: true };
  }

  const trackingNumber = parcel.tracking_number || '';
  const trackingUrl = parcel.tracking_url || '';

  for (const fo of openFulfillmentOrders) {
    await axios.post(
      `https://${SHOP}/admin/api/2026-01/fulfillments.json`,
      {
        fulfillment: {
          message: `Mirakl AutoPrint ${miraklOrderId}`,
          notify_customer: false,
          tracking_info: {
            company: 'DHL',
            number: trackingNumber,
            url: trackingUrl
          },
          line_items_by_fulfillment_order: [
            {
              fulfillment_order_id: fo.id
            }
          ]
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  await tagShopifyOrder(order, 'AUTOPRINT_MIRAKL_DONE');
  logMirakl(`SHOPIFY ${order.name} / ${miraklOrderId}: fulfilled + tagged`);

  return { ok: true, alreadyFulfilled: false };
}

async function getSendcloudParcels(limit = 1000) {
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

  return parcels.find(p =>
    String(p.order_number || '').toLowerCase() === needle
  );
}

function extractLabelUrl(parcel) {
  return (
    parcel?.label?.label_printer ||
    parcel?.label?.normal_printer?.[0] ||
    parcel?.label?.normal_printer ||
    parcel?.documents?.label ||
    null
  );
}

async function createParcel(order) {
  const a = order.shipping_address;

  if (!a) {
    throw new Error(`Keine Versandadresse vorhanden: ${order.name}`);
  }

  const countryCode = String(a.country_code || 'DE').toUpperCase();

  if (countryCode !== 'DE') {
    throw new Error(`Ausland ${countryCode}: kein automatisches Sendcloud-Label`);
  }

  const res = await axios.post(
    'https://panel.sendcloud.sc/api/v2/parcels',
    {
      parcel: {
        name: a.name || `${a.first_name || ''} ${a.last_name || ''}`.trim(),
        company_name: a.company || '',
        address: a.address1 || '',
        address_2: a.address2 || '',
        house_number: '',
        city: a.city || '',
        postal_code: a.zip || '',
        country: countryCode,
        email: order.email || '',
        telephone: a.phone || order.phone || '',
        weight: DEFAULT_WEIGHT,
        order_number: order.name,
        external_order_id: order.admin_graphql_api_id,
        external_reference: String(order.id),
        shipment: {
          id: SHIPPING_METHOD
        },
        request_label: true
      }
    },
    {
      auth: {
        username: SENDCLOUD_PUBLIC_KEY,
        password: SENDCLOUD_PRIVATE_KEY
      }
    }
  );

  return res.data.parcel;
}

async function requestSendcloudLabel(parcel) {
  const res = await axios.put(
    `https://panel.sendcloud.sc/api/v2/parcels/${parcel.id}`,
    {
      parcel: {
        id: parcel.id,
        shipment: {
          id: SHIPPING_METHOD
        },
        request_label: true
      }
    },
    {
      auth: {
        username: SENDCLOUD_PUBLIC_KEY,
        password: SENDCLOUD_PRIVATE_KEY
      }
    }
  );

  return res.data.parcel;
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
  const res = await axios.post(
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

  return res.data;
}

async function printLabel(base64, orderName) {
  return await sendPdfToPrintNode({
    printerId: PRINTER_ID,
    title: `Mirakl DHL Label ${orderName}`,
    base64
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sanitizeFilename(value) {
  return String(value || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function saveBase64Pdf(base64, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
}

function formatAddress(address = {}) {
  const lines = [];
  const name = address.name || `${address.first_name || ''} ${address.last_name || ''}`.trim();

  if (name) lines.push(name);
  if (address.company) lines.push(address.company);
  if (address.address1) lines.push(address.address1);
  if (address.address2) lines.push(address.address2);

  const cityLine = `${address.zip || ''} ${address.city || ''}`.trim();
  if (cityLine) lines.push(cityLine);

  if (address.country || address.country_code) {
    lines.push(address.country || address.country_code);
  }

  return lines.map(line => escapeHtml(line)).join('<br>');
}

function renderItemRows(order) {
  return (order.line_items || []).map(item => {
    const name = escapeHtml(item.name || '');
    const sku = escapeHtml(item.sku || '-');
    const quantityRaw = Number(item.quantity || 1);

    const quantity =
      quantityRaw > 1
        ? `<span class="qty-badge">${quantityRaw}</span>`
        : `<span class="qty-normal">${quantityRaw}</span>`;

    const rowClass = quantityRaw > 1 ? 'multi-qty' : '';

    const variant =
      item.variant_title && item.variant_title !== 'Default Title'
        ? `<div class="product-meta">${escapeHtml(item.variant_title)}</div>`
        : '';

    return `
      <tr class="${rowClass}">
        <td class="qty">${quantity}</td>
        <td>
          <div class="product-name">${name}</div>
          ${variant}
        </td>
        <td class="sku">${sku}</td>
      </tr>
    `;
  }).join('');
}

async function generateQRCode(order) {
  const data = order.name || String(order.id || '');

  return await QRCode.toDataURL(data, {
    margin: 1,
    width: 220
  });
}

function getPackingSlipTemplate() {
  const templatePath = path.join(__dirname, 'templates', 'packing-slip.html');

  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');

  throw new Error('packing-slip.html fehlt in C:\\docmorris-auto\\templates');
}

async function renderPackingSlipHtml(order) {
  let html = getPackingSlipTemplate();

  const orderDate = new Date(order.created_at).toLocaleDateString('de-DE');
  const qrCode = await generateQRCode(order);

  const brandBlock = LOGO_URL
    ? `<img src="${escapeHtml(LOGO_URL)}" alt="${escapeHtml(BRAND_NAME)}">`
    : escapeHtml(BRAND_NAME);

  const replacements = {
    BRAND_NAME: escapeHtml(BRAND_NAME),
    BRAND_BLOCK: brandBlock,
    LOGO_URL: escapeHtml(LOGO_URL),
    QR_CODE: qrCode,
    ORDER_NAME: escapeHtml(order.name || ''),
    ORDER_DATE: escapeHtml(orderDate),
    CUSTOMER_EMAIL: escapeHtml(order.email || '-'),
    SHIPPING_PROVIDER: 'DHL',
    SHIPPING_ADDRESS: formatAddress(order.shipping_address || {}),
    ITEM_ROWS: renderItemRows(order),
    COMPANY_FOOTER: escapeHtml(COMPANY_FOOTER)
  };

  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }

  return html;
}

async function htmlToPdfBuffer(html) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1240,
        height: 1754
      }
    });

    await page.setContent(html, { waitUntil: 'networkidle' });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0'
      }
    });
  } finally {
    await browser.close();
  }
}

async function createPackingSlipBase64(order) {
  const html = await renderPackingSlipHtml(order);
  const pdfBuffer = await htmlToPdfBuffer(html);
  return pdfBuffer.toString('base64');
}

async function printPackingSlip(base64, orderName) {
  return await sendPdfToPrintNode({
    printerId: SLIP_PRINTER_ID,
    title: `Mirakl Lieferschein ${orderName}`,
    base64
  });
}

async function printPackingSlipForOrder(order) {
  const slipBase64 = await createPackingSlipBase64(order);

  const slipFile = path.join(
    PRINT_ARCHIVE_DIR,
    'lieferscheine',
    `Lieferschein_Mirakl_${sanitizeFilename(order.name)}.pdf`
  );

  saveBase64Pdf(slipBase64, slipFile);
  logMirakl(`SLIP ${order.name}: Lieferschein archiviert`);

  const printJob = await printPackingSlip(slipBase64, order.name);
  logMirakl(`SLIP ${order.name}: Lieferschein gedruckt`);

  return { slipFile, printJob };
}

async function maybePrintLabel(order, miraklOrderId, parcel) {
  if (!ENABLE_PRINT) {
    return { printed: false, reason: 'print disabled' };
  }

  if (wasPrinted(miraklOrderId)) {
    logMirakl(`SKIP ${miraklOrderId}: Label bereits gedruckt`);
    return { printed: true, alreadyPrinted: true };
  }

  const labelUrl = extractLabelUrl(parcel);

  if (!labelUrl) {
    logMirakl(`WAIT ${order.name} / ${miraklOrderId}: keine Label-URL vorhanden`);
    return { printed: false, reason: 'no label url' };
  }

  if (wasPrinted(miraklOrderId)) {
    logMirakl(`SKIP ${miraklOrderId}: Label bereits direkt vor Druck erkannt`);
    return { printed: true, alreadyPrinted: true };
  }

  const labelBase64 = await downloadLabel(labelUrl);
  const labelPrintJob = await printLabel(labelBase64, order.name);

  logMirakl(`PRINT ${order.name} / ${miraklOrderId}: Label gedruckt`);

  const slipResult = await printPackingSlipForOrder(order);
  logMirakl(`PRINT ${order.name} / ${miraklOrderId}: Lieferschein gedruckt`);

  markPrinted(miraklOrderId);

  return {
    printed: true,
    alreadyPrinted: false,
    labelPrintJob,
    slipPrintJob: slipResult.printJob,
    slipFile: slipResult.slipFile
  };
}

async function processOrder(order, parcels) {
  console.log('Name:', order.name);
  console.log('Email:', order.email);
  console.log('Ship Name:', order.shipping_address?.name);
  console.log('ZIP:', order.shipping_address?.zip);
  console.log('City:', order.shipping_address?.city);
  console.log('Country:', order.shipping_address?.country_code);
  console.log('-------------------');

  const miraklOrderId = extractMiraklOrderId(order);

  if (!miraklOrderId) {
    console.log(`SKIP ${order.name}: keine Mirakl-ID gefunden`);
    return;
  }

  if (isDone(miraklOrderId)) {
    logMirakl(`SKIP ${order.name} / ${miraklOrderId}: bereits DONE laut mirakl-processing.json`);
    return;
  }

  if (isLocked(miraklOrderId)) {
    logMirakl(`SKIP ${order.name} / ${miraklOrderId}: Verarbeitung laeuft bereits`);
    return;
  }

  const countryCode = String(order.shipping_address?.country_code || 'DE').toUpperCase();

  if (countryCode !== 'DE') {
    logMirakl(`SKIP ${order.name} / ${miraklOrderId}: Ausland ${countryCode}, kein Autolabel`);
    setState(miraklOrderId, {
      status: 'skipped_foreign',
      orderName: order.name,
      countryCode
    });
    return;
  }

  lockOrder(miraklOrderId, order.name);

  let parcel = findParcelForOrder(miraklOrderId, parcels);

  if (!parcel) {
    logMirakl(`CREATE ${order.name} / ${miraklOrderId}: Sendcloud Parcel wird erstellt`);
    parcel = await createParcel(order);
    logMirakl(`CREATE ${order.name} / ${miraklOrderId}: Sendcloud Parcel erstellt`);
  }

  if (!parcel.tracking_number) {
    logMirakl(`LABEL ${order.name} / ${miraklOrderId}: Parcel da, fordere Label an`);
    parcel = await requestSendcloudLabel(parcel);

    if (!parcel.tracking_number) {
      logMirakl(`WAIT ${order.name} / ${miraklOrderId}: Label angefordert, aber noch kein Tracking`);
      setState(miraklOrderId, {
        status: 'waiting_tracking',
        orderName: order.name,
        parcelId: parcel.id || null
      });
      return;
    }

    logMirakl(`LABEL ${order.name} / ${miraklOrderId}: Tracking erhalten ${parcel.tracking_number}`);
  }

  setState(miraklOrderId, {
    status: 'tracking_ready',
    orderName: order.name,
    tracking: parcel.tracking_number,
    trackingUrl: parcel.tracking_url || '',
    parcelId: parcel.id || null
  });

  logMirakl(`READY ${order.name} / ${miraklOrderId}: ${parcel.tracking_number}`);

  const miraklOrder = await findMiraklOrderByReference(miraklOrderId);

  if (!miraklOrder) {
    logMirakl(`WAIT ${miraklOrderId}: nicht in Mirakl gefunden`);
    setState(miraklOrderId, {
      status: 'waiting_mirakl',
      orderName: order.name,
      tracking: parcel.tracking_number
    });
    return;
  }

  const realMiraklId = miraklOrder.order_id || miraklOrder.id || miraklOrder.uuid;
  const status = String(miraklOrder.status || miraklOrder.order_state || '').toUpperCase();

  console.log(`→ Mirakl API ID: ${realMiraklId}`);
  console.log(`→ Mirakl Status: ${status || 'unbekannt'}`);

  let miraklShipped = false;

  if (status === 'SHIPPED') {
    logMirakl(`DONE ${miraklOrderId}: bereits SHIPPED`);
    miraklShipped = true;
  } else if (status && status !== 'SHIPPING') {
    logMirakl(`WAIT ${miraklOrderId}: falscher Status (${status})`);
    setState(miraklOrderId, {
      status: 'waiting_status',
      orderName: order.name,
      miraklStatus: status,
      tracking: parcel.tracking_number
    });
    return;
  } else if (!DRY_RUN) {
    await updateMiraklTracking(realMiraklId, parcel);
    const shipResult = await shipMiraklOrder(realMiraklId);

    if (shipResult.notReady) {
      logMirakl(`WAIT ${miraklOrderId}: ${shipResult.reason}`);
      setState(miraklOrderId, {
        status: 'waiting_mirakl_not_ready',
        orderName: order.name,
        reason: shipResult.reason,
        tracking: parcel.tracking_number
      });
      return;
    }

    miraklShipped = true;

    if (shipResult.alreadyShipped) {
      logMirakl(`DONE ${miraklOrderId}: bereits SHIPPED`);
    } else {
      logMirakl(`DONE ${miraklOrderId}`);
    }
  } else {
    logMirakl(`DRY_RUN ${miraklOrderId}: Mirakl wuerde jetzt shipped gesetzt`);
  }

  let shopifyResult = { ok: false };
  let printResult = { printed: false };

  if (!DRY_RUN && miraklShipped) {
    shopifyResult = await fulfillShopifyOrder(order, parcel, miraklOrderId);
    printResult = await maybePrintLabel(order, miraklOrderId, parcel);
  }

  if (miraklShipped && shopifyResult.ok) {
    markDone(miraklOrderId, {
      orderName: order.name,
      tracking: parcel.tracking_number,
      trackingUrl: parcel.tracking_url || '',
      parcelId: parcel.id || null,
      miraklShipped: true,
      shopifyFulfilled: true,
      printed: Boolean(printResult.printed || wasPrinted(miraklOrderId)),
      labelPrintJob: printResult.labelPrintJob || null,
      slipPrintJob: printResult.slipPrintJob || null
    });
  }
}

async function main() {
  console.log('=== Mirakl AutoPrint LIVE ===');

  const orders = await getShopifyOrders(250);
  const parcels = await getSendcloudParcels(1000);

  console.log('Shopify Orders:', orders.length);
  console.log('Sendcloud Parcels:', parcels.length);

  for (const order of orders) {
    const miraklOrderId = extractMiraklOrderId(order) || order.name || String(order.id);

    try {
      await processOrder(order, parcels);
    } catch (err) {
      const details = err.response?.data || err.message || err;
      logMirakl(`ERROR ${order.name} / ${miraklOrderId}: ${JSON.stringify(details)}`);
      markError(miraklOrderId, details);
    }
  }

  console.log('=== Fertig ===');
}

async function loop() {
  validateEnv();

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
