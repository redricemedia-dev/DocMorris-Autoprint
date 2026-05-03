require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { chromium } = require('playwright');
const QRCode = require('qrcode');

const DEBUG_ORDER_DIR = process.env.DEBUG_ORDER_DIR || 'C:\\DocMorris-Rechnungen\\debug-orders';
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const SLIP_PRINTER_ID = Number(
  process.env.PRINTNODE_PRINTER_ID_SLIP || process.env.PRINTNODE_PRINTER_ID_LABEL
);

const BRAND_NAME = process.env.BRAND_NAME || 'VitaSanum';
const LOGO_URL = process.env.LOGO_URL || '';
const COMPANY_FOOTER =
  process.env.COMPANY_FOOTER ||
  'VitaSanum GmbH · Rosenheimer Landstraße 27 · 85521 Ottobrunn · Germany';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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
  return await QRCode.toDataURL(order.name || String(order.id || ''), {
    margin: 1,
    width: 220
  });
}

function getPackingSlipTemplate() {
  const templatePath = path.join(__dirname, 'templates', 'packing-slip.html');

  if (!fs.existsSync(templatePath)) {
    throw new Error('packing-slip.html fehlt in C:\\docmorris-auto\\templates');
  }

  return fs.readFileSync(templatePath, 'utf8');
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
      viewport: { width: 1240, height: 1754 }
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

async function printPdf(base64, orderName) {
  await axios.post(
    'https://api.printnode.com/printjobs',
    {
      printerId: SLIP_PRINTER_ID,
      title: `Reprint Lieferschein ${orderName}`,
      contentType: 'pdf_base64',
      content: base64,
      source: 'DocMorris AutoPrint Reprint'
    },
    {
      auth: {
        username: PRINTNODE_API_KEY,
        password: ''
      }
    }
  );
}

async function main() {
  const orderName = process.argv[2];

  if (!orderName) {
    throw new Error('Bitte Bestellnummer übergeben, z. B. node reprint-packing-slip.js 1JNJWH');
  }

  const cleanOrderName = orderName.replace('#', '');
  const debugFile = path.join(DEBUG_ORDER_DIR, `order_${cleanOrderName}.json`);

  if (!fs.existsSync(debugFile)) {
    throw new Error(`Debug-Datei nicht gefunden: ${debugFile}`);
  }

  const order = JSON.parse(fs.readFileSync(debugFile, 'utf8'));
  const html = await renderPackingSlipHtml(order);
  const pdfBuffer = await htmlToPdfBuffer(html);
  const base64 = pdfBuffer.toString('base64');

  await printPdf(base64, order.name || cleanOrderName);

  console.log(`Lieferschein neu gedruckt: ${order.name || cleanOrderName}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});