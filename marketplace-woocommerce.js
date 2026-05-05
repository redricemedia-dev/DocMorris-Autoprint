require('dotenv').config();
const axios = require('axios');

const STORE_URL = process.env.WOOCOMMERCE_STORE_URL;
const CK = process.env.WOOCOMMERCE_CONSUMER_KEY;
const CS = process.env.WOOCOMMERCE_CONSUMER_SECRET;

const SENDCLOUD_PUBLIC_KEY = process.env.SENDCLOUD_PUBLIC_KEY;
const SENDCLOUD_PRIVATE_KEY = process.env.SENDCLOUD_PRIVATE_KEY;

async function getSendcloudParcels(limit = 100) {
  const res = await axios.get('https://panel.sendcloud.sc/api/v2/parcels', {
    auth: {
      username: SENDCLOUD_PUBLIC_KEY,
      password: SENDCLOUD_PRIVATE_KEY
    },
    params: {
      limit,
      ordering: '-created_at'
    }
  });

  return res.data.parcels || [];
}

async function getWooCommerceOrders(limit = 20) {
  const url = STORE_URL + '/wp-json/wc/v3/orders';

  const ordersRes = await axios.get(url, {
    auth: {
      username: CK,
      password: CS
    },
    params: {
      per_page: limit,
      orderby: 'date',
      order: 'desc'
    }
  });

  const parcels = await getSendcloudParcels(100);
  const orders = ordersRes.data || [];

  return orders.map(function(order) {
    const orderNumber = String(order.number || order.id);

    const parcel = parcels.find(function(p) {
      return String(p.order_number || '').indexOf(orderNumber) !== -1;
    });

    return {
      id: order.id,
      orderNumber: orderNumber,
      name: ((order.billing && order.billing.first_name) || '') + ' ' + ((order.billing && order.billing.last_name) || ''),
      city: (order.billing && order.billing.city) || '-',
      country: (order.billing && order.billing.country) || '-',
      status: order.status || '-',
      total: order.total || '-',
      createdAt: order.date_created || '-',
      trackingNumber: parcel ? parcel.tracking_number : '-',
      trackingUrl: parcel ? parcel.tracking_url : '',
      carrier: parcel && parcel.carrier ? parcel.carrier.name : '-'
    };
  });
}

async function fulfillWooOrder(orderId, trackingNumber, trackingUrl) {
  const url = STORE_URL + '/wp-json/wc/v3/orders/' + orderId;

  return axios.put(url, {
    status: 'completed',
    meta_data: [
      {
        key: '_tracking_number',
        value: trackingNumber
      },
      {
        key: '_tracking_url',
        value: trackingUrl
      }
    ]
  }, {
    auth: {
      username: CK,
      password: CS
    }
  });
}

module.exports = {
  getWooCommerceOrders,
  fulfillWooOrder
};