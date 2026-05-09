require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });

const axios = require('axios');

const SHOP = process.env.SHOPIFY_MIRAKL_SHOP;
const CLIENT_ID = process.env.SHOPIFY_MIRAKL_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_MIRAKL_CLIENT_SECRET;

const ORDER_NAME = 'BE-238344442-1-A';
const TRACKING_NUMBER = '1ZHR06876803887895';
const TRACKING_URL = `https://www.ups.com/track?tracknum=${TRACKING_NUMBER}`;

async function getToken() {
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

function mergeTags(existingTags, tagToAdd) {
  const tags = String(existingTags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!tags.includes(tagToAdd)) tags.push(tagToAdd);
  return tags.join(', ');
}

async function main() {
  const token = await getToken();

  const orderRes = await axios.get(`https://${SHOP}/admin/api/2026-01/orders.json`, {
    headers: { 'X-Shopify-Access-Token': token },
    params: {
      status: 'any',
      name: ORDER_NAME
    }
  });

  const order = (orderRes.data.orders || [])[0];

  if (!order) {
    throw new Error(`Shopify Order nicht gefunden: ${ORDER_NAME}`);
  }

  console.log('Shopify Order gefunden:', order.name, order.id);

  const foRes = await axios.get(
    `https://${SHOP}/admin/api/2026-01/orders/${order.id}/fulfillment_orders.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  const fulfillmentOrders = foRes.data.fulfillment_orders || [];
  const openFulfillmentOrders = fulfillmentOrders.filter(fo =>
    ['open', 'in_progress', 'scheduled'].includes(String(fo.status || '').toLowerCase())
  );

  console.log('Offene Fulfillment Orders:', openFulfillmentOrders.length);

  if (openFulfillmentOrders.length === 0) {
    console.log('Keine offenen Fulfillment Orders. Vermutlich bereits fulfilled.');
    return;
  }

  for (const fo of openFulfillmentOrders) {
    await axios.post(
      `https://${SHOP}/admin/api/2026-01/fulfillments.json`,
      {
        fulfillment: {
          message: `UPS Synchron.io Test ${ORDER_NAME}`,
          notify_customer: false,
          tracking_info: {
            company: 'UPS',
            number: TRACKING_NUMBER,
            url: TRACKING_URL
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

  await axios.put(
    `https://${SHOP}/admin/api/2026-01/orders/${order.id}.json`,
    {
      order: {
        id: order.id,
        tags: mergeTags(order.tags, 'AUTOPRINT_UPS_TEST_FULFILLED')
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log('DONE: Shopify fulfilled + tagged');
}

main().catch(err => {
  console.error(JSON.stringify(err.response?.data || err.message || err, null, 2));
});