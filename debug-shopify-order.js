require('dotenv').config({ path: 'C:\\docmorris-auto\\.env' });
const axios = require('axios');

const SHOP = process.env.SHOPIFY_MIRAKL_SHOP;
const CLIENT_ID = process.env.SHOPIFY_MIRAKL_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_MIRAKL_CLIENT_SECRET;

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

async function main() {
  const token = await getToken();
  const orderName = process.argv[2];

  if (!orderName) {
    throw new Error('Bitte Ordername angeben, z.B. BE-238344442-1-A');
  }

  const res = await axios.get(`https://${SHOP}/admin/api/2026-01/orders.json`, {
    headers: { 'X-Shopify-Access-Token': token },
    params: {
      status: 'any',
      name: orderName
    }
  });

  const order = (res.data.orders || [])[0];

  if (!order) {
    console.log('Keine Shopify Order gefunden:', orderName);
    return;
  }

  console.log(JSON.stringify({
    id: order.id,
    name: order.name,
    order_number: order.order_number,
    tags: order.tags,
    source_name: order.source_name,
    app_id: order.app_id,
    referring_site: order.referring_site,
    landing_site: order.landing_site,
    note: order.note,
    note_attributes: order.note_attributes,
    customer: order.customer,
    shipping_address: order.shipping_address,
    fulfillments: order.fulfillments,
    line_items: order.line_items?.map(i => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      vendor: i.vendor,
      properties: i.properties
    }))
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify(err.response?.data || err.message || err, null, 2));
});