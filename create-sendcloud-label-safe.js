require('dotenv').config();
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY.trim();

const SHIPPING_METHOD = Number(process.env.SENDCLOUD_SHIPPING_METHOD_ID);
const DEFAULT_WEIGHT = process.env.SENDCLOUD_DEFAULT_WEIGHT || '0.5';

async function getOpenShopifyOrder() {
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

async function findExistingSendcloudParcel(order) {
  const res = await axios.get(
    'https://panel.sendcloud.sc/api/v2/parcels',
    {
      auth: {
        username: PUBLIC_KEY,
        password: PRIVATE_KEY
      },
      params: {
        external_order_id: order.admin_graphql_api_id
      }
    }
  );

  return res.data.parcels || [];
}

async function createSendcloudParcel(order) {
  const a = order.shipping_address;

  if (!a) {
    throw new Error('Keine Versandadresse vorhanden.');
  }

  const payload = {
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
  };

  const res = await axios.post(
    'https://panel.sendcloud.sc/api/v2/parcels',
    payload,
    {
      auth: {
        username: PUBLIC_KEY,
        password: PRIVATE_KEY
      }
    }
  );

  return res.data.parcel;
}

async function main() {
  try {
    const order = await getOpenShopifyOrder();

    if (!order) {
      console.log('Keine offene bezahlte unfulfilled Bestellung gefunden.');
      return;
    }

    console.log('Shopify Order:', order.name);
    console.log('Shopify GraphQL ID:', order.admin_graphql_api_id);

    const existing = await findExistingSendcloudParcel(order);

    if (existing.length > 0) {
      console.log('Übersprungen: Parcel existiert bereits in Sendcloud.');
      console.log('Sendcloud Parcel ID:', existing[0].id);
      console.log('Tracking:', existing[0].tracking_number);
      return;
    }

    const parcel = await createSendcloudParcel(order);

    console.log('Label erstellt.');
    console.log('Sendcloud Parcel ID:', parcel.id);
    console.log('Tracking:', parcel.tracking_number);
    console.log('Label:', parcel.label?.label_printer || parcel.label?.normal_printer || parcel.label);
  } catch (err) {
    console.error('FEHLER:');
    console.error(err.response?.data || err.message);
  }
}

main();