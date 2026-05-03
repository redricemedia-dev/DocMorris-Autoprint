require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEBUG_ORDER_DIR = process.env.DEBUG_ORDER_DIR || 'C:\\DocMorris-Rechnungen\\debug-orders';
const INVOICE_DIR = process.env.INVOICE_DIR || 'C:\\DocMorris-Rechnungen';

const BRAND_NAME = process.env.BRAND_NAME || 'VitaSanum';
const LOGO_URL = process.env.LOGO_URL || '';
const COMPANY_FOOTER =
  process.env.COMPANY_FOOTER ||
  'VitaSanum GmbH · Rosenheimer Landstraße 27 · 85521 Ottobrunn · Germany';

const VAT_ID = process.env.VAT_ID || 'DE360991334';
const DEFAULT_VAT_RATE = Number(process.env.DEFAULT_VAT_RATE || 7);

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
    'shampoo', 'conditioner', 'leave in', 'leave-in',
    'balsam', 'lippen', 'lip', 'augen', 'eye',
    'creme', 'cream', 'serum', 'gel', 'lotion',
    'maske', 'mask'
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
    'kapseln', 'kapsel', 'caps', 'capsules',
    'tabletten', 'tablets', 'pulver', 'powder',
    'mg', 'µg', 'mcg', 'vitamin', 'mineral',
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

  const rows = Object.values(totalsByRate).sort((a, b) => a.rate - b.rate);

  return {
    rows,
    totalNet: rows.reduce((sum, row) => sum + row.net, 0),
    totalVat: rows.reduce((sum, row) => sum + row.vat, 0),
    totalGross: rows.reduce((sum, row) => sum + row.gross, 0)
  };
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

function getMarketplaceOrderId(order) {
  const attr = (order.note_attributes || []).find(a =>
    String(a.name || '').toLowerCase() === 'marketplace order id'
  );
  return attr?.value || order.note || '-';
}

function getInvoiceTemplate() {
  const templatePath = path.join(__dirname, 'templates', 'invoice.html');

  if (!fs.existsSync(templatePath)) {
    throw new Error('invoice.html fehlt in C:\\docmorris-auto\\templates');
  }

  return fs.readFileSync(templatePath, 'utf8');
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
      viewport: { width: 1240, height: 1754 }
    });

    await page.setContent(html, { waitUntil: 'networkidle' });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const orderName = process.argv[2];

  if (!orderName) {
    throw new Error('Bitte Bestellnummer übergeben, z. B. node reprint-invoice.js 1JNJWH');
  }

  const cleanOrderName = orderName.replace('#', '');
  const debugFile = path.join(DEBUG_ORDER_DIR, `order_${cleanOrderName}.json`);

  if (!fs.existsSync(debugFile)) {
    throw new Error(`Debug-Datei nicht gefunden: ${debugFile}`);
  }

  const order = JSON.parse(fs.readFileSync(debugFile, 'utf8'));

  if (!fs.existsSync(INVOICE_DIR)) {
    fs.mkdirSync(INVOICE_DIR, { recursive: true });
  }

  const orderNumber = sanitizeFilename(order.name || cleanOrderName);
  const customerName = sanitizeFilename(getCustomerName(order));
  const filename = `Rechnung_DocMorris_${orderNumber}_${customerName}.pdf`;
  const filePath = path.join(INVOICE_DIR, filename);

  const html = renderInvoiceHtml(order);
  const pdfBuffer = await htmlToPdfBuffer(html);

  fs.writeFileSync(filePath, pdfBuffer);

  console.log(`Rechnung neu erzeugt: ${filePath}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});