require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MIRAKL_BASE_URL = process.env.MIRAKL_BASE_URL;
const MIRAKL_API_KEY = process.env.MIRAKL_API_KEY;

const PRINTED_FILE = 'C:\\docmorris-auto\\printed-mirakl.json';
const STATE_FILE = 'C:\\docmorris-auto\\mirakl-processing.json';

const SHOP = process.env.SHOPIFY_MIRAKL_SHOP;
const CLIENT_ID = process.env.SHOPIFY_MIRAKL_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_MIRAKL_CLIENT_SECRET;

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

function mergeTags(existingTags, tagToAdd) {
  const tags = String(existingTags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!tags.includes(tagToAdd)) tags.push(tagToAdd);
  return tags.join(', ');
}

async function getMiraklOrderStatus(miraklOrderId) {
  const res = await axios.get(`${MIRAKL_BASE_URL}/api/orders`, {
    headers: { Authorization: MIRAKL_API_KEY },
    params: { order_ids: miraklOrderId }
  });

  const order = (res.data.orders || [])[0];

  if (!order) {
    return null;
  }

  return String(order.status || order.order_state || '').toUpperCase();
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

async function getFulfillmentOrders(token, orderId) {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2026-01/orders/${orderId}/fulfillment_orders.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  return res.data.fulfillment_orders || [];
}

async function fulfillOrder(token, order, miraklOrderId) {
  const fulfillmentOrders = await getFulfillmentOrders(token, order.id);

  const openFulfillmentOrders = fulfillmentOrders.filter(fo =>
    ['open', 'in_progress', 'scheduled'].includes(String(fo.status || '').toLowerCase())
  );

  if (openFulfillmentOrders.length === 0) {
    console.log(`SHOPIFY ${order.name} / ${miraklOrderId}: keine offenen Fulfillment Orders`);
    return { ok: true, alreadyFulfilled: true };
  }

  for (const fo of openFulfillmentOrders) {
    await axios.post(
      `https://${SHOP}/admin/api/2026-01/fulfillments.json`,
      {
        fulfillment: {
          message: `Repair Mirakl AutoPrint ${miraklOrderId}`,
          notify_customer: false,
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

  await axios.put(
    `https://${SHOP}/admin/api/2026-01/orders/${order.id}.json`,
    {
      order: {
        id: order.id,
        tags: mergeTags(order.tags, 'AUTOPRINT_MIRAKL_DONE')
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    }
  );

  return { ok: true, alreadyFulfilled: false };
}

async function main() {
  const printed = readJson(PRINTED_FILE, []);
  const printedSet = new Set(Array.isArray(printed) ? printed : []);
  const state = readJson(STATE_FILE, {});

  console.log('Printed Mirakl IDs:', printedSet.size);

  const token = await getShopifyToken();
  const orders = await getUnfulfilledOrders(250);

  console.log('Shopify unfulfilled orders:', orders.length);

  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  for (const order of orders) {
    const miraklOrderId = extractMiraklOrderId(order);

    if (!miraklOrderId) {
      skipped++;
      continue;
    }

    if (!printedSet.has(miraklOrderId)) {
      console.log(`SKIP ${order.name} / ${miraklOrderId}: nicht in printed-mirakl.json`);
      skipped++;
      continue;
    }

    try {
      const miraklStatus = await getMiraklOrderStatus(miraklOrderId);

      if (miraklStatus !== 'SHIPPED') {
        console.log(`SKIP ${order.name} / ${miraklOrderId}: Mirakl Status ist ${miraklStatus || 'unbekannt'}, nicht SHIPPED`);
        skipped++;
        continue;
      }

      console.log(`REPAIR ${order.name} / ${miraklOrderId}: Shopify Fulfillment wird nachgeholt`);

      const result = await fulfillOrder(token, order, miraklOrderId);

      state[miraklOrderId] = {
        ...(state[miraklOrderId] || {}),
        status: 'done',
        orderName: order.name,
        miraklShipped: true,
        shopifyFulfilled: true,
        printed: true,
        repairApplied: true,
        alreadyFulfilled: Boolean(result.alreadyFulfilled),
        repairedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      writeJson(STATE_FILE, state);

      console.log(`DONE ${order.name} / ${miraklOrderId}`);
      repaired++;
    } catch (err) {
      const details = err.response?.data || err.message || err;
      console.log(`ERROR ${order.name} / ${miraklOrderId}: ${JSON.stringify(details)}`);
      failed++;
    }
  }

  console.log('==============================');
  console.log('Repair fertig');
  console.log('Repaired:', repaired);
  console.log('Skipped:', skipped);
  console.log('Failed:', failed);
  console.log('==============================');
}

main().catch(err => {
  console.error(err.response?.data || err.message);
});