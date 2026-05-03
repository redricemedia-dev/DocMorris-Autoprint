require('dotenv').config();
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY.trim();
const PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY.trim();

async function main() {
  try {
    // 1. Shopify Bestellung holen
    const orderRes = await axios.get(
      `https://${SHOP}/admin/api/2024-01/orders.json`,
      {
        headers: { 'X-Shopify-Access-Token': SHOP_TOKEN },
        params: {
          status: 'open',
          financial_status: 'paid',
          fulfillment_status: 'unfulfilled',
          limit: 5
        }
      }
    );

    const orders = orderRes.data.orders;

    for (const order of orders) {
      console.log("----");
      console.log("Order:", order.name);

      // 2. Sendcloud prüfen
      const scRes = await axios.get(
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

      const parcels = scRes.data.parcels;

      if (parcels.length > 0) {
        console.log("❌ Bereits vorhanden in Sendcloud");
        console.log("Tracking:", parcels[0].tracking_number);
      } else {
        console.log("✅ Noch nicht vorhanden → kann erstellt werden");
      }
    }

  } catch (err) {
    console.error("FEHLER:");
    console.error(err.response?.data || err.message);
  }
}

main();