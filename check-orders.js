require('dotenv').config();
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function getOrders() {
  const response = await axios.get(
    `https://${SHOP}/admin/api/2024-01/orders.json`,
    {
      headers: { 'X-Shopify-Access-Token': TOKEN },
      params: {
        status: 'open',
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        limit: 10
      }
    }
  );

  const orders = response.data.orders;

  console.log("Gefundene Bestellungen:", orders.length);

  orders.forEach(order => {
    const a = order.shipping_address;

    console.log("----");
    console.log("Order:", order.name);
    console.log("Name:", a?.name);
    console.log("Adresse 1:", a?.address1);
    console.log("Adresse 2:", a?.address2);
    console.log("PLZ:", a?.zip);
    console.log("Stadt:", a?.city);
    console.log("Land:", a?.country_code);
    console.log("Gewicht Gramm:", order.total_weight);
    console.log("Artikel:", order.line_items.map(i => `${i.quantity}x ${i.title}`).join(", "));
  });
}

getOrders().catch(err => {
  console.error("FEHLER:");
  console.error(err.response?.data || err.message);
});