require('dotenv').config();
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function getOrders() {
    try {
        const response = await axios.get(
            `https://${SHOP}/admin/api/2024-01/orders.json`,
            {
                headers: {
                    'X-Shopify-Access-Token': TOKEN
                },
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
            console.log("----");
            console.log("Order:", order.name);
            console.log("Kunde:", order.shipping_address?.name);
            console.log("Land:", order.shipping_address?.country);
        });

    } catch (err) {
        console.error("FEHLER:");
        console.error(err.response?.data || err.message);
    }
}

getOrders();