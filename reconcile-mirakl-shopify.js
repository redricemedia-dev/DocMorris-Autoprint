require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PRINTED_FILE = 'C:\\docmorris-auto\\printed-mirakl.json';
const STATE_FILE = 'C:\\docmorris-auto\\mirakl-processing.json';
const REPORT_FILE = 'C:\\docmorris-auto\\reconcile-mirakl-report.json';

const SHOP = process.env.SHOPIFY_MIRAKL_SHOP;
const CLIENT_ID = process.env.SHOPIFY_MIRAKL_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_MIRAKL_CLIENT_SECRET;

const MIRAKL_BASE_URL = process.env.MIRAKL_BASE_URL;
const MIRAKL_API_KEY = process.env.MIRAKL_API_KEY;

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

function extractMiraklOrderId(order) {
  const text = JSON.stringify(order || {});
  const match = text.match(/\b[A-Z]{2,3}-\d+-\d+-[A-Z]\b/);
  return match ? match[0] : null;
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

async function getUnfulfilledOrders(limit = 250) {
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

async function getMiraklOrder(miraklOrderId) {
  const res = await axios.get(`${MIRAKL_BASE_URL}/api/orders`, {
    headers: { Authorization: MIRAKL_API_KEY },
    params: { order_ids: miraklOrderId }
  });

  return (res.data.orders || [])[0] || null;
}

function miraklStatus(order) {
  if (!order) return null;
  return String(order.status || order.order_state || '').toUpperCase();
}

async function main() {
  const printed = readJson(PRINTED_FILE, []);
  const printedSet = new Set(Array.isArray(printed) ? printed : []);
  const state = readJson(STATE_FILE, {});

  const orders = await getUnfulfilledOrders(250);

  const report = {
    createdAt: new Date().toISOString(),
    totals: {
      shopifyUnfulfilled: orders.length,
      printedIds: printedSet.size,
      stateEntries: Object.keys(state || {}).length,
      needsRepair: 0,
      foreignOpen: 0,
      notPrinted: 0,
      notMiraklShipped: 0,
      unknown: 0
    },
    needsRepair: [],
    foreignOpen: [],
    notPrinted: [],
    notMiraklShipped: [],
    unknown: []
  };

  console.log('==============================');
  console.log('Mirakl / Shopify Reconcile');
  console.log('Shopify unfulfilled:', orders.length);
  console.log('Printed IDs:', printedSet.size);
  console.log('State entries:', Object.keys(state || {}).length);
  console.log('==============================');

  for (const order of orders) {
    const miraklOrderId = extractMiraklOrderId(order);
    const countryCode = String(order.shipping_address?.country_code || '').toUpperCase();
    const entry = state[miraklOrderId] || null;

    if (!miraklOrderId) {
      report.unknown.push({
        shopifyOrder: order.name,
        shopifyId: order.id,
        reason: 'Keine Mirakl-ID gefunden'
      });
      report.totals.unknown++;
      continue;
    }

    if (countryCode && countryCode !== 'DE') {
      report.foreignOpen.push({
        shopifyOrder: order.name,
        shopifyId: order.id,
        miraklOrderId,
        countryCode,
        state: entry?.status || null
      });
      report.totals.foreignOpen++;
      continue;
    }

    const wasPrinted = printedSet.has(miraklOrderId);

    if (!wasPrinted) {
      report.notPrinted.push({
        shopifyOrder: order.name,
        shopifyId: order.id,
        miraklOrderId,
        countryCode,
        state: entry?.status || null,
        reason: 'Nicht in printed-mirakl.json'
      });
      report.totals.notPrinted++;
      continue;
    }

    let remoteOrder = null;
    let remoteStatus = null;

    try {
      remoteOrder = await getMiraklOrder(miraklOrderId);
      remoteStatus = miraklStatus(remoteOrder);
    } catch (err) {
      report.unknown.push({
        shopifyOrder: order.name,
        shopifyId: order.id,
        miraklOrderId,
        reason: 'Mirakl API Fehler',
        error: err.response?.data || err.message || err
      });
      report.totals.unknown++;
      continue;
    }

    if (remoteStatus !== 'SHIPPED') {
      report.notMiraklShipped.push({
        shopifyOrder: order.name,
        shopifyId: order.id,
        miraklOrderId,
        countryCode,
        miraklStatus: remoteStatus || 'unbekannt',
        state: entry?.status || null
      });
      report.totals.notMiraklShipped++;
      continue;
    }

    report.needsRepair.push({
      shopifyOrder: order.name,
      shopifyId: order.id,
      miraklOrderId,
      countryCode,
      miraklStatus: remoteStatus,
      printed: true,
      state: entry?.status || null,
      reason: 'Mirakl SHIPPED + printed, aber Shopify noch unfulfilled'
    });
    report.totals.needsRepair++;
  }

  writeJson(REPORT_FILE, report);

  console.log('Needs repair:', report.totals.needsRepair);
  console.log('Foreign open:', report.totals.foreignOpen);
  console.log('Not printed:', report.totals.notPrinted);
  console.log('Not Mirakl shipped:', report.totals.notMiraklShipped);
  console.log('Unknown:', report.totals.unknown);
  console.log('Report:', REPORT_FILE);
  console.log('==============================');
}

main().catch(err => {
  console.error(err.response?.data || err.message || err);
});
