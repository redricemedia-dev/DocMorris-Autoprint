require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { exec } = require('child_process');

const DEBUG_ORDER_DIR = process.env.DEBUG_ORDER_DIR || 'C:\\DocMorris-Rechnungen\\debug-orders';
const LOG_DIR = process.env.LOG_DIR || 'C:\\DocMorris-Logs';
const ERROR_DIR = process.env.ERROR_DIR || 'C:\\DocMorris-Fehler';
const SKIP_FILE = process.env.SKIP_FILE || path.join(ERROR_DIR, 'skip-orders.json');

const SHOP = process.env.SHOPIFY_SHOP;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY.trim();

const SHIPPING_METHOD = Number(process.env.SENDCLOUD_SHIPPING_METHOD_ID);
const DEFAULT_WEIGHT = process.env.SENDCLOUD_DEFAULT_WEIGHT || '0.5';

const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID_LABEL);
const SLIP_PRINTER_ID = Number(
  process.env.PRINTNODE_PRINTER_ID_SLIP || process.env.PRINTNODE_PRINTER_ID_LABEL
);

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 600000);
const STATUS_FILE = process.env.STATUS_FILE || 'C:\\docmorris-auto\\status.json';
const INVOICE_DIR = process.env.INVOICE_DIR || 'C:\\DocMorris-Rechnungen';
const PRINT_ARCHIVE_DIR = process.env.PRINT_ARCHIVE_DIR || 'C:\\DocMorris-Druckarchiv';

const BRAND_NAME = process.env.BRAND_NAME || 'VitaSanum';
const LOGO_URL = process.env.LOGO_URL || '';
const COMPANY_FOOTER =
  process.env.COMPANY_FOOTER ||
  'VitaSanum GmbH · Rosenheimer Landstraße 27 · 85521 Ottobrunn · Germany';

const VAT_ID = process.env.VAT_ID || 'DE360991334';
const DEFAULT_VAT_RATE = Number(process.env.DEFAULT_VAT_RATE || 7);

const MAIL_ALERT_ENABLED = String(process.env.MAIL_ALERT_ENABLED || 'true') === 'true';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || 'info@redrice.biz';

const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true') === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const processing = new Set();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(LOG_DIR);
ensureDir(ERROR_DIR);
ensureDir(DEBUG_ORDER_DIR);
ensureDir(INVOICE_DIR);
ensureDir(PRINT_ARCHIVE_DIR);
ensureDir(path.join(PRINT_ARCHIVE_DIR, 'labels'));
ensureDir(path.join(PRINT_ARCHIVE_DIR, 'lieferscheine'));

function timestamp() {
  return new Date().toLocaleString('de-DE', { hour12: false });
}

function nextScanTime() {
  return new Date(Date.now() + INTERVAL_MS).toLocaleString('de-DE', { hour12: false });
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function timeStampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function appendLog(level, message) {
  try {
    ensureDir(LOG_DIR);
    const file = path.join(LOG_DIR, `autoprint_${dateStamp()}.log`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, 'utf8');
  } catch {}
}

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  originalLog(...args);
  appendLog('INFO', args.map(String).join(' '));
};

console.error = (...args) => {
  originalError(...args);
  appendLog(
    'ERROR',
    args.map(arg => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ')
  );
};

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getSkipOrders() {
  return readJsonFile(SKIP_FILE, []);
}

function isOrderSkipped(order) {
  return getSkipOrders().includes(order.name);
}

function addOrderToSkip(order, reason) {
  const skips = getSkipOrders();

  if (!skips.includes(order.name)) {
    skips.push(order.name);
    writeJsonFile(SKIP_FILE, skips);
  }

  appendLog('WARN', `Bestellung ${order.name} wurde zur Skip-Liste hinzugefügt: ${reason}`);
}

function writeStatus(update) {
  let current = {};

  try {
    current = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {}

  fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...current, ...update }, null, 2));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*#]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

function money(value) {
  return `${Number(value || 0).toFixed(2)} €`;
}

function getCustomerName(order) {
  const a = order.billing_address || order.shipping_address || {};
  return (
    a.name ||
    `${a.first_name || ''} ${a.last_name || ''}`.trim() ||
    'Unbekannter_Kunde'
  );
}

function getVatRateForItem(item) {
  const text = [item.name, item.title, item.vendor, item.sku]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const cosmeticsKeywords = [
    'shampoo', 'conditioner', 'leave in', 'leave-in', 'balsam',
    'lippen', 'lip', 'augen', 'eye', 'creme', 'cream',
    'serum', 'gel', 'lotion', 'maske', 'mask'
  ];

  const cosmeticsBrands = [
    'arganicare', 'belweder', 'vegas', 'fleurance', 'endro', 'lekker'
  ];

  if (
    cosmeticsKeywords.some(keyword => text.includes(keyword)) ||
    cosmeticsBrands.some(brand => text.includes(brand))
  ) {
    return 19;
  }

  const supplementKeywords = [
    'kapseln', 'kapsel', 'caps', 'capsules', 'tabletten', 'tablets',
    'pulver', 'powder', 'mg', 'µg', 'mcg', 'vitamin', 'mineral',
    'extrakt', 'extract'
  ];

  if (supplementKeywords.some(keyword => text.includes(keyword))) {
    return 7;
  }

  return DEFAULT_VAT_RATE;
}

function calculateGrossVat(gross, rate) {
  const grossValue = Number(gross || 0);
  const divisor = 1 + rate / 100;
  const net = grossValue / divisor;
  const vat = grossValue - net;

  return { net, vat, gross: grossValue, rate };
}

function writeErrorReport(order, err) {
  ensureDir(ERROR_DIR);

  const orderNumber = sanitizeFilename(order?.name || String(order?.id || 'unknown'));
  const filePath = path.join(ERROR_DIR, `error_${orderNumber}_${timeStampForFile()}.json`);

  const report = {
    time: new Date().toISOString(),
    orderName: order?.name || null,
    shopifyOrderId: order?.id || null,
    shopifyGraphqlId: order?.admin_graphql_api_id || null,
    errorMessage: err?.message || String(err),
    errorResponse: err?.response?.data || null,
    stack: err?.stack || null
  };

  writeJsonFile(filePath, report);
  console.error(`→ Fehlerbericht gespeichert: ${filePath}`);

  return filePath;
}

function saveBase64Pdf(base64, filePath) {
  const buffer = Buffer.from(base64, 'base64');
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buffer);
}

function showWindowsAlert(orderName, message = 'Es ist ein Fehler aufgetreten.') {
  const safeOrder = String(orderName || 'unbekannt').replace(/"/g, "'");
  const safeMessage = String(message || '').replace(/"/g, "'");

  exec(
    `powershell -Command "Add-Type -AssemblyName PresentationFramework;[System.Windows.MessageBox]::Show('${safeMessage}','DocMorris AutoPrint - ${safeOrder}')"`,
    () => {}
  );
}

async function sendErrorEmail(order, err, errorFile) {
  if (!MAIL_ALERT_ENABLED) return;

  try {
    const orderName = order?.name || 'unbekannt';
    const errorMessage = err?.response?.data
      ? JSON.stringify(err.response.data, null, 2)
      : (err?.message || String(err));

    await mailTransporter.sendMail({
      from: `"DocMorris AutoPrint" <${process.env.SMTP_USER}>`,
      to: ALERT_EMAIL_TO,
      subject: `DocMorris AutoPrint Fehler - Bestellung ${orderName}`,
      text: `
Fehler bei Bestellung: ${orderName}

Zeit:
${new Date().toLocaleString('de-DE')}

Fehlermeldung:
${errorMessage}

Fehlerdatei:
${errorFile || '-'}

Hinweis:
Die Bestellung wurde in die Skip-Liste gesetzt und wird nicht automatisch erneut verarbeitet.
      `.trim()
    });

    console.log('→ Fehler-Mail gesendet');
  } catch (mailErr) {
    console.error('❌ Mailversand fehlgeschlagen:', mailErr.message);
  }
}

async function getOrders() {
  const res = await axios.get(`https://${SHOP}/admin/api/2026-01/orders.json`, {
    headers: { 'X-Shopify-Access-Token': SHOP_TOKEN },
    params: {
      status: 'open',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      limit: 10
    }
  });

  return res.data.orders || [];
}

async function checkSendcloud(order) {
  const res = await axios.get('https://panel.sendcloud.sc/api/v2/parcels', {
    auth: {
      username: PUBLIC_KEY,
      password: PRIVATE_KEY
    },
    params: {
      order_number: order.name
    }
  });

  const parcels = res.data.parcels || [];

  return parcels.filter(parcel =>
    parcel.order_number === order.name ||
    parcel.external_order_id === order.admin_graphql_api_id ||
    parcel.external_reference === String(order.id)
  );
}

async function createParcel(order) {
  const a = order.shipping_address;

  if (!a) throw new Error('Keine Versandadresse vorhanden.');

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
        country: a.country_code || 'DE',
        email: order.email || '',
        telephone: a.phone || order.phone || '',
        weight: DEFAULT_WEIGHT,
        order_number: order.name,
        external_order_id: order.admin_graphql_api_id,
        external_reference: String(order.id),
        shipping_method: SHIPPING_METHOD,
        request_label: true
      }
    },
    {
      auth: {
        username: PUBLIC_KEY,
        password: PRIVATE_KEY
      }
    }
  );

  return res.data.parcel;
}

async function downloadLabel(url) {
  if (!url) throw new Error('Keine Label-URL von Sendcloud erhalten.');

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: PUBLIC_KEY,
      password: PRIVATE_KEY
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
      source: 'DocMorris AutoPrint'
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
    title: `DHL Label ${orderName}`,
    base64
  });
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

function renderInvoiceRows(order) {
  return (order.line_items || []).map(item => {
    const title = escapeHtml(item.name || '');
    const sku = escapeHtml(item.sku || '-');

    const quantityRaw = Number(item.quantity || 1);

    const qtyDisplay =
      quantityRaw > 1
        ? `<span class="qty-badge">${quantityRaw}</span>`
        : `<span class="qty-normal">${quantityRaw}</span>`;

    const rowClass = quantityRaw > 1 ? 'multi-qty' : '';

    const grossPrice = Number(item.price || 0);
    const lineGross = quantityRaw * grossPrice;
    const vatRate = getVatRateForItem(item);

    return `
      <tr class="${rowClass}">
        <td class="invoice-qty">${qtyDisplay}</td>
        <td>
          <strong>${title}</strong><br>
          <span class="muted">SKU: ${sku}</span><br>
          <span class="muted">MwSt: ${vatRate}%</span>
        </td>
        <td class="right">${money(grossPrice)}</td>
        <td class="right">${money(lineGross)}</td>
      </tr>
    `;
  }).join('');
}

function calculateOrderVatTotals(order) {
  const totalsByRate = {};

  for (const item of order.line_items || []) {
    const quantity = Number(item.quantity || 1);
    const grossPrice = Number(item.price || 0);
    const lineGross = quantity * grossPrice;
    const rate = getVatRateForItem(item);
    const calc = calculateGrossVat(lineGross, rate);

    if (!totalsByRate[rate]) {
      totalsByRate[rate] = { net: 0, vat: 0, gross: 0, rate };
    }

    totalsByRate[rate].net += calc.net;
    totalsByRate[rate].vat += calc.vat;
    totalsByRate[rate].gross += calc.gross;
  }

  const shippingTotal = (order.shipping_lines || []).reduce(
    (sum, line) => sum + Number(line.price || 0),
    0
  );

  if (shippingTotal > 0) {
    const rate = DEFAULT_VAT_RATE;
    const calc = calculateGrossVat(shippingTotal, rate);

    if (!totalsByRate[rate]) {
      totalsByRate[rate] = { net: 0, vat: 0, gross: 0, rate };
    }

    totalsByRate[rate].net += calc.net;
    totalsByRate[rate].vat += calc.vat;
    totalsByRate[rate].gross += calc.gross;
  }

  const rows = Object.values(totalsByRate).sort((a, b) => a.rate - b.rate);
  const totalNet = rows.reduce((sum, row) => sum + row.net, 0);
  const totalVat = rows.reduce((sum, row) => sum + row.vat, 0);
  const totalGross = rows.reduce((sum, row) => sum + row.gross, 0);

  return { rows, totalNet, totalVat, totalGross };
}

function renderVatSummaryRows(vatTotals) {
  return vatTotals.rows.map(row => `
    <div class="sum-row">
      <span>Netto ${row.rate}%</span>
      <strong>${money(row.net)}</strong>
    </div>
    <div class="sum-row">
      <span>MwSt ${row.rate}%</span>
      <strong>${money(row.vat)}</strong>
    </div>
  `).join('');
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

function getInvoiceTemplate() {
  const templatePath = path.join(__dirname, 'templates', 'invoice.html');

  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');

  throw new Error('invoice.html fehlt in C:\\docmorris-auto\\templates');
}

function getMarketplaceOrderId(order) {
  const attr = (order.note_attributes || []).find(a =>
    String(a.name || '').toLowerCase() === 'marketplace order id'
  );

  return attr?.value || order.note || '-';
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

function renderInvoiceHtml(order) {
  let html = getInvoiceTemplate();

  const orderDate = new Date(order.created_at).toLocaleDateString('de-DE');
  const total = Number(order.total_price || order.current_total_price || 0);
  const vatTotals = calculateOrderVatTotals(order);

  const brandBlock = LOGO_URL
    ? `<img src="${escapeHtml(LOGO_URL)}" alt="${escapeHtml(BRAND_NAME)}">`
    : escapeHtml(BRAND_NAME);

  const replacements = {
    BRAND_BLOCK: brandBlock,
    VAT_ID: escapeHtml(VAT_ID),
    ORDER_NAME: escapeHtml(order.name || ''),
    MARKETPLACE_ORDER_ID: escapeHtml(getMarketplaceOrderId(order)),
    ORDER_DATE: escapeHtml(orderDate),
    BILLING_ADDRESS: formatAddress(order.billing_address || order.shipping_address || {}),
    SHIPPING_ADDRESS: formatAddress(order.shipping_address || {}),
    INVOICE_ROWS: renderInvoiceRows(order),
    VAT_SUMMARY_ROWS: renderVatSummaryRows(vatTotals),
    TOTAL: escapeHtml(money(total)),
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

async function createInvoicePdfBuffer(order) {
  const html = renderInvoiceHtml(order);
  return await htmlToPdfBuffer(html);
}

async function saveInvoiceForOrder(order) {
  ensureDir(INVOICE_DIR);

  const orderNumber = sanitizeFilename(order.name || String(order.id || 'order'));
  const customerName = sanitizeFilename(getCustomerName(order));
  const filename = `Rechnung_DocMorris_${orderNumber}_${customerName}.pdf`;
  const filePath = path.join(INVOICE_DIR, filename);

  if (fs.existsSync(filePath)) {
    console.log(`→ Rechnung existiert bereits: ${filePath}`);
    return filePath;
  }

  const pdfBuffer = await createInvoicePdfBuffer(order);
  fs.writeFileSync(filePath, pdfBuffer);

  console.log(`→ Rechnung gespeichert: ${filePath}`);
  return filePath;
}

async function printPackingSlip(base64, orderName) {
  await sendPdfToPrintNode({
    printerId: SLIP_PRINTER_ID,
    title: `Lieferschein ${orderName}`,
    base64
  });
}

async function printPackingSlipForOrder(order) {
  const slipBase64 = await createPackingSlipBase64(order);

  const slipFile = path.join(
    PRINT_ARCHIVE_DIR,
    'lieferscheine',
    `Lieferschein_${sanitizeFilename(order.name)}.pdf`
  );

  saveBase64Pdf(slipBase64, slipFile);
  console.log('→ Lieferschein archiviert:', slipFile);

  await printPackingSlip(slipBase64, order.name);
  console.log('→ Lieferschein gedruckt');
}

async function fulfillShopifyOrder(order, parcel) {
  const foRes = await axios.get(
    `https://${SHOP}/admin/api/2026-01/orders/${order.id}/fulfillment_orders.json`,
    {
      headers: {
        'X-Shopify-Access-Token': SHOP_TOKEN
      }
    }
  );

  const fulfillmentOrders = (foRes.data.fulfillment_orders || [])
    .filter(fo => fo.status === 'open' || fo.status === 'in_progress');

  if (fulfillmentOrders.length === 0) {
    console.log('→ Keine offene Fulfillment Order gefunden');
    return;
  }

  await axios.post(
    `https://${SHOP}/admin/api/2026-01/fulfillments.json`,
    {
      fulfillment: {
        message: 'Automatisch versendet via Sendcloud / PrintNode',
        notify_customer: false,
        tracking_info: {
          number: parcel.tracking_number,
          url: parcel.tracking_url,
          company: 'DHL'
        },
        line_items_by_fulfillment_order: fulfillmentOrders.map(fo => ({
          fulfillment_order_id: fo.id
        }))
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': SHOP_TOKEN
      }
    }
  );

  console.log('→ Shopify als versendet markiert');
}

function saveDebugOrder(order) {
  ensureDir(DEBUG_ORDER_DIR);

  const orderNumber = sanitizeFilename(order.name || String(order.id || 'order'));
  const filePath = path.join(DEBUG_ORDER_DIR, `order_${orderNumber}.json`);

  fs.writeFileSync(filePath, JSON.stringify(order, null, 2), 'utf8');

  console.log(`→ Shopify-Rohdaten gespeichert: ${filePath}`);
}

function archiveLabel(base64, order) {
  const labelFile = path.join(
    PRINT_ARCHIVE_DIR,
    'labels',
    `DHL_Label_${sanitizeFilename(order.name)}.pdf`
  );

  saveBase64Pdf(base64, labelFile);
  console.log('→ Label archiviert:', labelFile);

  return labelFile;
}

async function processOrder(order) {
  if (processing.has(order.id)) {
    console.log(`→ ${order.name} wird bereits verarbeitet`);
    return;
  }

  if (isOrderSkipped(order)) {
    console.log(`⏭️ Bestellung ${order.name} ist in der Skip-Liste und wird übersprungen`);
    return;
  }

  processing.add(order.id);

  try {
    console.log(`\nPrüfe Bestellung: ${order.name}`);
    saveDebugOrder(order);

    writeStatus({
      status: 'OK',
      lastOrder: order.name
    });

    const existing = await checkSendcloud(order);

    if (existing.length > 0) {
      const parcel = existing[0];

      console.log('→ Bereits korrekt in Sendcloud vorhanden');
      console.log('→ Tracking:', parcel.tracking_number || 'keine Trackingnummer');
      console.log('→ Versuche vorhandenes Label zu drucken und Shopify zu erfüllen');

      const labelUrl = parcel.label?.label_printer || parcel.label?.normal_printer;
      const base64 = await downloadLabel(labelUrl);

      archiveLabel(base64, order);

      await printLabel(base64, order.name);
      console.log('→ Label gedruckt');

      await printPackingSlipForOrder(order);
      await saveInvoiceForOrder(order);
      await fulfillShopifyOrder(order, parcel);

      writeStatus({
        status: 'OK',
        lastOrder: order.name,
        lastPrint: timestamp(),
        lastError: null,
        lastErrorFile: null
      });

      console.log(`✅ Fertig: ${order.name}`);
      return;
    }

    const parcel = await createParcel(order);

    console.log('→ Neues Label erstellt');
    console.log('→ Tracking:', parcel.tracking_number);

    const labelUrl = parcel.label?.label_printer || parcel.label?.normal_printer;
    const base64 = await downloadLabel(labelUrl);

    archiveLabel(base64, order);

    await printLabel(base64, order.name);
    console.log('→ Label gedruckt');

    await printPackingSlipForOrder(order);
    await saveInvoiceForOrder(order);
    await fulfillShopifyOrder(order, parcel);

    writeStatus({
      status: 'OK',
      lastOrder: order.name,
      lastPrint: timestamp(),
      lastError: null,
      lastErrorFile: null
    });

    console.log(`✅ Fertig: ${order.name}`);
  } catch (err) {
    const errorMessage = JSON.stringify(err.response?.data || err.message);
    const errorFile = writeErrorReport(order, err);

    await sendErrorEmail(order, err, errorFile);
    showWindowsAlert(order.name, `Fehler bei Bestellung ${order.name}. Bitte Dashboard prüfen.`);

    console.error(`❌ Fehler bei ${order.name}:`);
    console.error(err.response?.data || err.message);

    addOrderToSkip(order, errorMessage);

    writeStatus({
      status: 'FEHLER',
      lastOrder: order.name,
      lastError: errorMessage,
      lastErrorFile: errorFile
    });
  } finally {
    processing.delete(order.id);
  }
}

async function loop() {
  const now = timestamp();
  const next = nextScanTime();

  console.log('\n==============================');
  console.log('🔄 Scan gestartet:', now);
  console.log('⏱️ Intervall:', INTERVAL_MS / 60000, 'Minuten');
  console.log('🕒 Nächster Scan ca.:', next);
  console.log('==============================');

  writeStatus({
    status: 'OK',
    lastScan: now,
    nextScan: next
  });

  try {
    const orders = await getOrders();

    if (orders.length === 0) {
      console.log('✔ System aktiv – keine offenen Bestellungen');

      writeStatus({
        status: 'OK',
        lastError: null,
        lastErrorFile: null
      });
    }

    for (const order of orders) {
      await processOrder(order);
    }
  } catch (err) {
    const errorMessage = JSON.stringify(err.response?.data || err.message);

    console.error('Globaler Fehler:');
    console.error(err.response?.data || err.message);

    writeStatus({
      status: 'FEHLER',
      lastError: errorMessage
    });
  }

  console.log('🕒 Warte bis nächster Scan...\n');

  setTimeout(loop, INTERVAL_MS);
}

loop();