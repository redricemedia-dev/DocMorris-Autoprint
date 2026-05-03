require('dotenv').config();
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function createLabel() {
    try {
        const ordersRes = await axios.get(
            `https://${SHOP}/admin/api/2024-01/orders.json`,
            {
                headers: { 'X-Shopify-Access-Token': TOKEN },
                params: {
                    status: 'open',
                    financial_status: 'paid',
                    fulfillment_status: 'unfulfilled',
                    limit: 1
                }
            }
        );

        const order = ordersRes.data.orders[0];

        if (!order) {
            console.log("Keine Bestellung gefunden");
            return;
        }

        console.log("Order:", order.name);

        // Fulfillment erstellen (Shopify generiert Label)
        const fulfillment = await axios.post(
            `https://${SHOP}/admin/api/2024-01/fulfillments.json`,
            {
                fulfillment: {
                    location_id: order.location_id,
                    notify_customer: false
                }
            },
            {
                headers: { 'X-Shopify-Access-Token': TOKEN }
            }
        );

        console.log("Fulfillment erstellt:", fulfillment.data);

    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

createLabel();