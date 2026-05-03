require('dotenv').config();
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY.trim();

const SHIPPING_METHOD = Number(process.env.SENDCLOUD_SHIPPING_METHOD_ID);
const DEFAULT_WEIGHT = process.env.SENDCLOUD_DEFAULT_WEIGHT;

const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTER_ID = Number(process.env.PRINTNODE_PRINTER_ID_LABEL);

async function getOrder() {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2024-01/orders.json`,
    {
      headers: { 'X-Shopify-Access-Token': SHOP_TOKEN },
      params: {
        status: 'open',
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        limit: 1
      }
    }
  );
  return res.data.orders[0];
}

async function checkSendcloud(order) {
  const res = await axios.get(
    'https://panel.sendcloud.sc/api/v2/parcels',
    {
      auth: { username: PUBLIC_KEY, password: PRIVATE_KEY },
      params: { external_order_id: order.admin_graphql_api_id }
    }
  );
  return res.data.parcels;
}

async function createParcel(order) {
  const a = order.shipping_address;

  const res = await axios.post(
    'https://panel.sendcloud.sc/api/v2/parcels',
    {
      parcel: {
        name: a.name,
        address: a.address1,
        city: a.city,
        postal_code: a.zip,
        country: a.country_code,
        email: order.email,
        weight: DEFAULT_WEIGHT,
        order_number: order.name,
        external_order_id: order.admin_graphql_api_id,
        shipping_method: SHIPPING_METHOD,
        request_label: true
      }
    },
    {
      auth: { username: PUBLIC_KEY, password: PRIVATE_KEY }
    }
  );

  return res.data.parcel;
}

async function downloadLabel(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data).toString('base64');
}

async function printLabel(base64) {
  await axios.post(
    'https://api.printnode.com/printjobs',
    {
      printerId: PRINTER_ID,
      title: 'DHL Label',
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

async function main() {
  try {
    const order = await getOrder();

    if (!order) return console.log("Keine Bestellung");

    console.log("Order:", order.name);

    const existing = await checkSendcloud(order);

    if (existing.length > 0) {
      console.log("Schon vorhanden → skip");
      return;
    }

    const parcel = await createParcel(order);

    console.log("Label erstellt:", parcel.tracking_number);

    const labelUrl = parcel.label.label_printer;

    const base64 = await downloadLabel(labelUrl);

    await printLabel(base64);

    console.log("✅ GEDRUCKT");

  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

main();